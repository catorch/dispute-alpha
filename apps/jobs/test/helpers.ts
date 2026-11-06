import { env as baseEnv } from "cloudflare:workers";
import type { WorkflowStep } from "cloudflare:workers";
import { clients, getDb, letters, orgs, reports } from "@da/db";
import { fakeReport, normalizeBureau } from "@da/providers";
import { BUREAUS, type NotifyMessage } from "@da/shared";
import type { Env } from "../src/env";
import { fieldCrypto } from "../src/lib/services";

export const db = () => getDb(baseEnv.DB);

export function makeEnv(over: Partial<Env> = {}) {
  const notified: NotifyMessage[] = [];
  const pdfQueue: unknown[] = [];
  const events: { id: string; event: unknown }[] = [];
  const env = {
    ...(baseEnv as unknown as Env),
    Q_NOTIFY: { send: async (b: NotifyMessage) => void notified.push(b), sendBatch: async (bs: { body: NotifyMessage }[]) => void notified.push(...bs.map((b) => b.body)) } as unknown as Queue<NotifyMessage>,
    Q_PDF: { send: async (b: unknown) => void pdfQueue.push(b) } as unknown as Queue,
    WF_LETTER: { get: async (id: string) => ({ sendEvent: async (event: unknown) => void events.push({ id, event }) }) } as unknown as Workflow,
    ...over,
  } as Env;
  return { env, notified, pdfQueue, events };
}

/**
 * Deterministic stand-in for WorkflowStep: runs steps inline, honoring `retries.limit`,
 * records sleeps, and lets each test decide what waitForEvent returns or throws.
 */
export function fakeStep(onWait: (name: string) => unknown = () => {
  throw new Error("timeout");
}) {
  const log: (string | number)[][] = [];
  const attempts = new Map<string, number>();
  const step = {
    do: async (name: string, a: unknown, b?: unknown) => {
      const fn = (typeof a === "function" ? a : b) as (ctx: unknown) => Promise<unknown>;
      const limit = typeof a === "function" ? 0 : ((a as { retries?: { limit?: number } })?.retries?.limit ?? 0);
      for (let i = 0; ; i++) {
        attempts.set(name, i + 1);
        try {
          log.push(["do", name]);
          return await fn({ attempt: i + 1 });
        } catch (e) {
          if (i >= limit) throw e;
        }
      }
    },
    sleep: async (name: string) => void log.push(["sleep", name]),
    sleepUntil: async (name: string, ts: Date | number) => void log.push(["sleepUntil", name, +ts]),
    waitForEvent: async (name: string) => {
      log.push(["wait", name]);
      return onWait(name);
    },
  };
  return { step: step as unknown as WorkflowStep, log, attempts };
}

let n = 0;
export async function seedClient(env: Env) {
  const i = ++n;
  const { orgId, adminId } = await orgs.createOrg(db(), `Org ${i}`, { email: `admin${i}@jobs.test`, displayName: `Admin ${i}` });
  const staff = await orgs.createUser(db(), orgId, { email: `staff${i}@jobs.test`, displayName: `Staff ${i}`, role: "staff" });
  const clientId = await clients.createClient(db(), fieldCrypto(env), orgId, {
    firstName: "Ana",
    lastName: "Ruiz",
    email: `ana${i}@example.test`,
    phone: "+15125550100",
    dob: "1985-03-14",
    ssn: `12345${String(1000 + i).slice(-4)}`,
    address: { line1: "1 Main St", city: "Austin", state: "TX", zip: "78701" },
    assignedStaffId: staff.id,
  });
  return { orgId, adminId, staffId: staff.id, clientId };
}

/** A sent letter for deadline / response tests, with a signed lock and a body containing the DOB token. */
export async function seedLetter(env: Env, status: "approved" | "rendering" | "sent" = "sent", dueAt = Date.now() + 30 * 864e5) {
  const s = await seedClient(env);
  const rep = await reports.createReport(db(), s.orgId, s.clientId, "fake", s.staffId);
  for (const b of BUREAUS) await reports.insertItems(db(), fieldCrypto(env), { orgId: s.orgId, reportId: rep.id, clientId: s.clientId }, await normalizeBureau(fakeReport("r", "Ruiz", "78701"), b));
  const items = await reports.itemsForReport(db(), s.orgId, rep.id);
  const tpl = (await letters.listTemplates(db(), s.orgId))[0];
  const r = await letters.createRound(db(), s.orgId, s.clientId, s.staffId, [
    { targetKind: "bureau", targetName: "Equifax Information Services LLC", templateId: tpl.id, templateVersion: 1, bodyHtml: "<p>Ana Ruiz</p><p>DOB: {{client.dob}}</p>", items: [{ reportItemId: items[0].id, reason: "x" }] },
  ]);
  const letterId = r.letterIds[0];
  await letters.setLetterFields(db(), letterId, { status, lockedAt: Date.now(), sentAt: status === "sent" ? Date.now() : null, responseDueAt: status === "sent" ? dueAt : null });
  return { ...s, letterId, reportId: rep.id };
}
