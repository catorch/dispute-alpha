import { createMessageBatch, env, getQueueResult, createExecutionContext } from "cloudflare:test";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { auditRepo, clients, documents, letters, ops, orgs, tasks } from "@da/db";
import { uuidv7, DAY } from "@da/shared";
import { EICAR } from "../src/container";
import { d1Export, dailyDigest, keyRotationTick, monthlyAuditArchive, overdueSweep, weeklyCleanup } from "../src/cron";
import { letterHtml, mergeAttachments } from "../src/lib/letters";
import { fieldCrypto, memoryEmail } from "../src/lib/services";
import { buildAuditCsv, handleAuditExport, handleNotification, handlePdfBatch, handleScan, queueHandler } from "../src/queues";
import { db, makeEnv, seedClient, seedLetter } from "./helpers";

async function quarantined(t: ReturnType<typeof makeEnv>, s: { orgId: string; clientId: string }, type: string, content: string) {
  const id = uuidv7();
  const key = documents.docKey(s.orgId, s.clientId, id);
  await env.QUARANTINE.put(key, content);
  await documents.insertDocument(db(), { id, orgId: s.orgId, clientId: s.clientId, type, status: "scan_pending", bucket: "quarantine", objectKey: key, filename: "f.pdf", mime: "application/pdf", size: content.length, encrypted: false, uploadedByKind: "client", uploadedById: "acct" });
  return { id, key };
}

describe("doc-scan consumer (R10.3–R10.5, R10.8)", () => {
  it("moves clean files out of quarantine and encrypts ID documents", async () => {
    const t = makeEnv();
    const s = await seedClient(t.env);
    const { id, key } = await quarantined(t, s, "government_id", "%PDF-1.4 my id");
    await handleScan(t.env, id);
    const d = await documents.getDocumentById(db(), id);
    expect(d).toMatchObject({ status: "available", bucket: "documents", encrypted: true });
    expect(await env.QUARANTINE.head(key)).toBeNull();
    const stored = new Uint8Array(await (await env.DOCS.get(key))!.arrayBuffer());
    expect(new TextDecoder().decode(stored)).not.toContain("my id");
    expect(new TextDecoder().decode(await fieldCrypto(t.env).decryptBytes(`doc:${id}`, stored))).toBe("%PDF-1.4 my id");
    expect(t.notified.some((m) => m.event === "document_available")).toBe(true);
    // Redelivery is a no-op.
    await handleScan(t.env, id);
  });

  it("deletes infected files, rejects the document, and creates a task", async () => {
    const t = makeEnv();
    const s = await seedClient(t.env);
    const { id, key } = await quarantined(t, s, "other", EICAR);
    await handleScan(t.env, id);
    expect((await documents.getDocumentById(db(), id))?.status).toBe("rejected");
    expect(await env.QUARANTINE.head(key)).toBeNull();
    expect((await tasks.listTasks(db(), s.orgId, { assigneeId: s.staffId })).some((x) => x.title.includes("virus scan"))).toBe(true);
  });

  it("keeps files quarantined when the scanner is down", async () => {
    const t = makeEnv();
    const s = await seedClient(t.env);
    const { id, key } = await quarantined(t, s, "other", "%PDF-1.4");
    await expect(handleScan(t.env, id, async () => Promise.reject(new Error("down")))).rejects.toThrow("down");
    expect((await documents.getDocumentById(db(), id))?.status).toBe("scan_pending");
    expect(await env.QUARANTINE.head(key)).not.toBeNull();
  });

  it("retries messages through the queue router on failure", async () => {
    const t = makeEnv({ APP_ENV: "staging" });
    const batch = createMessageBatch("doc-scan", [{ id: "m1", timestamp: new Date(), attempts: 1, body: { documentId: "missing-or-whatever" } }]);
    const ctx = createExecutionContext();
    await queueHandler(batch as MessageBatch<unknown>, t.env);
    const r = await getQueueResult(batch, ctx);
    // No CLAMAV binding in a deployed env is an error → retried, never released unscanned.
    expect(r.retryMessages).toHaveLength(1);
    expect(r.explicitAcks).toHaveLength(0);
  });
});

describe("notifications consumer (R18)", () => {
  it("sends email and in-app once, even when redelivered", async () => {
    const t = makeEnv();
    const s = await seedClient(t.env);
    const before = memoryEmail.sent.length;
    const msg = { id: `n-${uuidv7()}`, orgId: s.orgId, recipient: { kind: "staff" as const, id: s.staffId }, event: "letter_ready" as const, vars: { link: "https://app.test/x" } };
    await handleNotification(t.env, msg);
    await handleNotification(t.env, msg);
    expect(memoryEmail.sent.length - before).toBe(1);
    expect(memoryEmail.sent.at(-1)?.text).toContain("https://app.test/x");
    expect((await tasks.listNotifications(db(), s.orgId, "staff", s.staffId)).length).toBe(1);
  });

  it("sends SMS only to opted-in clients when the org enables SMS", async () => {
    const sms: { to: string; body: string }[] = [];
    const t = makeEnv({ TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tok", TWILIO_FROM: "+15550000000" });
    const s = await seedClient(t.env);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      const p = new URLSearchParams(String(init?.body));
      sms.push({ to: p.get("To") ?? "", body: p.get("Body") ?? "" });
      return new Response("{}", { status: 201 });
    }) as typeof fetch;
    try {
      const msg = (id: string) => ({ id, orgId: s.orgId, recipient: { kind: "client" as const, id: s.clientId }, event: "report_ready" as const, vars: { link: "https://app.test/portal" } });
      await handleNotification(t.env, msg("a"));
      expect(sms).toHaveLength(0);
      await clients.setSmsOptIn(db(), s.orgId, s.clientId, true);
      await orgs.updateOrgSettings(db(), s.orgId, { smsEnabled: true });
      await handleNotification(t.env, msg("b"));
      expect(sms).toHaveLength(1);
      expect(sms[0].body).toContain("STOP");
      expect(sms[0].body).not.toMatch(/\d{9}/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("pdf-render consumer (R15.1, R15.4)", () => {
  it("renders the batch with one session, resolves DOB only in the print HTML, and wakes the workflow", async () => {
    const t = makeEnv();
    const a = await seedLetter(t.env, "rendering");
    const b = await seedLetter(t.env, "rendering");
    const htmls: string[] = [];
    let opened = 0;
    const open = async () => {
      opened++;
      return { render: async (html: string) => (htmls.push(html), new TextEncoder().encode("%PDF-fake")), close: async () => {} };
    };
    const batch = createMessageBatch("pdf-render", [
      { id: "1", timestamp: new Date(), attempts: 1, body: { letterId: a.letterId, instanceId: "i-a" } },
      { id: "2", timestamp: new Date(), attempts: 1, body: { letterId: b.letterId, instanceId: "i-b" } },
    ]);
    await handlePdfBatch(t.env, batch as never, open);
    expect(opened).toBe(1);
    expect(htmls[0]).toContain("DOB: 03/14/1985");
    expect(htmls[0]).not.toMatch(/https?:\/\//);
    expect(t.events.map((e) => e.id).sort()).toEqual(["i-a", "i-b"]);
    // The stored letter body itself never contains the DOB.
    expect((await letters.getLetter(db(), a.orgId, a.letterId))?.bodyHtml).not.toContain("1985");
  });

  it("retries the batch when the browser never starts", async () => {
    const t = makeEnv();
    const a = await seedLetter(t.env, "rendering");
    const batch = createMessageBatch("pdf-render", [{ id: "1", timestamp: new Date(), attempts: 1, body: { letterId: a.letterId, instanceId: "i-x" } }]);
    const ctx = createExecutionContext();
    await handlePdfBatch(t.env, batch as never, () => new Promise(() => {}), 50);
    const r = await getQueueResult(batch, ctx);
    expect(r.retryMessages).toHaveLength(1);
    expect(t.events).toHaveLength(0);
  });

  it("merges image attachments onto Letter pages", async () => {
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const { PDFDocument } = await import("pdf-lib");
    const base = await PDFDocument.create();
    base.addPage();
    const out = await PDFDocument.load(await mergeAttachments(await base.save(), [{ mime: "image/png", bytes: png, filename: "id.png" }, { mime: "image/heic", bytes: new Uint8Array(4), filename: "x.heic" }]));
    expect(out.getPageCount()).toBe(3);
  });

  it("refuses to print letters that are not locked", async () => {
    const t = makeEnv();
    const s = await seedLetter(t.env, "rendering");
    await letters.setLetterFields(db(), s.letterId, { lockedAt: null });
    await expect(letterHtml(db(), fieldCrypto(t.env), s.orgId, s.letterId)).rejects.toThrow("not locked");
  });
});

describe("dead-letter queues (R15.3, R22.1)", () => {
  it("marks the letter render_failed, wakes the workflow, records the message, and alerts ops", async () => {
    const t = makeEnv();
    const s = await seedLetter(t.env, "rendering");
    const before = memoryEmail.sent.length;
    const batch = createMessageBatch("staging-pdf-render-dlq", [{ id: "d1", timestamp: new Date(), attempts: 1, body: { letterId: s.letterId, instanceId: "i-dead" } }]);
    const ctx = createExecutionContext();
    await queueHandler(batch as MessageBatch<unknown>, t.env);
    expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual(["d1"]);
    expect((await letters.getLetter(db(), s.orgId, s.letterId))?.status).toBe("render_failed");
    expect(t.events).toEqual([{ id: "i-dead", event: { type: "pdf-rendered", payload: { ok: false, error: "retries exhausted" } } }]);
    expect(t.notified.some((m) => m.event === "render_failed")).toBe(true);
    const row = await env.DB.prepare("SELECT entity_id FROM audit_log WHERE action = 'dlq.message' ORDER BY created_at DESC").first<{ entity_id: string }>();
    expect(row?.entity_id).toBe("pdf-render");
    expect(memoryEmail.sent.slice(before).some((m) => m.to === "ops@acme.test" && m.subject.includes("dead-lettered on pdf-render"))).toBe(true);
  });

  it("fails a dead-lettered audit export", async () => {
    const t = makeEnv();
    const s = await seedClient(t.env);
    const exp = await ops.createAuditExport(db(), s.orgId, s.adminId, { from: "2026-01-01", to: "2026-01-02" });
    const batch = createMessageBatch("audit-export-dlq", [{ id: "d2", timestamp: new Date(), attempts: 1, body: { exportId: exp.id } }]);
    await queueHandler(batch as MessageBatch<unknown>, t.env);
    expect((await ops.getAuditExport(db(), exp.id))?.status).toBe("failed");
  });
});

describe("audit export (R19.4, R19.5)", () => {
  it("builds a CSV with formula-injection protection and registers the document", async () => {
    const t = makeEnv();
    const s = await seedClient(t.env);
    await auditRepo.insert(db(), [{ orgId: s.orgId, actorKind: "staff", actorId: s.staffId, action: "=HYPERLINK(evil)", entityType: "client", entityId: s.clientId }]);
    const exp = await ops.createAuditExport(db(), s.orgId, s.adminId, { from: "2020-01-01", to: "2099-12-31" });
    await handleAuditExport(t.env, exp.id);
    const done = await ops.getAuditExport(db(), exp.id);
    expect(done?.status).toBe("ready");
    const doc = await documents.getDocument(db(), s.orgId, done?.documentId ?? "");
    const csv = await (await env.DOCS.get(doc?.objectKey ?? ""))!.text();
    expect(csv.split("\n")[0]).toContain("actor_kind");
    expect(csv).toContain(`"'=HYPERLINK(evil)"`);
    expect(t.notified.some((m) => m.event === "audit_export_ready")).toBe(true);
    // Another org's rows are excluded.
    expect(await buildAuditCsv(t.env, "other-org", 0, Date.now() + DAY)).toBe(csv.split("\n")[0]);
  });
});

describe("cron jobs", () => {
  it("overdue sweep catches letters a workflow missed (R16.6)", async () => {
    const t = makeEnv();
    const s = await seedLetter(t.env, "sent", Date.now() - 1000);
    expect(await overdueSweep(t.env)).toBeGreaterThanOrEqual(1);
    expect((await letters.getLetter(db(), s.orgId, s.letterId))?.status).toBe("overdue");
    expect(await overdueSweep(t.env)).toBe(0);
  });

  it("weekly cleanup expires stale quarantine and old invites", async () => {
    const t = makeEnv();
    const s = await seedClient(t.env);
    const { id, key } = await quarantined(t, s, "other", "%PDF");
    await db().run(sql`UPDATE document SET created_at = ${Date.now() - 8 * DAY} WHERE id = ${id}`);
    const r = await weeklyCleanup(t.env);
    expect(r.expiredUploads).toBeGreaterThanOrEqual(1);
    expect((await documents.getDocumentById(db(), id))?.status).toBe("expired");
    expect(await env.QUARANTINE.head(key)).toBeNull();
  });

  it("daily digest emails staff with open items", async () => {
    const t = makeEnv();
    const s = await seedClient(t.env);
    await tasks.createTask(db(), s.orgId, { title: "x", assigneeId: s.staffId, createdByKind: "system" });
    await dailyDigest(t.env);
    const d = t.notified.find((m) => m.event === "daily_digest" && m.recipient.kind === "staff" && m.recipient.id === s.staffId);
    expect(d?.vars?.counts?.tasks).toBe(1);
  });

  it("re-encrypts every ciphertext when the key version moves (R6.2)", async () => {
    const t = makeEnv();
    const s = await seedClient(t.env);
    const t2 = makeEnv({ ENC_KEY_CURRENT: "2" });
    for (let i = 0; i < 20 && (await keyRotationTick(t2.env)) > 0; i++);
    const row = await clients.getClientRow(db(), s.orgId, s.clientId);
    expect(row?.ssnEnc.startsWith("v2:")).toBe(true);
    expect(row?.dobEnc.startsWith("v2:")).toBe(true);
    expect((await clients.getClientPii(db(), fieldCrypto(t2.env), s.orgId, s.clientId))?.dob).toBe("1985-03-14");
    expect((await ops.runningRotations(db())).length).toBe(0);
  });

  it("exports D1 to the backups bucket via the REST API (R21.2)", async () => {
    const t = makeEnv({ CF_ACCOUNT_ID: "acc", CF_API_TOKEN: "tok", D1_DATABASE_ID: "db1" });
    let polls = 0;
    const fetcher = (async (u: RequestInfo | URL) => {
      if (String(u).startsWith("https://signed.example")) return new Response("CREATE TABLE x;");
      polls++;
      return Response.json({ success: true, result: polls < 2 ? { at_bookmark: "bm", status: "active" } : { at_bookmark: "bm", status: "complete", result: { signed_url: "https://signed.example/dump" } } });
    }) as typeof fetch;
    const key = await d1Export(t.env, Date.parse("2026-11-05"), fetcher, async () => {});
    expect(key).toBe("d1/2026-11-05.sql");
    expect(await (await env.BACKUPS.get(key ?? ""))!.text()).toBe("CREATE TABLE x;");
  });

  it("archives the previous month's audit log", async () => {
    const t = makeEnv();
    const key = await monthlyAuditArchive(t.env, Date.parse("2026-12-01T10:00:00Z"));
    expect(key).toBe("audit/2026-11.csv");
    expect(await env.BACKUPS.head(key)).not.toBeNull();
  });
});
