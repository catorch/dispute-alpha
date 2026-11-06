import { env } from "cloudflare:test";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { letters, reports, tasks } from "@da/db";
import { FakeCreditProvider } from "@da/providers";
import { DAY } from "@da/shared";
import { runDisputeDeadline } from "../src/workflows/dispute-deadline";
import { runLetterPipeline } from "../src/workflows/letter-pipeline";
import { MAX_WAIT_ROUNDS, runReportImport } from "../src/workflows/report-import";
import { db, fakeStep, makeEnv, seedClient, seedLetter } from "./helpers";

describe("ReportImportWorkflow (R12, R13)", () => {
  it("imports, encrypts the raw payload, parses per bureau, flags, and notifies", async () => {
    const t = makeEnv();
    const s = await seedClient(t.env);
    const rep = await reports.createReport(db(), s.orgId, s.clientId, "fake", s.staffId);
    const { step, log } = fakeStep();
    const out = await runReportImport(t.env, { orgId: s.orgId, clientId: s.clientId, reportId: rep.id }, step, new FakeCreditProvider());
    expect(out).toMatchObject({ items: expect.any(Number), flagged: expect.any(Number) });
    const after = await reports.getReport(db(), s.orgId, rep.id);
    expect(after?.status).toBe("complete");
    // Raw payload in R2 is ciphertext.
    const raw = await env.REPORTS_RAW.get(after?.rawObjectKey ?? "");
    expect(new TextDecoder().decode(await raw!.arrayBuffer())).not.toContain("Capital Bank");
    // Items per bureau, full account numbers encrypted.
    const items = await reports.itemsForReport(db(), s.orgId, rep.id);
    expect(new Set(items.map((i) => i.bureau))).toEqual(new Set(["equifax", "experian", "transunion"]));
    expect(JSON.stringify(items)).not.toContain("4111111111111234");
    // Default rules flag the zero-balance collection, old late, hard inquiry, bureau mismatch, personal info mismatch, old public record.
    const flags = await reports.flagsForItems(db(), s.orgId, items.map((i) => i.id));
    const reasons = flags.map((f) => f.reason).join("|");
    for (const frag of ["$0 balance", "7-year", "Hard inquiry", "differently across bureaus", "Personal information", "obsolete"]) expect(reasons).toContain(frag);
    expect(log.filter((l) => l[0] === "do" && String(l[1]).startsWith("parse-"))).toHaveLength(3);
    expect(t.notified.map((m) => m.recipient.kind).sort()).toEqual(["client", "staff"]);
  });

  it("retries a failing provider step without restarting the import (R12.5)", async () => {
    const t = makeEnv();
    const s = await seedClient(t.env);
    const rep = await reports.createReport(db(), s.orgId, s.clientId, "fake", s.staffId);
    const { step, attempts } = fakeStep();
    await runReportImport(t.env, { orgId: s.orgId, clientId: s.clientId, reportId: rep.id }, step, new FakeCreditProvider({ failRequests: 2 }));
    expect(attempts.get("request")).toBe(3);
    expect(attempts.get("parse-equifax")).toBe(1);
    expect((await reports.getReport(db(), s.orgId, rep.id))?.status).toBe("complete");
  });

  it("waits for the provider webhook or polls, then continues", async () => {
    const t = makeEnv();
    const s = await seedClient(t.env);
    const rep = await reports.createReport(db(), s.orgId, s.clientId, "fake", s.staffId);
    const { step, log } = fakeStep(() => ({ payload: {} }));
    await runReportImport(t.env, { orgId: s.orgId, clientId: s.clientId, reportId: rep.id }, step, new FakeCreditProvider({ pendingPolls: 2 }));
    expect(log.filter((l) => l[0] === "wait")).toHaveLength(2);
    expect((await reports.getReport(db(), s.orgId, rep.id))?.status).toBe("complete");
  });

  it("re-running a parse step does not duplicate items", async () => {
    const t = makeEnv();
    const s = await seedClient(t.env);
    const rep = await reports.createReport(db(), s.orgId, s.clientId, "fake", s.staffId);
    await runReportImport(t.env, { orgId: s.orgId, clientId: s.clientId, reportId: rep.id }, fakeStep().step, new FakeCreditProvider());
    const n1 = (await reports.itemsForReport(db(), s.orgId, rep.id)).length;
    await runReportImport(t.env, { orgId: s.orgId, clientId: s.clientId, reportId: rep.id }, fakeStep().step, new FakeCreditProvider());
    expect((await reports.itemsForReport(db(), s.orgId, rep.id)).length).toBe(n1);
  });

  it("fails after the 24-hour window with a task and notification (R12.6)", async () => {
    const t = makeEnv();
    const s = await seedClient(t.env);
    const rep = await reports.createReport(db(), s.orgId, s.clientId, "fake", s.staffId);
    const { step, log } = fakeStep();
    const out = await runReportImport(t.env, { orgId: s.orgId, clientId: s.clientId, reportId: rep.id }, step, new FakeCreditProvider({ pendingPolls: 10_000 }));
    expect(out).toEqual({ failed: true });
    expect(log.filter((l) => l[0] === "wait")).toHaveLength(MAX_WAIT_ROUNDS);
    const r = await reports.getReport(db(), s.orgId, rep.id);
    expect(r?.status).toBe("failed");
    expect(r?.error).toContain("24 hours");
    expect((await tasks.listTasks(db(), s.orgId, { assigneeId: s.staffId })).some((x) => x.title.includes("import failed"))).toBe(true);
    expect(t.notified.some((m) => m.event === "import_failed")).toBe(true);
  });
});

async function onePagePdf(text = "body") {
  const d = await PDFDocument.create();
  d.addPage([612, 792]).drawText(text, { x: 72, y: 700 });
  return d.save();
}

describe("LetterPipelineWorkflow (R15)", () => {
  it("renders via the queue, merges attachments, stores the PDF, and marks Ready to Mail", async () => {
    const t = makeEnv();
    const s = await seedLetter(t.env, "approved");
    const bodyKey = `tmp/${s.letterId}.pdf`;
    await env.LETTERS.put(bodyKey, await onePagePdf());
    // An attached clean PDF document.
    const attKey = `org/${s.orgId}/client/${s.clientId}/doc/att1`;
    await env.DOCS.put(attKey, await onePagePdf("id"));
    await db().run(
      // biome-ignore lint: test fixture
      (await import("drizzle-orm")).sql`INSERT INTO document (id, org_id, client_id, type, status, bucket, object_key, filename, mime, size, encrypted, uploaded_by_kind, created_at) VALUES ('att1', ${s.orgId}, ${s.clientId}, 'proof_of_address', 'available', 'documents', ${attKey}, 'poa.pdf', 'application/pdf', 100, 0, 'client', ${Date.now()})`,
    );
    await letters.setAttachments(db(), s.letterId, ["att1"]);
    const { step } = fakeStep(() => ({ payload: { ok: true, key: bodyKey } }));
    const out = await runLetterPipeline(t.env, { orgId: s.orgId, letterId: s.letterId }, "inst-1", step);
    expect(t.pdfQueue).toEqual([{ letterId: s.letterId, instanceId: "inst-1" }]);
    const l = await letters.getLetter(db(), s.orgId, s.letterId);
    expect(l?.status).toBe("ready_to_mail");
    expect(l?.pdfDocumentId).toBe((out as { documentId: string }).documentId);
    const doc = await db().run((await import("drizzle-orm")).sql`SELECT object_key FROM document WHERE id = ${l?.pdfDocumentId}`);
    const key = (doc.results[0] as { object_key: string }).object_key;
    const merged = await PDFDocument.load(new Uint8Array(await (await env.LETTERS.get(key))!.arrayBuffer()));
    expect(merged.getPageCount()).toBe(2);
    expect(t.notified.some((m) => m.event === "letter_ready")).toBe(true);
  });

  it("marks render_failed when the render never arrives", async () => {
    const t = makeEnv();
    const s = await seedLetter(t.env, "approved");
    const out = await runLetterPipeline(t.env, { orgId: s.orgId, letterId: s.letterId }, "inst-2", fakeStep().step);
    expect(out).toEqual({ failed: true });
    expect((await letters.getLetter(db(), s.orgId, s.letterId))?.status).toBe("render_failed");
    expect(t.notified.some((m) => m.event === "render_failed")).toBe(true);
  });

  it("skips letters that are no longer approved", async () => {
    const t = makeEnv();
    const s = await seedLetter(t.env, "sent");
    expect(await runLetterPipeline(t.env, { orgId: s.orgId, letterId: s.letterId }, "inst-3", fakeStep().step)).toEqual({ skipped: true });
  });
});

describe("DisputeDeadlineWorkflow (R16)", () => {
  it("reminds at 7 and 3 days, then flags overdue with a task", async () => {
    const t = makeEnv();
    const due = Date.now() + 30 * DAY;
    const s = await seedLetter(t.env, "sent", due);
    const { step, log } = fakeStep();
    expect(await runDisputeDeadline(t.env, { orgId: s.orgId, letterId: s.letterId, dueAt: due }, step)).toEqual({ overdue: true });
    expect(log.filter((l) => l[0] === "sleepUntil")).toEqual([
      ["sleepUntil", "until-minus-7d", due - 7 * DAY],
      ["sleepUntil", "until-minus-3d", due - 3 * DAY],
      ["sleepUntil", "until-due", due],
    ]);
    expect(t.notified.filter((m) => m.event === "deadline_reminder").map((m) => m.vars?.days)).toEqual([7, 3]);
    expect((await letters.getLetter(db(), s.orgId, s.letterId))?.status).toBe("overdue");
    expect((await tasks.listTasks(db(), s.orgId, { entityType: "letter", entityId: s.letterId })).length).toBe(1);
    expect(t.notified.filter((m) => m.event === "letter_overdue").map((m) => m.recipient.kind).sort()).toEqual(["client", "staff"]);
  });

  it("does nothing once a response is logged", async () => {
    const t = makeEnv();
    const due = Date.now() + 30 * DAY;
    const s = await seedLetter(t.env, "sent", due);
    await letters.setLetterFields(db(), s.letterId, { status: "response_received" });
    expect(await runDisputeDeadline(t.env, { orgId: s.orgId, letterId: s.letterId, dueAt: due }, fakeStep().step)).toEqual({ overdue: false });
    expect(t.notified).toHaveLength(0);
  });

  it("skips reminders that are already in the past", async () => {
    const t = makeEnv();
    const due = Date.now() + 2 * DAY;
    const s = await seedLetter(t.env, "sent", due);
    const { step, log } = fakeStep();
    await runDisputeDeadline(t.env, { orgId: s.orgId, letterId: s.letterId, dueAt: due }, step);
    expect(log.filter((l) => l[0] === "sleepUntil").map((l) => l[1])).toEqual(["until-due"]);
  });
});
