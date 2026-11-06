import { Hono } from "hono";
import { auth as authRepo, clients, documents, orgs, webhooks } from "@da/db";
import {
  AppError,
  CLIENT_TRANSITIONS,
  clientAssign,
  clientCreate,
  clientListQuery,
  clientStatusChange,
  clientUpdate,
  noteCreate,
} from "@da/shared";
import { type AppEnv, type Ctx, audit, staff } from "../lib/context";
import { acceptUpload, streamDocument } from "../lib/documents";
import { esignProvider } from "../lib/services";
import { body, query, requirePerm } from "../middleware";
import { issueInvite } from "./auth";

export async function loadClient(c: Ctx, id: string) {
  const row = await clients.getClientRow(c.get("db"), staff(c).orgId, id);
  if (!row) throw new AppError("not_found", 404, "Client not found");
  return row;
}

async function assertStaffInOrg(c: Ctx, staffId: string) {
  const u = await orgs.getUser(c.get("db"), staff(c).orgId, staffId);
  if (!u || u.status !== "active") throw new AppError("invalid_assignee", 400, "Choose an active staff member");
}

export const clientRoutes = new Hono<AppEnv>()
  .get("/", requirePerm("client:read"), async (c) => c.json(await clients.listClients(c.get("db"), staff(c).orgId, query(c, clientListQuery))))

  // R9.1, R9.2, R9.3
  .post("/", requirePerm("client:write"), async (c) => {
    const input = await body(c, clientCreate);
    const p = staff(c);
    const db = c.get("db");
    const fc = c.get("fc");
    const assignedStaffId = input.assignedStaffId ?? p.id;
    await assertStaffInOrg(c, assignedStaffId);
    const dupes = await clients.findDuplicates(db, fc, p.orgId, input.ssn);
    if (dupes.length && !input.confirmDuplicate) throw new AppError("possible_duplicate", 409, "A client with this SSN already exists", { duplicateOf: dupes });
    const id = await clients.createClient(db, fc, p.orgId, { ...input, assignedStaffId });
    audit(c, { action: "client.created", entityType: "client", entityId: id, diff: { firstName: input.firstName, lastName: input.lastName, email: input.email, assignedStaffId, confirmedDuplicate: dupes.length > 0 } });
    return c.json(await clients.getClientDetail(db, p.orgId, id), 201);
  })

  .get("/:id", requirePerm("client:read"), async (c) => {
    const d = await clients.getClientDetail(c.get("db"), staff(c).orgId, c.req.param("id"));
    if (!d) throw new AppError("not_found", 404, "Client not found");
    return c.json(d);
  })

  .patch("/:id", requirePerm("client:write"), async (c) => {
    const input = await body(c, clientUpdate);
    const r = await clients.updateClient(c.get("db"), staff(c).orgId, c.req.param("id"), input);
    if (!r) throw new AppError("not_found", 404, "Client not found");
    audit(c, { action: "client.updated", entityType: "client", entityId: c.req.param("id"), diff: r });
    return c.json(await clients.getClientDetail(c.get("db"), staff(c).orgId, c.req.param("id")));
  })

  /** Reveals SSN and DOB; every read is audited. */
  .get("/:id/pii", requirePerm("client:read_pii"), async (c) => {
    const pii = await clients.getClientPii(c.get("db"), c.get("fc"), staff(c).orgId, c.req.param("id"));
    if (!pii) throw new AppError("not_found", 404, "Client not found");
    audit(c, { action: "client.pii_viewed", entityType: "client", entityId: c.req.param("id") });
    return c.json(pii);
  })

  // R9.4
  .post("/:id/status", requirePerm("client:write"), async (c) => {
    const { status } = await body(c, clientStatusChange);
    const row = await loadClient(c, c.req.param("id"));
    if (row.status === status) return c.json({ status });
    if (!CLIENT_TRANSITIONS[row.status].includes(status)) throw new AppError("invalid_transition", 409, `Cannot move a client from ${row.status} to ${status}`);
    await clients.setClientStatus(c.get("db"), row.orgId, row.id, status);
    audit(c, { action: "client.status_changed", entityType: "client", entityId: row.id, diff: { from: row.status, to: status } });
    return c.json({ status });
  })

  .post("/:id/assign", requirePerm("client:assign"), async (c) => {
    const { staffId } = await body(c, clientAssign);
    const row = await loadClient(c, c.req.param("id"));
    await assertStaffInOrg(c, staffId);
    await clients.assignClient(c.get("db"), row.orgId, row.id, staffId);
    audit(c, { action: "client.assigned", entityType: "client", entityId: row.id, diff: { from: row.assignedStaffId, to: staffId } });
    return c.json({ ok: true });
  })

  // R9.5
  .post("/:id/invite", requirePerm("client:write"), async (c) => {
    const row = await loadClient(c, c.req.param("id"));
    if (await authRepo.accountForClient(c.get("db"), row.orgId, row.id)) throw new AppError("account_exists", 409, "This client already has a portal account");
    const r = await issueInvite(c, row.orgId, row.id, staff(c).id);
    audit(c, { action: "client.invited", entityType: "client", entityId: row.id });
    return c.json(r, 201);
  })

  /** Staff unlock after lockout (R4.7). */
  .post("/:id/unlock", requirePerm("client:write"), async (c) => {
    const row = await loadClient(c, c.req.param("id"));
    const acct = await authRepo.accountForClient(c.get("db"), row.orgId, row.id);
    if (!acct) throw new AppError("not_found", 404, "This client has no portal account");
    await authRepo.unlockAccount(c.get("db"), row.orgId, acct.id);
    audit(c, { action: "client.portal_unlocked", entityType: "client", entityId: row.id });
    return c.json({ ok: true });
  })

  .get("/:id/timeline", requirePerm("client:read"), async (c) => {
    const row = await loadClient(c, c.req.param("id"));
    return c.json(await clients.clientTimeline(c.get("db"), row.orgId, row.id));
  })

  // R9.7: notes are editable for 24 hours, then only corrections can be appended.
  .get("/:id/notes", requirePerm("client:read"), async (c) => {
    const row = await loadClient(c, c.req.param("id"));
    return c.json(await clients.listNotes(c.get("db"), row.orgId, row.id));
  })
  .post("/:id/notes", requirePerm("client:write"), async (c) => {
    const { body: text } = await body(c, noteCreate);
    const row = await loadClient(c, c.req.param("id"));
    const n = await clients.addNote(c.get("db"), row.orgId, row.id, staff(c).id, text);
    audit(c, { action: "note.created", entityType: "note", entityId: n.id, diff: { clientId: row.id } });
    return c.json({ id: n.id }, 201);
  })
  .patch("/:id/notes/:noteId", requirePerm("client:write"), async (c) => {
    const { body: text } = await body(c, noteCreate);
    const p = staff(c);
    const n = await clients.getNote(c.get("db"), p.orgId, c.req.param("noteId"));
    if (!n || n.clientId !== c.req.param("id")) throw new AppError("not_found", 404, "Note not found");
    if (n.authorId !== p.id) throw new AppError("forbidden", 403, "Only the author can edit a note");
    if (Date.now() - n.createdAt >= clients.NOTE_EDIT_WINDOW) throw new AppError("note_locked", 409, "Notes cannot be edited after 24 hours. Add a correction instead.");
    await clients.updateNote(c.get("db"), p.orgId, n.id, text);
    audit(c, { action: "note.edited", entityType: "note", entityId: n.id, diff: { before: n.body, after: text } });
    return c.json({ ok: true });
  })

  // ---------- documents (R10) ----------
  .get("/:id/documents", requirePerm("document:read"), async (c) => {
    const row = await loadClient(c, c.req.param("id"));
    return c.json(await documents.listDocuments(c.get("db"), row.orgId, row.id));
  })
  .post("/:id/documents", requirePerm("document:write"), async (c) => {
    const row = await loadClient(c, c.req.param("id"));
    const p = staff(c);
    return c.json(await acceptUpload(c, { orgId: row.orgId, clientId: row.id, kind: "staff", id: p.id }), 201);
  })

  // ---------- e-signature authorization (R11.1) ----------
  .post("/:id/authorization/send", requirePerm("client:write"), async (c) => {
    const row = await loadClient(c, c.req.param("id"));
    if (row.authStatus === "signed") throw new AppError("already_signed", 409, "Authorization is already signed");
    const provider = await esignProvider(c.env);
    const { providerRequestId } = await provider.createRequest({
      signerName: `${row.firstName} ${row.lastName}`,
      signerEmail: row.email,
      templateId: c.env.ESIGN_TEMPLATE_ID ?? "default",
      metadata: { client_id: row.id, org_id: row.orgId },
    });
    await webhooks.createEsignRequest(c.get("db"), row.orgId, row.id, provider.name, providerRequestId);
    await clients.setAuthStatus(c.get("db"), row.orgId, row.id, "sent");
    audit(c, { action: "authorization.sent", entityType: "client", entityId: row.id, diff: { provider: provider.name, providerRequestId } });
    return c.json({ status: "sent", providerRequestId });
  })

  // ---------- edit lock (R14.9) ----------
  .post("/:id/lock", requirePerm("letter:write"), async (c) => {
    const row = await loadClient(c, c.req.param("id"));
    const p = staff(c);
    const lock = c.env.CLIENT_LOCK.get(c.env.CLIENT_LOCK.idFromName(row.id));
    const state = await lock.acquire({ id: p.id, name: p.displayName });
    return c.json(state, state.ok ? 200 : 409);
  })
  .delete("/:id/lock", requirePerm("letter:write"), async (c) => {
    const row = await loadClient(c, c.req.param("id"));
    await c.env.CLIENT_LOCK.get(c.env.CLIENT_LOCK.idFromName(row.id)).release(staff(c).id);
    return c.json({ ok: true });
  });

/** Download route lives outside /clients/:id so letter PDFs and exports use the same audited path. */
export const documentRoutes = new Hono<AppEnv>().get("/:id/download", requirePerm("document:read"), async (c) => {
  const d = await documents.getDocument(c.get("db"), staff(c).orgId, c.req.param("id"));
  if (!d) throw new AppError("not_found", 404, "Document not found");
  if (d.type === "audit_export" && !staff(c).permissions.includes("audit:export")) throw new AppError("forbidden", 403, "You do not have permission to do that");
  return streamDocument(c, d);
});

/** Throws 409 when another staff member holds the client's edit lease. */
export async function assertLockAvailable(c: Ctx, clientId: string) {
  const holder = await c.env.CLIENT_LOCK.get(c.env.CLIENT_LOCK.idFromName(clientId)).state();
  if (holder && holder.id !== staff(c).id) throw new AppError("lock_conflict", 409, `Being edited by ${holder.name}`, { holder: { id: holder.id, name: holder.name } });
}
