import { auth as authRepo, documents, letters, ops, orgs, reports } from "@da/db";
import { readSecret } from "@da/crypto";
import { DAY, isoDay } from "@da/shared";
import type { Env } from "./env";
import { buildAuditCsv } from "./queues";
import { markOverdue } from "./lib/letters";
import { dbFor, fieldCrypto, link, metric, notify, opsAlert } from "./lib/services";
import { failImport } from "./workflows/report-import";

const HOUR = 3600_000;
export const D1_SIZE_ALERT_BYTES = 5 * 1024 ** 3;

/** R16.6 safety net: any letter still "sent" past its due date becomes overdue. */
export async function overdueSweep(env: Env, now = Date.now()) {
  let n = 0;
  for (const l of await letters.overdueCandidates(dbFor(env), now)) if (await markOverdue(env, l.orgId, l.id)) n++;
  return n;
}

/** Imports stuck past 24 hours (lost workflow instance) are failed with a task (R12.6). */
export async function failStaleImports(env: Env, now = Date.now()) {
  const stale = await reports.staleWaitingReports(dbFor(env), now - 24 * HOUR - HOUR);
  for (const r of stale) await failImport(env, { orgId: r.orgId, clientId: r.clientId, reportId: r.id }, "The import did not finish within 24 hours");
  return stale.length;
}

/** Alerts if any upload has waited more than an hour for a scan (scanner down, R23.4). */
export async function scanBacklogCheck(env: Env, now = Date.now()) {
  const n = await documents.countByStatusBefore(dbFor(env), "scan_pending", now - HOUR);
  if (n > 0) await opsAlert(env, "Virus scanner backlog", `${n} upload(s) have been waiting more than 1 hour for a scan. Check the ClamAV container.`);
  return n;
}

/** R17.3: one digest per staff member who has something to look at. */
export async function dailyDigest(env: Env, now = Date.now()) {
  const db = dbFor(env);
  let sent = 0;
  for (const org of await orgs.allOrgs(db)) {
    const counts = await ops.digestCounts(env.DB, org.id, now - DAY);
    for (const s of await orgs.activeStaff(db, org.id)) {
      const c = { tasks: counts.tasks.get(s.id) ?? 0, overdue: counts.overdue.get(s.id) ?? 0, uploads: counts.uploads.get(s.id) ?? 0 };
      if (!c.tasks && !c.overdue && !c.uploads) continue;
      await notify(env, { id: `digest:${s.id}:${isoDay(now)}`, orgId: org.id, recipient: { kind: "staff", id: s.id }, event: "daily_digest", vars: { counts: c, link: link(env, "/admin") }, channels: ["email"] });
      sent++;
    }
    metric(env, "overdue_count", org.id, await ops.overdueCount(env.DB, org.id));
  }
  return sent;
}

/**
 * Nightly D1 export to R2 for retention beyond Time Travel's 30 days (R21.2), using the D1 REST
 * export API (start, poll, then copy the signed URL into the backups bucket).
 */
export async function d1Export(env: Env, now = Date.now(), fetcher: typeof fetch = fetch, wait = (ms: number) => scheduler.wait(ms)) {
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN || !env.D1_DATABASE_ID) {
    if (env.APP_ENV === "production" || env.APP_ENV === "staging") await opsAlert(env, "D1 export not configured", "Set CF_ACCOUNT_ID, CF_API_TOKEN and D1_DATABASE_ID on da-jobs.");
    return null;
  }
  const token = await readSecret(env.CF_API_TOKEN);
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/d1/database/${env.D1_DATABASE_ID}/export`;
  let bookmark: string | undefined;
  for (let i = 0; i < 60; i++) {
    const res = await fetcher(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ output_format: "polling", ...(bookmark ? { current_bookmark: bookmark } : {}) }) });
    const j = (await res.json()) as { success: boolean; result?: { at_bookmark?: string; status?: string; error?: string; result?: { signed_url?: string } }; errors?: unknown };
    if (!j.success || j.result?.status === "error") throw new Error(`D1 export failed: ${JSON.stringify(j.errors ?? j.result?.error)}`);
    bookmark = j.result?.at_bookmark ?? bookmark;
    const signed = j.result?.result?.signed_url;
    if (signed) {
      const dump = await fetcher(signed);
      if (!dump.ok || !dump.body) throw new Error(`D1 export download failed: ${dump.status}`);
      const key = `d1/${isoDay(now)}.sql`;
      await env.BACKUPS.put(key, dump.body, { httpMetadata: { contentType: "application/sql" }, customMetadata: { bookmark: bookmark ?? "" } });
      return key;
    }
    await wait(5000);
  }
  throw new Error("D1 export did not complete in 5 minutes");
}

export async function d1SizeCheck(env: Env) {
  const bytes = await ops.dbSizeBytes(env.DB);
  if (bytes > D1_SIZE_ALERT_BYTES) await opsAlert(env, "D1 database over 5 GB", `Size is ${(bytes / 1024 ** 3).toFixed(2)} GB of the 10 GB limit. First mitigation: move audit_log to its own database.`);
  return bytes;
}

/** Weekly cleanup (R4.9, R10.6): expired invites, resets, sessions, MFA codes, and stale quarantine. */
export async function weeklyCleanup(env: Env, now = Date.now()) {
  const db = dbFor(env);
  await Promise.all([authRepo.purgeInvites(db, now), authRepo.purgeResets(db, now), authRepo.purgeExpiredSessions(db, now), authRepo.purgeChallenges(db, now)]);
  const stale = await documents.staleQuarantine(db, now - 7 * DAY);
  for (const d of stale) {
    await env.QUARANTINE.delete(d.objectKey);
    await documents.markDocument(db, d.id, { status: "expired" });
  }
  return { expiredUploads: stale.length };
}

/** Monthly: archive the prior month's audit rows to the backups bucket (R19.5, R17 spec §17). */
export async function monthlyAuditArchive(env: Env, now = Date.now()) {
  const d = new Date(now);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1);
  const label = new Date(start).toISOString().slice(0, 7);
  const key = `audit/${label}.csv`;
  await env.BACKUPS.put(key, await buildAuditCsv(env, null, start, end), { httpMetadata: { contentType: "text/csv" } });
  return key;
}

/**
 * Key rotation (R6.2): when ENC_KEY_CURRENT moves to a new version, start a rotation job and
 * re-encrypt up to 500 rows per table every 15 minutes until every ciphertext uses the new key.
 */
export async function keyRotationTick(env: Env) {
  const db = dbFor(env);
  const current = Number(env.ENC_KEY_CURRENT ?? 1);
  if ((await ops.latestRotationVersion(db)) < current) await ops.startRotation(db, current);
  let processed = 0;
  for (const job of await ops.runningRotations(db)) {
    if (job.toVersion !== current) continue;
    processed += await ops.rotateBatch(db, fieldCrypto(env), job);
  }
  return processed;
}

/** Cron router (wrangler.jsonc triggers). */
export async function scheduledHandler(controller: ScheduledController, env: Env) {
  const now = controller.scheduledTime;
  const run = async (name: string, fn: () => Promise<unknown>) => {
    try {
      const r = await fn();
      console.log(JSON.stringify({ level: "info", msg: "cron", job: name, result: r }));
    } catch (e) {
      await opsAlert(env, `Scheduled job failed: ${name}`, String(e));
    }
  };
  switch (controller.cron) {
    case "0 11 * * *":
      await run("overdue_sweep", () => overdueSweep(env, now));
      await run("stale_imports", () => failStaleImports(env, now));
      await run("scan_backlog", () => scanBacklogCheck(env, now));
      await run("daily_digest", () => dailyDigest(env, now));
      break;
    case "0 8 * * *":
      await run("d1_export", () => d1Export(env, now));
      await run("d1_size", () => d1SizeCheck(env));
      break;
    case "0 9 * * 1":
      await run("weekly_cleanup", () => weeklyCleanup(env, now));
      break;
    case "0 10 1 * *":
      await run("audit_archive", () => monthlyAuditArchive(env, now));
      break;
    case "*/15 * * * *":
      await run("key_rotation", () => keyRotationTick(env));
      break;
  }
}
