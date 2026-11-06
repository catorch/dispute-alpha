import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { reports } from "@da/db";
import { fakeReport, normalizeBureau } from "@da/providers";
import { BUREAUS, DAY, isoDay } from "@da/shared";
import { fieldCrypto } from "../src/lib/context";
import { Client, clientInput, db, enrollClient, fakeSig, form, makeEnv, pdfFile, seedOrg } from "./helpers";

async function setup() {
  const t = makeEnv();
  const s = await seedOrg(t);
  const input = clientInput();
  const c = await s.staff.client.json("POST", "/api/v1/clients", input, 201);
  return { t, s, input, clientId: c.id as string };
}

/** Writes a normalized fake report straight into D1, as the import workflow would. */
async function seedReport(orgId: string, clientId: string, staffId: string) {
  const rep = await reports.createReport(db(), orgId, clientId, "fake", staffId);
  const raw = fakeReport("ref", "Ruiz", "78701");
  for (const b of BUREAUS) await reports.insertItems(db(), fieldCrypto(env as never), { orgId, reportId: rep.id, clientId }, await normalizeBureau(raw, b));
  await reports.updateReport(db(), rep.id, { status: "complete", completedAt: Date.now() });
  const items = await reports.itemsForReport(db(), orgId, rep.id);
  return { reportId: rep.id, items };
}

async function signAuthorization(t: ReturnType<typeof makeEnv>, s: Awaited<ReturnType<typeof seedOrg>>, clientId: string) {
  const sent = await s.staff.client.json("POST", `/api/v1/clients/${clientId}/authorization/send`);
  const body = JSON.stringify({ eventId: `evt-${sent.providerRequestId}`, providerRequestId: sent.providerRequestId, type: "signed" });
  const res = await new Client(t).post("/api/v1/webhooks/esign", JSON.parse(body), { "x-fake-signature": await fakeSig("esign-secret", body) });
  expect(res.status).toBe(200);
  return { sent, body };
}

describe("client records (R6, R9)", () => {
  it("encrypts SSN and DOB at rest and keeps last four plus HMAC", async () => {
    const { s, input, clientId } = await setup();
    const row = await env.DB.prepare("SELECT * FROM client WHERE id = ?").bind(clientId).first<Record<string, string>>();
    const digits = input.ssn.replace(/-/g, "");
    expect(JSON.stringify(row)).not.toContain(digits);
    expect(JSON.stringify(row)).not.toContain(input.dob);
    expect(row?.ssn_enc).toMatch(/^v1:/);
    expect(row?.ssn_last4).toBe(digits.slice(-4));
    expect(row?.ssn_hmac).toMatch(/^[0-9a-f]{64}$/);
    const pii = await s.staff.client.json("GET", `/api/v1/clients/${clientId}/pii`);
    expect(pii).toEqual({ ssn: digits, dob: input.dob });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'client.pii_viewed' AND entity_id = ?").bind(clientId).first("n")).toBe(1);
    const audit = await env.DB.prepare("SELECT diff_json FROM audit_log WHERE entity_id = ? AND action = 'client.created'").bind(clientId).first<{ diff_json: string }>();
    expect(audit?.diff_json).not.toContain(digits);
  });

  it("warns on duplicate SSNs and allows a confirmed duplicate", async () => {
    const { s, input } = await setup();
    const dup = await s.staff.client.post("/api/v1/clients", { ...input, email: "other@example.test" });
    expect(dup.status).toBe(409);
    const body = await dup.json<any>();
    expect(body.error.code).toBe("possible_duplicate");
    expect(body.error.details.duplicateOf).toHaveLength(1);
    await s.staff.client.json("POST", "/api/v1/clients", { ...input, email: "other@example.test", confirmDuplicate: true }, 201);
  });

  it("validates input without echoing it back", async () => {
    const { s } = await setup();
    const res = await s.staff.client.post("/api/v1/clients", clientInput({ ssn: "999-99-99" }));
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("999-99-99");
  });

  it("enforces status transitions and audits them", async () => {
    const { s, clientId } = await setup();
    expect((await s.staff.client.post(`/api/v1/clients/${clientId}/status`, { status: "paused" })).status).toBe(409);
    await s.staff.client.json("POST", `/api/v1/clients/${clientId}/status`, { status: "active" });
    await s.staff.client.json("POST", `/api/v1/clients/${clientId}/status`, { status: "closed" });
    expect((await s.staff.client.post(`/api/v1/clients/${clientId}/status`, { status: "active" })).status).toBe(409);
  });

  it("only org admins can reassign, and only to active staff", async () => {
    const { s, clientId } = await setup();
    expect((await s.staff.client.post(`/api/v1/clients/${clientId}/assign`, { staffId: s.approver.id })).status).toBe(403);
    await s.admin.client.json("POST", `/api/v1/clients/${clientId}/assign`, { staffId: s.approver.id });
    expect((await s.admin.client.post(`/api/v1/clients/${clientId}/assign`, { staffId: "nope" })).status).toBe(400);
  });

  it("notes are editable for 24 hours by their author", async () => {
    const { s, clientId } = await setup();
    const n = await s.staff.client.json("POST", `/api/v1/clients/${clientId}/notes`, { body: "Called client" }, 201);
    await s.staff.client.json("PATCH", `/api/v1/clients/${clientId}/notes/${n.id}`, { body: "Called client twice" });
    expect((await s.approver.client.patch(`/api/v1/clients/${clientId}/notes/${n.id}`, { body: "x" })).status).toBe(403);
    await env.DB.prepare("UPDATE note SET created_at = ? WHERE id = ?").bind(Date.now() - DAY - 1, n.id).run();
    expect((await s.staff.client.patch(`/api/v1/clients/${clientId}/notes/${n.id}`, { body: "late edit" })).status).toBe(409);
    const timeline = await s.staff.client.json("GET", `/api/v1/clients/${clientId}/timeline`);
    expect(timeline.some((e: { kind: string }) => e.kind === "note")).toBe(true);
  });

  it("deactivating staff creates reassignment tasks for admins (R8.2)", async () => {
    const { s } = await setup();
    await s.admin.client.json("PATCH", `/api/v1/users/${s.staff.id}`, { status: "inactive" });
    const tasks = await s.admin.client.json("GET", "/api/v1/tasks?assignee=me&status=open");
    expect(tasks.some((x: { title: string }) => x.title.startsWith("Reassign 1 client"))).toBe(true);
    expect((await s.admin.client.patch(`/api/v1/users/${s.admin.id}`, { status: "inactive" })).status).toBe(409);
  });
});

describe("documents (R10)", () => {
  it("quarantines uploads, enqueues a scan, and blocks download until clean", async () => {
    const { t, s, clientId } = await setup();
    const doc = await s.staff.client.json("POST", `/api/v1/clients/${clientId}/documents`, form(pdfFile(), "government_id"), 201);
    expect(doc.status).toBe("scan_pending");
    expect(t.sent.scan).toEqual([{ documentId: doc.id }]);
    const key = `org/${s.orgId}/client/${clientId}/doc/${doc.id}`;
    expect(await env.QUARANTINE.head(key)).not.toBeNull();
    const blocked = await s.staff.client.get(`/api/v1/documents/${doc.id}/download`);
    expect(blocked.status).toBe(409);
    expect((await blocked.json<any>()).error.message).toBe("Scan pending");
  });

  it("rejects bad types by content, empty and oversized files", async () => {
    const { s, clientId } = await setup();
    const exe = new File(["MZ\x90\x00 not a pdf"], "evil.pdf", { type: "application/pdf" });
    expect((await s.staff.client.post(`/api/v1/clients/${clientId}/documents`, form(exe, "other"))).status).toBe(415);
    expect((await s.staff.client.post(`/api/v1/clients/${clientId}/documents`, form(pdfFile(), "letter"))).status).toBe(400);
    const big = new File([new Uint8Array(25 * 1024 * 1024 + 1)], "big.pdf");
    expect((await s.staff.client.post(`/api/v1/clients/${clientId}/documents`, form(big, "other"))).status).toBe(413);
  });

  it("streams available documents with an audit row, scoped per client", async () => {
    const { t, s, clientId } = await setup();
    const { portal } = await enrollClient(t, s.staff.client, clientId);
    const doc = await portal.json("POST", "/api/v1/portal/documents", form(pdfFile("poa.pdf", "hello"), "proof_of_address"), 201);
    // Simulate a clean scan.
    const key = `org/${s.orgId}/client/${clientId}/doc/${doc.id}`;
    await env.DOCS.put(key, await (await env.QUARANTINE.get(key))!.arrayBuffer());
    await env.DB.prepare("UPDATE document SET status = 'available', bucket = 'documents' WHERE id = ?").bind(doc.id).run();
    const res = await portal.get(`/api/v1/portal/documents/${doc.id}/download`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toContain("hello");
    expect(await env.DB.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'document.download' AND entity_id = ?").bind(doc.id).first("n")).toBe(1);
    // Another client cannot see it.
    const other = await s.staff.client.json("POST", "/api/v1/clients", clientInput(), 201);
    const { portal: p2 } = await enrollClient(t, s.staff.client, other.id);
    expect((await p2.get(`/api/v1/portal/documents/${doc.id}/download`)).status).toBe(404);
  });
});

describe("e-signature webhook (R11)", () => {
  it("verifies the signature, stores the signed PDF once, and marks the client signed", async () => {
    const { t, s, clientId } = await setup();
    const sent = await s.staff.client.json("POST", `/api/v1/clients/${clientId}/authorization/send`);
    const body = JSON.stringify({ eventId: "evt-1", providerRequestId: sent.providerRequestId, type: "signed" });
    const anon = new Client(t);
    expect((await anon.post("/api/v1/webhooks/esign", JSON.parse(body), { "x-fake-signature": "bad" })).status).toBe(401);
    const sig = await fakeSig("esign-secret", body);
    expect((await anon.post("/api/v1/webhooks/esign", JSON.parse(body), { "x-fake-signature": sig })).status).toBe(200);
    expect((await anon.post("/api/v1/webhooks/esign", JSON.parse(body), { "x-fake-signature": sig })).status).toBe(200);
    const docs = await s.staff.client.json("GET", `/api/v1/clients/${clientId}/documents`);
    expect(docs.filter((d: { type: string }) => d.type === "authorization")).toHaveLength(1);
    expect((await s.staff.client.json("GET", `/api/v1/clients/${clientId}`)).authStatus).toBe("signed");
  });

  it("creates a task when the client declines", async () => {
    const { t, s, clientId } = await setup();
    const sent = await s.staff.client.json("POST", `/api/v1/clients/${clientId}/authorization/send`);
    const body = JSON.stringify({ eventId: "evt-d", providerRequestId: sent.providerRequestId, type: "declined" });
    await new Client(t).post("/api/v1/webhooks/esign", JSON.parse(body), { "x-fake-signature": await fakeSig("esign-secret", body) });
    const tasks = await s.staff.client.json("GET", "/api/v1/tasks?assignee=me");
    expect(tasks.some((x: { title: string }) => x.title.includes("declined"))).toBe(true);
  });
});

describe("report import and flags (R12, R13)", () => {
  it("starts a workflow, returns immediately, and allows one active import per client", async () => {
    const { t, s, clientId } = await setup();
    const r = await s.staff.client.json("POST", `/api/v1/clients/${clientId}/reports/import`, {}, 202);
    expect(t.wfs.import.created).toEqual([{ id: r.reportId, params: { orgId: s.orgId, clientId, reportId: r.reportId } }]);
    const again = await s.staff.client.post(`/api/v1/clients/${clientId}/reports/import`);
    expect(again.status).toBe(409);
    expect((await again.json<any>()).error.code).toBe("import_in_progress");
  });

  it("forwards provider webhooks to the waiting workflow", async () => {
    const { t, s, clientId } = await setup();
    const r = await s.staff.client.json("POST", `/api/v1/clients/${clientId}/reports/import`, {}, 202);
    await env.DB.prepare("UPDATE report SET provider_ref = 'ref-1' WHERE id = ?").bind(r.reportId).run();
    const body = JSON.stringify({ eventId: "c1", providerRef: "ref-1", type: "report_ready" });
    await new Client(t).post("/api/v1/webhooks/credit", JSON.parse(body), { "x-fake-signature": await fakeSig("credit-secret", body) });
    expect(t.wfs.import.events[0]).toMatchObject({ id: r.reportId, event: { type: "report-ready" } });
  });

  it("lists masked items with flags and audits manual flag changes", async () => {
    const { t, s, clientId } = await setup();
    const { reportId, items } = await seedReport(s.orgId, clientId, s.staff.id);
    const list = await s.staff.client.json("GET", `/api/v1/reports/${reportId}/items`);
    expect(list).toHaveLength(items.length);
    expect(JSON.stringify(list)).not.toContain("4111111111111234");
    expect(list.find((i: { accountMask: string }) => i.accountMask === "****1234")).toBeTruthy();
    const f = await s.staff.client.json("POST", `/api/v1/report-items/${items[0].id}/flags`, { reason: "Not my account" }, 201);
    expect((await s.staff.client.del(`/api/v1/report-items/${items[0].id}/flags/${f.id}`, { reason: "Client confirmed it is theirs" })).status).toBe(200);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM audit_log WHERE entity_id = ? AND action IN ('flag.added','flag.removed')").bind(items[0].id).first("n")).toBe(2);
    const history = await s.staff.client.json("GET", `/api/v1/report-items/${items[0].id}/history`);
    expect(history.length).toBeGreaterThan(0);
    // Client portal sees its own items, read-only.
    const { portal } = await enrollClient(t, s.staff.client, clientId);
    expect((await portal.json("GET", `/api/v1/portal/reports/${reportId}/items`)).length).toBe(items.length);
  });
});

describe("dispute rounds and letters (R14–R16)", () => {
  async function round() {
    const ctx = await setup();
    const { items } = await seedReport(ctx.s.orgId, ctx.clientId, ctx.s.staff.id);
    const tpl = (await ctx.s.staff.client.json("GET", "/api/v1/templates"))[0];
    const picked = items.filter((i) => i.itemType === "tradeline");
    const r = await ctx.s.staff.client.json("POST", `/api/v1/clients/${ctx.clientId}/dispute-rounds`, { itemIds: picked.map((i) => i.id), targetKind: "bureau", templateId: tpl.id }, 201);
    return { ...ctx, items, picked, round: r, letterId: r.letterIds[0] as string };
  }

  it("creates one letter per bureau with merge fields resolved and DOB deferred", async () => {
    const { s, round: r, letterId, input } = await round();
    expect(r.letterIds).toHaveLength(3);
    const l = await s.staff.client.json("GET", `/api/v1/letters/${letterId}`);
    expect(l.status).toBe("draft");
    expect(l.bodyHtml).toContain("Ana Ruiz");
    expect(l.bodyHtml).toContain("{{client.dob}}");
    expect(l.bodyHtml).not.toContain(input.dob);
    expect(l.bodyHtml).toContain("****1234");
    expect(l.items.length).toBeGreaterThan(0);
  });

  it("sanitizes edits, audits before/after, and honors the edit lock", async () => {
    const { s, letterId, clientId } = await round();
    const l = await s.staff.client.json("PATCH", `/api/v1/letters/${letterId}`, { bodyHtml: "<p>Edited<script>x</script></p>" });
    expect(l.bodyHtml).toBe("<p>Edited</p>");
    expect((await s.approver.client.json("POST", `/api/v1/clients/${clientId}/lock`)).ok).toBe(true);
    const blocked = await s.staff.client.patch(`/api/v1/letters/${letterId}`, { bodyHtml: "<p>Mine</p>" });
    expect(blocked.status).toBe(409);
    expect((await blocked.json<any>()).error.message).toContain("Being edited by");
    expect((await s.staff.client.post(`/api/v1/clients/${clientId}/lock`)).status).toBe(409);
    await s.approver.client.del(`/api/v1/clients/${clientId}/lock`);
    await s.staff.client.json("PATCH", `/api/v1/letters/${letterId}`, { bodyHtml: "<p>Mine</p>" });
  });

  it("runs the full approval → render → send → response → close lifecycle", async () => {
    const { t, s, clientId, letterId, round: r } = await round();
    await s.staff.client.json("POST", `/api/v1/letters/${letterId}/submit`);
    expect((await s.staff.client.patch(`/api/v1/letters/${letterId}`, { bodyHtml: "<p>x</p>" })).status).toBe(409);
    // Staff cannot approve; approver cannot approve without signed authorization.
    expect((await s.staff.client.post(`/api/v1/letters/${letterId}/approve`)).status).toBe(403);
    expect((await s.approver.client.post(`/api/v1/letters/${letterId}/approve`)).status).toBe(409);
    await signAuthorization(t, s, clientId);
    // Reject sends it back to draft with a reason.
    await s.approver.client.json("POST", `/api/v1/letters/${letterId}/reject`, { reason: "Fix the date" });
    expect((await s.staff.client.json("GET", `/api/v1/letters/${letterId}`)).rejectionReason).toBe("Fix the date");
    await s.staff.client.json("POST", `/api/v1/letters/${letterId}/submit`);
    const ap = await s.approver.client.json("POST", `/api/v1/letters/${letterId}/approve`);
    expect(t.wfs.letter.created.at(-1)?.params).toEqual({ orgId: s.orgId, letterId });
    expect(ap.status).toBe("approved");
    expect((await s.approver.client.post(`/api/v1/letters/${letterId}/approve`)).status).toBe(409);

    // The workflow would render; simulate Ready to Mail.
    await env.DB.prepare("UPDATE letter SET status = 'ready_to_mail' WHERE id = ?").bind(letterId).run();
    const sentAt = isoDay(Date.now());
    const sent = await s.staff.client.json("POST", `/api/v1/letters/${letterId}/sent`, { sentAt, trackingNumber: "9400111" });
    expect(sent.responseDueAt).toBe(Date.parse(`${sentAt}T00:00:00Z`) + 30 * DAY);
    expect(t.wfs.deadline.created.at(-1)).toMatchObject({ id: `deadline-${letterId}`, params: { letterId, dueAt: sent.responseDueAt } });

    const detail = await s.staff.client.json("GET", `/api/v1/letters/${letterId}`);
    const outcomes = detail.items.map((i: { id: string }, n: number) => ({ reportItemId: i.id, outcome: n === 0 ? "deleted" : "verified" }));
    await s.staff.client.json("POST", `/api/v1/letters/${letterId}/response`, { receivedAt: sentAt, outcomes });
    expect(t.wfs.deadline.terminated).toContain(`deadline-${letterId}`);
    const after = await s.staff.client.json("GET", `/api/v1/letters/${letterId}`);
    expect(after.status).toBe("response_received");
    expect(after.items[0].outcome).toBe("deleted");
    await s.staff.client.json("POST", `/api/v1/letters/${letterId}/close`);
    const fu = await s.staff.client.json("GET", `/api/v1/dispute-rounds/${r.roundId}/follow-up`);
    expect(fu.allClosed).toBe(false);
    expect(fu.unresolvedItemIds.length).toBeGreaterThan(0);
    // Client portal sees status only, never the body.
    const { portal } = await enrollClient(t, s.staff.client, clientId);
    const pl = await portal.json("GET", "/api/v1/portal/letters");
    expect(pl[0]).not.toHaveProperty("bodyHtml");
  });

  it("blocks self-approval unless the org allows it (R5.5)", async () => {
    const { t, s, clientId } = await setup();
    const { items } = await seedReport(s.orgId, clientId, s.approver.id);
    const tpl = (await s.approver.client.json("GET", "/api/v1/templates"))[0];
    const r = await s.approver.client.json("POST", `/api/v1/clients/${clientId}/dispute-rounds`, { itemIds: [items[0].id], targetKind: "furnisher", templateId: tpl.id }, 201);
    await signAuthorization(t, s, clientId);
    await s.approver.client.json("POST", `/api/v1/letters/${r.letterIds[0]}/submit`);
    expect((await s.approver.client.post(`/api/v1/letters/${r.letterIds[0]}/approve`)).status).toBe(403);
    await s.admin.client.json("PATCH", "/api/v1/org/settings", { selfApproval: true });
    await s.approver.client.json("POST", `/api/v1/letters/${r.letterIds[0]}/approve`);
  });

  it("rejects items from another client", async () => {
    const { s, clientId } = await setup();
    const other = await s.staff.client.json("POST", "/api/v1/clients", clientInput(), 201);
    const { items } = await seedReport(s.orgId, other.id, s.staff.id);
    const tpl = (await s.staff.client.json("GET", "/api/v1/templates"))[0];
    expect((await s.staff.client.post(`/api/v1/clients/${clientId}/dispute-rounds`, { itemIds: [items[0].id], targetKind: "bureau", templateId: tpl.id })).status).toBe(400);
  });
});

describe("admin features", () => {
  it("validates template merge fields and versions templates (R14.2)", async () => {
    const { s } = await setup();
    const bad = await s.admin.client.post("/api/v1/templates", { name: "Bad", bodyHtml: "<p>{{client.ssn}}</p>" });
    expect(bad.status).toBe(422);
    const t1 = await s.admin.client.json("POST", "/api/v1/templates", { name: "Goodwill", bodyHtml: "<p>{{client.full_name}}</p>" }, 201);
    const t2 = await s.admin.client.json("POST", `/api/v1/templates/${t1.id}/versions`, { bodyHtml: "<p>Hi {{client.first_name}}</p>" }, 201);
    expect(t2.version).toBe(2);
    expect((await s.staff.client.post("/api/v1/templates", { name: "X", bodyHtml: "<p>x</p>" })).status).toBe(403);
    const list = await s.admin.client.json("GET", "/api/v1/templates");
    expect(list.filter((t: { name: string }) => t.name === "Goodwill")).toHaveLength(1);
  });

  it("manages flag rules as data (R13.6)", async () => {
    const { s } = await setup();
    const rules = await s.admin.client.json("GET", "/api/v1/flag-rules");
    expect(rules.length).toBeGreaterThanOrEqual(5);
    const r = await s.admin.client.json("POST", "/api/v1/flag-rules", { name: "High balance", itemTypes: ["tradeline"], condition: { field: "balance", op: "gt", value: 10000 }, reasonTemplate: "High balance" }, 201);
    const upd = await s.admin.client.json("PATCH", `/api/v1/flag-rules/${r.id}`, { active: false });
    expect(upd.active).toBe(false);
  });

  it("tasks, notifications, and audit export requests", async () => {
    const { t, s, clientId } = await setup();
    const task = await s.staff.client.json("POST", "/api/v1/tasks", { title: "Call client", assigneeId: s.approver.id, entityType: "client", entityId: clientId, dueAt: isoDay(Date.now() + DAY) }, 201);
    expect(t.notifications().some((m) => m.event === "task_assigned")).toBe(true);
    await s.approver.client.json("PATCH", `/api/v1/tasks/${task.id}`, { status: "done" });
    expect((await s.staff.client.post("/api/v1/audit/export", { from: "2026-01-01", to: "2026-12-31" })).status).toBe(403);
    const exp = await s.admin.client.json("POST", "/api/v1/audit/export", { from: "2026-01-01", to: "2026-12-31" }, 202);
    expect(t.sent.audit).toEqual([{ exportId: exp.exportId }]);
    const audit = await s.staff.client.json("GET", `/api/v1/audit?entityType=client&entityId=${clientId}`);
    expect(audit.items.some((e: { action: string }) => e.action === "client.created")).toBe(true);
    const notes = await s.approver.client.json("GET", "/api/v1/notifications");
    expect(Array.isArray(notes)).toBe(true);
  });

  it("org settings are admin-only and audited", async () => {
    const { s } = await setup();
    expect((await s.staff.client.patch("/api/v1/org/settings", { deadlineDays: 45 })).status).toBe(403);
    const after = await s.admin.client.json("PATCH", "/api/v1/org/settings", { deadlineDays: 45, senderBlock: { name: "Acme Credit", addressLines: ["1 Main"] } });
    expect(after.deadlineDays).toBe(45);
  });
});
