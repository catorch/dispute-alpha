import { and, eq, gt, sql } from "drizzle-orm";
import { uuidv7 } from "@da/shared";
import type { FieldCrypto } from "@da/crypto";
import type { DB } from "../client";
import { auditExport, client, clientAccount, invite, keyRotation, reportItem } from "../schema";

// ---------- audit exports ----------
export async function createAuditExport(db: DB, orgId: string, requestedBy: string, params: unknown) {
  const row = { id: uuidv7(), orgId, requestedBy, paramsJson: JSON.stringify(params), status: "queued" as const, createdAt: Date.now() };
  await db.insert(auditExport).values(row);
  return row;
}
export const getAuditExport = (db: DB, id: string) => db.query.auditExport.findFirst({ where: eq(auditExport.id, id) });
export const finishAuditExport = (db: DB, id: string, status: "ready" | "failed", documentId?: string) =>
  db.update(auditExport).set({ status, documentId: documentId ?? null }).where(eq(auditExport.id, id));

// ---------- key rotation (R6.2) ----------
/** Every encrypted column the rotation job walks. */
export const ENCRYPTED_COLUMNS = [
  { table: "client", fields: [{ col: "dob_enc", field: "client.dob" }, { col: "ssn_enc", field: "client.ssn" }] },
  { table: "client_account", fields: [{ col: "totp_secret_enc", field: "client_account.totp" }] },
  { table: "invite", fields: [{ col: "pending_totp_enc", field: "invite.totp" }] },
  { table: "report_item", fields: [{ col: "account_number_enc", field: "report_item.account_number" }] },
] as const;
const TABLES = { client, client_account: clientAccount, invite, report_item: reportItem } as const;

export async function startRotation(db: DB, toVersion: number) {
  const now = Date.now();
  await db.batch([
    db.delete(keyRotation).where(eq(keyRotation.status, "running")),
    ...ENCRYPTED_COLUMNS.map((t) => db.insert(keyRotation).values({ id: uuidv7(), toVersion, tableName: t.table, status: "running", updatedAt: now })),
  ]);
}
export const runningRotations = (db: DB) => db.select().from(keyRotation).where(eq(keyRotation.status, "running"));

/** Re-encrypts up to `limit` rows of one table past the cursor. Returns rows processed. */
export async function rotateBatch(db: DB, fc: FieldCrypto, job: typeof keyRotation.$inferSelect, limit = 500) {
  const spec = ENCRYPTED_COLUMNS.find((t) => t.table === job.tableName);
  if (!spec) return 0;
  const tbl = TABLES[spec.table] as unknown as typeof client;
  const rows = (await db
    .select()
    .from(tbl)
    .where(job.lastId ? gt(tbl.id, job.lastId) : sql`1=1`)
    .orderBy(tbl.id)
    .limit(limit)) as unknown as Record<string, string | null>[];
  const camel = (c: string) => c.replace(/_([a-z])/g, (_, x: string) => x.toUpperCase());
  for (const r of rows) {
    const patch: Record<string, string> = {};
    for (const f of spec.fields) {
      const v = r[camel(f.col)];
      if (v && fc.needsRotation(v)) patch[camel(f.col)] = await fc.rotate(f.field, v);
    }
    if (Object.keys(patch).length) await db.update(tbl).set(patch).where(eq(tbl.id, r.id as string));
  }
  const done = rows.length < limit;
  await db
    .update(keyRotation)
    .set({ lastId: rows.length ? (rows[rows.length - 1].id as string) : job.lastId, status: done ? "done" : "running", updatedAt: Date.now() })
    .where(eq(keyRotation.id, job.id));
  return rows.length;
}

/** D1 database size via SQLite pragmas, for the >5 GB alert (R20.7). */
export async function dbSizeBytes(d1: D1Database) {
  const pc = await d1.prepare("PRAGMA page_count").first<{ page_count: number }>();
  const ps = await d1.prepare("PRAGMA page_size").first<{ page_size: number }>();
  return (pc?.page_count ?? 0) * (ps?.page_size ?? 0);
}

export const pendingInvitesForClient = (db: DB, orgId: string, clientId: string) =>
  db.select().from(invite).where(and(eq(invite.orgId, orgId), eq(invite.clientId, clientId)));

/** Per-staff counts for the daily digest (R17.3). */
export async function digestCounts(d1: D1Database, orgId: string, since: number) {
  const q = async (sql: string, ...binds: unknown[]) => (await d1.prepare(sql).bind(...binds).all<{ staff: string; n: number }>()).results;
  const [tasksOpen, overdue, uploads] = await Promise.all([
    q("SELECT assignee_id AS staff, count(*) AS n FROM task WHERE org_id = ? AND status = 'open' GROUP BY assignee_id", orgId),
    q("SELECT c.assigned_staff_id AS staff, count(*) AS n FROM letter l JOIN client c ON c.id = l.client_id WHERE l.org_id = ? AND l.status = 'overdue' GROUP BY c.assigned_staff_id", orgId),
    q(
      "SELECT c.assigned_staff_id AS staff, count(*) AS n FROM document d JOIN client c ON c.id = d.client_id WHERE d.org_id = ? AND d.uploaded_by_kind = 'client' AND d.created_at >= ? GROUP BY c.assigned_staff_id",
      orgId,
      since,
    ),
  ]);
  const m = (rows: { staff: string; n: number }[]) => new Map(rows.map((r) => [r.staff, Number(r.n)]));
  return { tasks: m(tasksOpen), overdue: m(overdue), uploads: m(uploads) };
}
export async function overdueCount(d1: D1Database, orgId: string) {
  const r = await d1.prepare("SELECT count(*) AS n FROM letter WHERE org_id = ? AND status = 'overdue'").bind(orgId).first<{ n: number }>();
  return Number(r?.n ?? 0);
}
export async function latestRotationVersion(db: DB) {
  const rows = await db.select().from(keyRotation);
  return rows.reduce((m, r) => Math.max(m, r.toVersion), 0);
}
