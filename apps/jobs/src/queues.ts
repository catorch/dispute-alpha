import { auditRepo, clients, documents, letters, ops, orgs, tasks } from "@da/db";
import { htmlFromText } from "@da/providers";
import { ENCRYPTED_DOC_TYPES, type NotifyMessage, TEMPLATES, uuidv7, isoDay } from "@da/shared";
import { type Scanner, scannerFor } from "./container";
import type { Env, PdfRenderMessage } from "./env";
import { letterHtml } from "./lib/letters";
import { type RenderSession, openBrowserRenderer } from "./lib/pdf";
import { dbFor, emailSender, fieldCrypto, link, notify, opsAlert, smsSender } from "./lib/services";
import { renderFailed } from "./workflows/letter-pipeline";

const log = (level: "info" | "error", msg: string, data: Record<string, unknown> = {}) => console[level === "error" ? "error" : "log"](JSON.stringify({ level, msg, ...data }));

/** Client-facing events that may also go out by SMS when the client opted in. */
const SMS_EVENTS = new Set(["report_ready", "letter_overdue", "document_rejected"]);

// ---------- notifications (R18) ----------
export async function handleNotification(env: Env, m: NotifyMessage) {
  const db = dbFor(env);
  const t = TEMPLATES[m.event](m.vars ?? {});
  const org = m.orgId ? await orgs.getOrg(db, m.orgId) : null;
  let email: string | null = null;
  let phone: string | null = null;
  let inApp: { kind: "staff" | "client"; id: string } | null = null;
  const r = m.recipient;
  if (r.kind === "staff") {
    const u = await orgs.getUser(db, m.orgId, r.id);
    if (!u || u.status !== "active") return;
    email = u.email;
    inApp = { kind: "staff", id: u.id };
  } else if (r.kind === "client") {
    const c = await clients.getClientRow(db, m.orgId, r.id);
    if (!c) return;
    email = c.email;
    inApp = { kind: "client", id: c.id };
    if (c.smsOptIn && c.phone && org?.settings.smsEnabled && SMS_EVENTS.has(m.event)) phone = c.phone;
  } else if (r.kind === "ops") {
    email = env.OPS_ALERT_EMAIL ?? null;
  } else if (r.kind === "email") {
    email = r.email;
  }
  const channels = m.channels ?? ["email", "in_app", "sms"];

  // Each channel is recorded after it succeeds; a redelivered message skips what already went out (R22.2).
  const once = async (channel: string, send: () => Promise<unknown>) => {
    if (await tasks.wasDelivered(db, m.id, channel)) return;
    await send();
    await tasks.claimDelivery(db, m.id, channel);
  };
  if (channels.includes("in_app") && inApp) await once("in_app", () => tasks.insertNotification(db, { id: uuidv7(), orgId: m.orgId, recipientKind: inApp.kind, recipientId: inApp.id, kind: m.event, title: t.inApp, link: m.vars?.link ?? null }));
  if (channels.includes("email") && email) {
    const to = email;
    await once("email", async () => (await emailSender(env)).send({ to, subject: t.subject, text: t.text, html: htmlFromText(t.text) }));
  }
  if (channels.includes("sms") && phone) {
    const sms = await smsSender(env);
    const to = phone;
    if (sms) await once("sms", () => sms.send(to, `${t.inApp}. ${m.vars?.link ?? env.PUBLIC_URL} Reply STOP to opt out.`));
  }
}

// ---------- virus scanning (R10.3–R10.5, R10.8) ----------
export async function handleScan(env: Env, documentId: string, scan: Scanner = scannerFor(env)) {
  const db = dbFor(env);
  const d = await documents.getDocumentById(db, documentId);
  if (!d || d.status !== "scan_pending") return; // already processed: redelivery is a no-op
  const obj = await env.QUARANTINE.get(d.objectKey);
  if (!obj) {
    await documents.markDocument(db, d.id, { status: "expired" });
    return;
  }
  const bytes = new Uint8Array(await obj.arrayBuffer());
  const result = await scan(bytes); // throws if the scanner is down → queue retry, file stays quarantined
  const client = d.clientId ? await clients.getClientRow(db, d.orgId, d.clientId) : null;
  const staffId = client?.assignedStaffId;
  if (result.result === "infected") {
    await env.QUARANTINE.delete(d.objectKey);
    await documents.markDocument(db, d.id, { status: "rejected", scanResultJson: JSON.stringify(result) });
    await auditRepo.insert(db, [{ orgId: d.orgId, actorKind: "system", action: "document.infected", entityType: "document", entityId: d.id, diff: { signature: result.signature } }]);
    if (staffId) {
      await tasks.createTask(db, d.orgId, { title: "Uploaded file failed the virus scan", assigneeId: staffId, entityType: "client", entityId: d.clientId, createdByKind: "system", dedupeKey: `infected:${d.id}` });
      await notify(env, { id: `scan:${d.id}`, orgId: d.orgId, recipient: { kind: "staff", id: staffId }, event: "document_rejected", vars: { link: link(env, `/admin/clients/${d.clientId}?tab=documents`) } });
    }
    return;
  }
  const encrypt = ENCRYPTED_DOC_TYPES.includes(d.type as never);
  const stored = encrypt ? await fieldCrypto(env).encryptBytes(`doc:${d.id}`, bytes) : bytes;
  await env.DOCS.put(d.objectKey, stored, { httpMetadata: { contentType: encrypt ? "application/octet-stream" : d.mime } });
  await documents.markDocument(db, d.id, { status: "available", bucket: "documents", encrypted: encrypt, scanResultJson: JSON.stringify(result) });
  await env.QUARANTINE.delete(d.objectKey);
  await auditRepo.insert(db, [{ orgId: d.orgId, actorKind: "system", action: "document.scanned_clean", entityType: "document", entityId: d.id }]);
  if (d.uploadedByKind === "client" && staffId)
    await notify(env, { id: `scan:${d.id}`, orgId: d.orgId, recipient: { kind: "staff", id: staffId }, event: "document_available", vars: { link: link(env, `/admin/clients/${d.clientId}?tab=documents`) } });
}

// ---------- PDF rendering (R15.1, R15.4) ----------
export const BROWSER_TIMEOUT_MS = 60_000;
/** Rejects after `ms` so a hung browser start or render fails fast and the message is retried. */
export const withTimeout = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms))]);

/** Renders the batch with one browser session, stores each body PDF, and wakes the waiting workflow. */
export async function handlePdfBatch(env: Env, batch: MessageBatch<PdfRenderMessage>, open: (env: Env) => Promise<RenderSession> = openBrowserRenderer, timeoutMs = BROWSER_TIMEOUT_MS) {
  const db = dbFor(env);
  const fc = fieldCrypto(env);
  let session: RenderSession;
  try {
    session = await withTimeout(open(env), timeoutMs, "browser start");
  } catch (e) {
    log("error", "browser_start_failed", { err: String(e) });
    for (const msg of batch.messages) msg.retry({ delaySeconds: 30 * msg.attempts });
    return;
  }
  try {
    for (const msg of batch.messages) {
      const { letterId, instanceId } = msg.body;
      try {
        const l = await letters.getLetterById(db, letterId);
        if (!l || l.status !== "rendering") {
          msg.ack();
          continue;
        }
        const pdf = await withTimeout(session.render(await letterHtml(db, fc, l.orgId, l.id)), timeoutMs, "render");
        const key = `org/${l.orgId}/client/${l.clientId}/letter/${l.id}/body-${instanceId}.pdf`;
        await env.LETTERS.put(key, pdf, { httpMetadata: { contentType: "application/pdf" } });
        await (await env.WF_LETTER.get(instanceId)).sendEvent({ type: "pdf-rendered", payload: { ok: true, key } });
        msg.ack();
      } catch (e) {
        log("error", "pdf_render_failed", { letterId, attempt: msg.attempts, err: String(e) });
        msg.retry({ delaySeconds: 30 * msg.attempts });
      }
    }
  } finally {
    await session.close().catch(() => {});
  }
}

// ---------- audit export (R19.4, R19.5) ----------
const csvCell = (v: unknown) => {
  let s = v == null ? "" : typeof v === "string" ? v : JSON.stringify(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula injection guard
  return `"${s.replace(/"/g, '""')}"`;
};
const CSV_HEADER = ["id", "created_at", "actor_kind", "actor_id", "action", "entity_type", "entity_id", "request_id", "diff"];

export async function buildAuditCsv(env: Env, orgId: string | null, from: number, to: number, entityType?: string) {
  const db = dbFor(env);
  const lines = [CSV_HEADER.join(",")];
  for await (const rows of auditRepo.exportRange(db, orgId, from, to, entityType))
    for (const r of rows) lines.push([r.id, new Date(r.createdAt).toISOString(), r.actorKind, r.actorId, r.action, r.entityType, r.entityId, r.requestId, r.diffJson].map(csvCell).join(","));
  return lines.join("\n");
}

export async function handleAuditExport(env: Env, exportId: string) {
  const db = dbFor(env);
  const e = await ops.getAuditExport(db, exportId);
  if (!e || e.status !== "queued") return;
  const params = JSON.parse(e.paramsJson) as { from: string; to: string; entityType?: string };
  const from = Date.parse(`${params.from}T00:00:00Z`);
  const to = Date.parse(`${params.to}T00:00:00Z`) + 864e5;
  const csv = await buildAuditCsv(env, e.orgId, from, to, params.entityType);
  const docId = `auditexp-${e.id}`;
  const key = `org/${e.orgId}/exports/${docId}.csv`;
  const bytes = new TextEncoder().encode(csv);
  await env.DOCS.put(key, bytes, { httpMetadata: { contentType: "text/csv" } });
  if (!(await documents.getDocument(db, e.orgId, docId)))
    await documents.insertDocument(db, {
      id: docId,
      orgId: e.orgId,
      clientId: null,
      type: "audit_export",
      status: "available",
      bucket: "documents",
      objectKey: key,
      filename: `audit-${params.from}-to-${params.to}.csv`,
      mime: "text/csv",
      size: bytes.length,
      encrypted: false,
      uploadedByKind: "system",
      uploadedById: null,
    });
  await ops.finishAuditExport(db, e.id, "ready", docId);
  await auditRepo.insert(db, [{ orgId: e.orgId, actorKind: "system", action: "audit.export_ready", entityType: "audit_export", entityId: e.id }]);
  await notify(env, { id: `auditexp:${e.id}`, orgId: e.orgId, recipient: { kind: "staff", id: e.requestedBy }, event: "audit_export_ready", vars: { link: link(env, "/admin/audit") } });
}

// ---------- dead-letter queues (R22.1, R23.4) ----------
/** Records the dead message in the audit log (redacted) so it is retained, applies side effects, and alerts ops. */
export async function handleDeadLetter(env: Env, queue: string, body: unknown) {
  const db = dbFor(env);
  await auditRepo.insert(db, [{ orgId: null, actorKind: "system", action: "dlq.message", entityType: "queue", entityId: queue, diff: body }]);
  if (queue === "pdf-render") {
    const m = body as PdfRenderMessage;
    const l = await letters.getLetterById(db, m.letterId);
    if (l) {
      await renderFailed(env, { orgId: l.orgId, letterId: l.id }, "PDF render retries exhausted");
      try {
        await (await env.WF_LETTER.get(m.instanceId)).sendEvent({ type: "pdf-rendered", payload: { ok: false, error: "retries exhausted" } });
      } catch {
        // instance already finished
      }
    }
  }
  if (queue === "audit-export") {
    const id = (body as { exportId?: string }).exportId;
    if (id) await ops.finishAuditExport(db, id, "failed");
  }
  const summary = queue === "notifications" ? `event=${(body as NotifyMessage).event} id=${(body as NotifyMessage).id}` : `payload keys=${Object.keys((body as object) ?? {}).join(",")}`;
  await opsAlert(env, `Message dead-lettered on ${queue}`, `${summary} at ${isoDay(Date.now())}`);
}

/** Queue router; staging queues are prefixed "staging-". */
export async function queueHandler(batch: MessageBatch<unknown>, env: Env) {
  const name = batch.queue.replace(/^staging-/, "");
  if (name.endsWith("-dlq")) {
    for (const msg of batch.messages) {
      await handleDeadLetter(env, name.slice(0, -4), msg.body);
      msg.ack();
    }
    return;
  }
  if (name === "pdf-render") return handlePdfBatch(env, batch as MessageBatch<PdfRenderMessage>);
  for (const msg of batch.messages) {
    try {
      if (name === "notifications") await handleNotification(env, msg.body as NotifyMessage);
      else if (name === "doc-scan") await handleScan(env, (msg.body as { documentId: string }).documentId);
      else if (name === "audit-export") await handleAuditExport(env, (msg.body as { exportId: string }).exportId);
      else log("error", "unknown_queue", { queue: batch.queue });
      msg.ack();
    } catch (e) {
      log("error", "queue_message_failed", { queue: name, attempt: msg.attempts, err: String(e) });
      msg.retry({ delaySeconds: Math.min(60 * 2 ** (msg.attempts - 1), 900) });
    }
  }
}
