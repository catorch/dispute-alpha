import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { clients, orgs, parseJson, reports, tasks } from "@da/db";
import { type CreditProvider, type RawReport, normalizeBureau } from "@da/providers";
import { type Address, BUREAUS, type FlagCondition, evaluateRules } from "@da/shared";
import type { Env, ImportParams } from "../env";
import { creditProvider, dbFor, fieldCrypto, link, metric, notify, opsAlert } from "../lib/services";

/** 144 rounds × 10 minutes = the 24 hour provider window (R12.6). */
export const MAX_WAIT_ROUNDS = 144;
const RETRY = { retries: { limit: 5, delay: "30 seconds" as const, backoff: "exponential" as const }, timeout: "5 minutes" as const };

/**
 * request → poll or wait for webhook → store encrypted raw payload → parse per bureau → flag → notify.
 * Each step retries on its own, so a provider timeout does not restart the import (R12.5).
 */
export async function runReportImport(env: Env, p: ImportParams, step: WorkflowStep, provider: CreditProvider = creditProvider(env)) {
  const db = dbFor(env);
  const fc = fieldCrypto(env);
  try {
    const providerRef = await step.do("request", RETRY, async () => {
      const client = await clients.getClientRow(db, p.orgId, p.clientId);
      if (!client) throw new Error("client not found");
      const pii = await clients.getClientPii(db, fc, p.orgId, p.clientId);
      if (!pii) throw new Error("client not found");
      const address = parseJson<Address>(client.addressJson, { line1: "", city: "", state: "", zip: "" });
      const { providerRef } = await provider.requestReport({ firstName: client.firstName, lastName: client.lastName, ssn: pii.ssn, dob: pii.dob, address }, p.reportId);
      await reports.updateReport(db, p.reportId, { status: "waiting", providerRef });
      return providerRef;
    });

    let rawKey: string | null = null;
    for (let i = 0; i < MAX_WAIT_ROUNDS && !rawKey; i++) {
      rawKey = await step.do(`fetch-${i}`, RETRY, async () => {
        const raw = await provider.fetchReport(providerRef);
        if (raw === "pending") return null;
        // Raw payloads are encrypted before they reach R2 (R12.3).
        const key = `org/${p.orgId}/client/${p.clientId}/report/${p.reportId}.json.enc`;
        await env.REPORTS_RAW.put(key, await fc.encryptBytes(`report:${p.reportId}`, new TextEncoder().encode(JSON.stringify(raw))));
        await reports.updateReport(db, p.reportId, { rawObjectKey: key, status: "parsing" });
        return key;
      });
      if (!rawKey) {
        try {
          await step.waitForEvent(`wait-${i}`, { type: "report-ready", timeout: "10 minutes" });
        } catch {
          // Timed out: poll again.
        }
      }
    }
    if (!rawKey) throw new ImportFailure("The credit provider did not return a report within 24 hours");

    let total = 0;
    for (const bureau of BUREAUS) {
      total += await step.do(`parse-${bureau}`, RETRY, async () => {
        const obj = await env.REPORTS_RAW.get(rawKey as string);
        if (!obj) throw new Error("raw report missing");
        const raw = JSON.parse(new TextDecoder().decode(await fc.decryptBytes(`report:${p.reportId}`, await obj.arrayBuffer()))) as RawReport;
        const items = await normalizeBureau(raw, bureau);
        await reports.deleteItemsForBureau(db, p.reportId, bureau);
        return reports.insertItems(db, fc, { orgId: p.orgId, reportId: p.reportId, clientId: p.clientId }, items);
      });
    }

    const flagged = await step.do("flag", RETRY, async () => {
      await reports.updateReport(db, p.reportId, { status: "flagging" });
      const [rules, items, client] = await Promise.all([reports.activeRules(db, p.orgId), reports.itemsForReport(db, p.orgId, p.reportId), clients.getClientRow(db, p.orgId, p.clientId)]);
      if (!client) throw new Error("client not found");
      const hits = evaluateRules(
        rules.map((r) => ({ ...r, condition: r.condition as FlagCondition | null })),
        items.map((i) => ({ ...i, details: parseJson<Record<string, unknown>>(i.detailsJson, {}) })),
        { firstName: client.firstName, lastName: client.lastName, address: parseJson<Address>(client.addressJson, { line1: "", city: "", state: "", zip: "" }) },
      );
      await reports.deleteRuleFlags(db, p.orgId, items.map((i) => i.id));
      await reports.insertFlags(db, p.orgId, hits.map((h) => ({ ...h, source: "rule" as const })));
      return new Set(hits.map((h) => h.itemId)).size;
    });

    await step.do("complete", RETRY, async () => {
      await reports.updateReport(db, p.reportId, { status: "complete", completedAt: Date.now(), error: null });
      const client = await clients.getClientRow(db, p.orgId, p.clientId);
      const msgs = [];
      if (client?.assignedStaffId)
        msgs.push({ id: `report:${p.reportId}:staff`, orgId: p.orgId, recipient: { kind: "staff" as const, id: client.assignedStaffId }, event: "report_ready" as const, vars: { link: link(env, `/admin/clients/${p.clientId}?tab=reports`) } });
      msgs.push({ id: `report:${p.reportId}:client`, orgId: p.orgId, recipient: { kind: "client" as const, id: p.clientId }, event: "report_ready" as const, vars: { link: link(env, "/portal/reports") } });
      await notify(env, msgs);
      metric(env, "import_completed", p.orgId);
      return true;
    });
    return { items: total, flagged };
  } catch (e) {
    await step.do("fail", async () => {
      await failImport(env, p, e instanceof ImportFailure ? e.message : "The import failed after several retries");
      return true;
    });
    return { failed: true };
  }
}

class ImportFailure extends Error {}

/** Marks the import failed, creates a task, notifies staff, and alerts ops (R12.6, R22.3). */
export async function failImport(env: Env, p: ImportParams, reason: string) {
  const db = dbFor(env);
  await reports.updateReport(db, p.reportId, { status: "failed", error: reason, completedAt: Date.now() });
  const client = await clients.getClientRow(db, p.orgId, p.clientId);
  const assignee = client?.assignedStaffId ?? (await orgs.orgAdmins(db, p.orgId))[0]?.id;
  if (assignee) {
    await tasks.createTask(db, p.orgId, { title: "Credit report import failed: retry or contact the provider", assigneeId: assignee, entityType: "client", entityId: p.clientId, createdByKind: "system", dedupeKey: `import-failed:${p.reportId}` });
    await notify(env, { id: `import-failed:${p.reportId}`, orgId: p.orgId, recipient: { kind: "staff", id: assignee }, event: "import_failed", vars: { link: link(env, `/admin/clients/${p.clientId}?tab=reports`) } });
  }
  metric(env, "import_failed", p.orgId);
  await opsAlert(env, "Report import failed", `report=${p.reportId} reason=${reason}`);
}

export class ReportImportWorkflow extends WorkflowEntrypoint<Env, ImportParams> {
  async run(event: Readonly<WorkflowEvent<ImportParams>>, step: WorkflowStep) {
    return runReportImport(this.env, event.payload, step);
  }
}
