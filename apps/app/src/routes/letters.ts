import { Hono } from "hono";
import { type DB, clients, documents, letters, orgs, reports } from "@da/db";
import {
  AppError,
  type LetterDetail,
  type LetterStatus,
  LETTER_STATUS,
  disputeRoundCreate,
  letterReject,
  letterResponse,
  letterSent,
  letterUpdate,
  parseDay,
  DAY,
} from "@da/shared";
import { type AppEnv, type Ctx, audit, staff } from "../lib/context";
import { BUREAU_NAMES, draftContext, loadLetter, renderDraft } from "../lib/letters";
import { sanitizeHtml } from "../lib/sanitize";
import { link, metric, notify } from "../lib/services";
import { body, requirePerm } from "../middleware";
import { assertLockAvailable, loadClient } from "./clients";

async function letterDetail(db: DB, orgId: string, id: string): Promise<LetterDetail> {
  const l = await loadLetter(db, orgId, id);
  const [summary, liRows, attIds] = await Promise.all([letters.letterSummary(db, orgId, id), letters.letterItemRows(db, id), letters.attachmentIds(db, id)]);
  const items = await reports.itemDtos(db, orgId, await reports.itemsByIds(db, orgId, liRows.map((r) => r.reportItemId)));
  const outcomes = new Map(liRows.map((r) => [r.reportItemId, r.outcome]));
  const reasons = new Map(liRows.map((r) => [r.reportItemId, r.reason]));
  const [atts, names, client] = await Promise.all([
    documents.documentsByIds(db, orgId, attIds),
    orgs.userNames(db, orgId, [l.createdBy, l.approvedBy]),
    clients.getClientRow(db, orgId, l.clientId),
  ]);
  if (!summary) throw new AppError("not_found", 404, "Letter not found");
  return {
    ...summary,
    bodyHtml: l.bodyHtml,
    templateId: l.templateId,
    templateVersion: l.templateVersion,
    approvedById: l.approvedBy,
    approvedAt: l.approvedAt,
    rejectionReason: l.rejectionReason,
    pdfDocumentId: l.pdfDocumentId,
    trackingNumber: l.trackingNumber,
    items: items.map((i) => ({ ...i, outcome: outcomes.get(i.id) ?? null, disputeReason: reasons.get(i.id) ?? null })),
    attachments: atts.map(documents.toDocumentDto),
    createdByName: names.get(l.createdBy) ?? null,
    approvedByName: l.approvedBy ? (names.get(l.approvedBy) ?? null) : null,
    clientAuthStatus: client?.authStatus ?? "none",
  };
}

const transitionOr409 = async (ok: Promise<boolean>, msg = "This letter changed. Refresh and try again.") => {
  if (!(await ok)) throw new AppError("invalid_transition", 409, msg);
};

/** Mounted under /clients/:id */
export const clientLetterRoutes = new Hono<AppEnv>()
  .get("/letters", requirePerm("letter:read"), async (c) => {
    const row = await loadClient(c, c.req.param("id") ?? "");
    return c.json(await letters.listLetters(c.get("db"), row.orgId, { clientId: row.id }));
  })

  // R14.1, R14.3: one letter per target, merge fields resolved (DOB deferred), status draft.
  .post("/dispute-rounds", requirePerm("letter:write"), async (c) => {
    const input = await body(c, disputeRoundCreate);
    const p = staff(c);
    const db = c.get("db");
    const client = await loadClient(c, c.req.param("id") ?? "");
    await assertLockAvailable(c, client.id);
    const tpl = await letters.getTemplate(db, p.orgId, input.templateId);
    if (!tpl || !tpl.active) throw new AppError("template_invalid", 422, "Choose an active template");
    const items = await reports.itemsByIds(db, p.orgId, input.itemIds);
    if (items.length !== new Set(input.itemIds).size || items.some((i) => i.clientId !== client.id)) throw new AppError("invalid_items", 400, "Some items do not belong to this client");
    const flags = await reports.flagsForItems(db, p.orgId, items.map((i) => i.id));
    const reasonOf = (id: string) => flags.filter((f) => f.reportItemId === id).map((f) => f.reason).join("; ") || "This information is inaccurate";
    const groups = new Map<string, typeof items>();
    for (const i of items) {
      const key = input.targetKind === "bureau" ? i.bureau : (i.furnisher ?? "Unknown furnisher");
      groups.set(key, [...(groups.get(key) ?? []), i]);
    }
    const org = await orgs.getOrg(db, p.orgId);
    if (!org) throw new AppError("not_found", 404, "Organization not found");
    const round = await letters.nextRoundNumber(db, p.orgId, client.id);
    const drafts = [...groups].map(([key, group]) => {
      const targetName = input.targetKind === "bureau" ? (BUREAU_NAMES[key] ?? key) : key;
      const withReasons = group.map((i) => ({ ...i, reason: reasonOf(i.id) }));
      return {
        targetKind: input.targetKind,
        targetName,
        templateId: tpl.id,
        templateVersion: tpl.version,
        bodyHtml: renderDraft(tpl.bodyHtml, draftContext(client, org.settings, targetName, round, withReasons)),
        items: withReasons.map((i) => ({ reportItemId: i.id, reason: i.reason })),
      };
    });
    const created = await letters.createRound(db, p.orgId, client.id, p.id, drafts);
    audit(c, { action: "dispute_round.created", entityType: "dispute_round", entityId: created.roundId, diff: { clientId: client.id, letters: created.letterIds.length, items: items.length } });
    return c.json(created, 201);
  });

export const roundRoutes = new Hono<AppEnv>()
  /** R16.7: items still unresolved once every letter in a round is closed. */
  .get("/:id/follow-up", requirePerm("letter:read"), async (c) => {
    const db = c.get("db");
    const p = staff(c);
    const round = await letters.getRound(db, p.orgId, c.req.param("id"));
    if (!round) throw new AppError("not_found", 404, "Round not found");
    const ls = await letters.lettersInRound(db, p.orgId, round.id);
    const allClosed = ls.every((l) => l.status === "closed");
    const rows = (await Promise.all(ls.map((l) => letters.letterItemRows(db, l.id)))).flat();
    const unresolved = [...new Set(rows.filter((r) => r.outcome !== "deleted" && r.outcome !== "updated").map((r) => r.reportItemId))];
    const items = await reports.itemDtos(db, p.orgId, await reports.itemsByIds(db, p.orgId, unresolved));
    return c.json({ allClosed, clientId: round.clientId, unresolvedItemIds: unresolved, items, letterIds: ls.map((l) => l.id) });
  });

export const letterRoutes = new Hono<AppEnv>()
  .get("/", requirePerm("letter:read"), async (c) => {
    const statuses = (c.req.query("status") ?? "").split(",").filter((s): s is LetterStatus => (LETTER_STATUS as readonly string[]).includes(s));
    return c.json(await letters.listLetters(c.get("db"), staff(c).orgId, { status: statuses }));
  })
  .get("/:id", requirePerm("letter:read"), async (c) => c.json(await letterDetail(c.get("db"), staff(c).orgId, c.req.param("id"))))

  // R14.4: drafts only, sanitized, before/after audited, edit lease enforced server-side.
  .patch("/:id", requirePerm("letter:write"), async (c) => {
    const input = await body(c, letterUpdate);
    const p = staff(c);
    const db = c.get("db");
    const l = await loadLetter(db, p.orgId, c.req.param("id"));
    if (l.status !== "draft") throw new AppError("letter_locked", 409, "Only draft letters can be edited");
    await assertLockAvailable(c, l.clientId);
    if (input.bodyHtml !== undefined) {
      const clean = await sanitizeHtml(input.bodyHtml);
      await letters.updateLetterBody(db, p.orgId, l.id, clean);
      audit(c, { action: "letter.edited", entityType: "letter", entityId: l.id, diff: { before: { body: l.bodyHtml }, after: { body: clean } } });
    }
    if (input.attachmentDocumentIds) {
      const docs = await documents.documentsByIds(db, p.orgId, input.attachmentDocumentIds);
      if (docs.length !== input.attachmentDocumentIds.length || docs.some((d) => d.clientId !== l.clientId || d.status !== "available"))
        throw new AppError("invalid_attachments", 400, "Attachments must be available documents for this client");
      await letters.setAttachments(db, l.id, input.attachmentDocumentIds);
      audit(c, { action: "letter.attachments_set", entityType: "letter", entityId: l.id, diff: { documentIds: input.attachmentDocumentIds } });
    }
    return c.json(await letterDetail(db, p.orgId, l.id));
  })

  // R14.5
  .post("/:id/submit", requirePerm("letter:write"), async (c) => {
    const p = staff(c);
    const db = c.get("db");
    const l = await loadLetter(db, p.orgId, c.req.param("id"));
    await transitionOr409(letters.transitionLetter(db, p.orgId, l.id, "draft", { status: "pending_approval", rejectionReason: null }), "Only draft letters can be submitted");
    audit(c, { action: "letter.submitted", entityType: "letter", entityId: l.id });
    const approvers = (await orgs.approvers(db, p.orgId)).filter((a) => a.id !== p.id);
    await notify(c.env, approvers.map((a) => ({ id: `pending:${l.id}:${a.id}:${Date.now()}`, orgId: p.orgId, recipient: { kind: "staff" as const, id: a.id }, event: "letter_pending_approval" as const, vars: { link: link(c.env, `/admin/letters/${l.id}`) }, channels: ["in_app" as const] })));
    return c.json({ status: "pending_approval" });
  })

  // R14.6, R5.5, R11.4
  .post("/:id/approve", requirePerm("letter:approve"), async (c) => {
    const p = staff(c);
    const db = c.get("db");
    const l = await loadLetter(db, p.orgId, c.req.param("id"));
    const org = await orgs.getOrg(db, p.orgId);
    if (l.createdBy === p.id && !org?.settings.selfApproval) throw new AppError("self_approval", 403, "You cannot approve a letter you wrote");
    const client = await clients.getClientRow(db, p.orgId, l.clientId);
    if (client?.authStatus !== "signed") throw new AppError("authorization_required", 409, "The client's authorization must be signed before approval");
    const now = Date.now();
    await transitionOr409(letters.transitionLetter(db, p.orgId, l.id, "pending_approval", { status: "approved", lockedAt: now, approvedBy: p.id, approvedAt: now }), "Only letters pending approval can be approved");
    const inst = await c.env.WF_LETTER.create({ id: `letter-${l.id}-${now}`, params: { orgId: p.orgId, letterId: l.id } });
    await letters.setLetterFields(db, l.id, { pipelineWorkflowId: inst.id });
    audit(c, { action: "letter.approved", entityType: "letter", entityId: l.id, diff: { workflowId: inst.id } });
    metric(c.env, "letter_approved", p.orgId);
    return c.json({ status: "approved", workflowId: inst.id });
  })

  // R14.7
  .post("/:id/reject", requirePerm("letter:approve"), async (c) => {
    const { reason } = await body(c, letterReject);
    const p = staff(c);
    const db = c.get("db");
    const l = await loadLetter(db, p.orgId, c.req.param("id"));
    await transitionOr409(letters.transitionLetter(db, p.orgId, l.id, "pending_approval", { status: "draft", rejectionReason: reason }), "Only letters pending approval can be rejected");
    audit(c, { action: "letter.rejected", entityType: "letter", entityId: l.id, diff: { reason } });
    await notify(c.env, { id: `rejected:${l.id}:${Date.now()}`, orgId: p.orgId, recipient: { kind: "staff", id: l.createdBy }, event: "letter_rejected", vars: { link: link(c.env, `/admin/letters/${l.id}`) } });
    return c.json({ status: "draft" });
  })

  // R15.3
  .post("/:id/retry-render", requirePerm("letter:write"), async (c) => {
    const p = staff(c);
    const db = c.get("db");
    const l = await loadLetter(db, p.orgId, c.req.param("id"));
    const now = Date.now();
    await transitionOr409(letters.transitionLetter(db, p.orgId, l.id, "render_failed", { status: "approved" }), "Only failed renders can be retried");
    const inst = await c.env.WF_LETTER.create({ id: `letter-${l.id}-${now}`, params: { orgId: p.orgId, letterId: l.id } });
    await letters.setLetterFields(db, l.id, { pipelineWorkflowId: inst.id });
    audit(c, { action: "letter.render_retried", entityType: "letter", entityId: l.id, diff: { workflowId: inst.id } });
    return c.json({ status: "approved", workflowId: inst.id });
  })

  // R16.1
  .post("/:id/sent", requirePerm("letter:write"), async (c) => {
    const input = await body(c, letterSent);
    const p = staff(c);
    const db = c.get("db");
    const l = await loadLetter(db, p.orgId, c.req.param("id"));
    const org = await orgs.getOrg(db, p.orgId);
    const sentAt = parseDay(input.sentAt);
    if (sentAt > Date.now() + DAY) throw new AppError("invalid_date", 400, "The sent date cannot be in the future");
    const dueAt = sentAt + (org?.settings.deadlineDays ?? 30) * DAY;
    await transitionOr409(
      letters.transitionLetter(db, p.orgId, l.id, "ready_to_mail", { status: "sent", sentAt, trackingNumber: input.trackingNumber ?? null, responseDueAt: dueAt }),
      "Only letters that are ready to mail can be marked sent",
    );
    const inst = await c.env.WF_DEADLINE.create({ id: `deadline-${l.id}`, params: { orgId: p.orgId, letterId: l.id, dueAt } });
    await letters.setLetterFields(db, l.id, { deadlineWorkflowId: inst.id });
    audit(c, { action: "letter.sent", entityType: "letter", entityId: l.id, diff: { sentAt: input.sentAt, trackingNumber: input.trackingNumber, responseDueAt: dueAt } });
    return c.json({ status: "sent", responseDueAt: dueAt });
  })

  // R16.5: log the bureau's answer, stop the deadline workflow, record outcomes on the items.
  .post("/:id/response", requirePerm("letter:write"), async (c) => {
    const input = await body(c, letterResponse);
    const p = staff(c);
    const db = c.get("db");
    const l = await loadLetter(db, p.orgId, c.req.param("id"));
    const liRows = await letters.letterItemRows(db, l.id);
    const valid = new Set(liRows.map((r) => r.reportItemId));
    if (input.outcomes.some((o) => !valid.has(o.reportItemId))) throw new AppError("invalid_items", 400, "Outcomes must refer to items in this letter");
    if (input.documentId) {
      const d = await documents.getDocument(db, p.orgId, input.documentId);
      if (!d || d.clientId !== l.clientId) throw new AppError("invalid_document", 400, "The response document must belong to this client");
    }
    await transitionOr409(letters.transitionLetter(db, p.orgId, l.id, ["sent", "overdue"], { status: "response_received" }), "Responses can only be logged for sent or overdue letters");
    const resp = await letters.insertResponse(db, p.orgId, { letterId: l.id, receivedAt: parseDay(input.receivedAt), documentId: input.documentId, notes: input.notes, loggedBy: p.id });
    for (const o of input.outcomes) {
      await letters.setLetterItemOutcome(db, l.id, o.reportItemId, o.outcome);
      await reports.setItemOutcome(db, p.orgId, o.reportItemId, o.outcome);
    }
    if (l.deadlineWorkflowId) {
      try {
        await (await c.env.WF_DEADLINE.get(l.deadlineWorkflowId)).terminate();
      } catch {
        // Already finished or gone; each deadline step re-checks status anyway.
      }
    }
    if (l.sentAt) metric(c.env, "days_to_response", p.orgId, (parseDay(input.receivedAt) - l.sentAt) / DAY);
    audit(c, { action: "letter.response_logged", entityType: "letter", entityId: l.id, diff: { responseId: resp.id, outcomes: input.outcomes } });
    return c.json({ status: "response_received", responseId: resp.id });
  })

  .post("/:id/close", requirePerm("letter:write"), async (c) => {
    const p = staff(c);
    const db = c.get("db");
    const l = await loadLetter(db, p.orgId, c.req.param("id"));
    await transitionOr409(letters.transitionLetter(db, p.orgId, l.id, "response_received", { status: "closed" }), "Only letters with a logged response can be closed");
    audit(c, { action: "letter.closed", entityType: "letter", entityId: l.id });
    return c.json({ status: "closed" });
  });

export type { Ctx };
