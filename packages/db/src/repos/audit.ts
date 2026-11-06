/**
 * Append-only audit log (R19.2). This module intentionally exports insert and read functions only;
 * a test asserts no update or delete path exists.
 */
import { and, desc, eq, gt, gte, lt } from "drizzle-orm";
import { redact } from "@da/crypto";
import { type AuditEntryDto, uuidv7 } from "@da/shared";
import { type DB, chunk, parseJson } from "../client";
import { auditLog } from "../schema";
import { userNames } from "./orgs";

export type AuditInput = {
  orgId: string | null;
  actorKind: "staff" | "client" | "system" | "anonymous" | "webhook";
  actorId?: string | null;
  sessionId?: string | null;
  requestId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  diff?: unknown;
  ipHash?: string | null;
};

async function insert(db: DB, entries: AuditInput[]) {
  if (!entries.length) return;
  const now = Date.now();
  const rows = entries.map((e) => ({
    id: uuidv7(),
    orgId: e.orgId,
    actorKind: e.actorKind,
    actorId: e.actorId ?? null,
    sessionId: e.sessionId ?? null,
    requestId: e.requestId ?? null,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId ?? null,
    // Diffs are always redacted: decrypted PII never reaches the audit log (R19.3).
    diffJson: e.diff === undefined ? null : JSON.stringify(redact(e.diff)),
    ipHash: e.ipHash ?? null,
    createdAt: now,
  }));
  for (const part of chunk(rows, 8)) await db.insert(auditLog).values(part);
}

const PAGE = 100;
async function query(db: DB, orgId: string, f: { entityType?: string; entityId?: string; from?: number; to?: number; cursor?: string }) {
  const conds = [eq(auditLog.orgId, orgId)];
  if (f.entityType) conds.push(eq(auditLog.entityType, f.entityType));
  if (f.entityId) conds.push(eq(auditLog.entityId, f.entityId));
  if (f.from) conds.push(gte(auditLog.createdAt, f.from));
  if (f.to) conds.push(lt(auditLog.createdAt, f.to));
  if (f.cursor) conds.push(lt(auditLog.id, f.cursor));
  const rows = await db.select().from(auditLog).where(and(...conds)).orderBy(desc(auditLog.id)).limit(PAGE + 1);
  const page = rows.slice(0, PAGE);
  const names = await userNames(db, orgId, page.filter((r) => r.actorKind === "staff").map((r) => r.actorId));
  const items: AuditEntryDto[] = page.map((r) => ({
    id: r.id,
    actorKind: r.actorKind,
    actorId: r.actorId,
    actorName: r.actorId ? (names.get(r.actorId) ?? null) : null,
    action: r.action,
    entityType: r.entityType,
    entityId: r.entityId,
    diff: parseJson(r.diffJson, null),
    requestId: r.requestId,
    createdAt: r.createdAt,
  }));
  return { items, nextCursor: rows.length > PAGE ? page[page.length - 1].id : null };
}

/** Streams rows for CSV export in id order, 500 at a time (keyset pagination). */
async function* exportRange(db: DB, orgId: string | null, from: number, to: number, entityType?: string) {
  let after: string | null = null;
  for (;;) {
    const conds = [gte(auditLog.createdAt, from), lt(auditLog.createdAt, to)];
    if (orgId) conds.push(eq(auditLog.orgId, orgId));
    if (entityType) conds.push(eq(auditLog.entityType, entityType));
    if (after) conds.push(gt(auditLog.id, after));
    const rows = await db.select().from(auditLog).where(and(...conds)).orderBy(auditLog.id).limit(500);
    if (rows.length) yield rows;
    if (rows.length < 500) return;
    after = rows[rows.length - 1].id;
  }
}

export const auditRepo = { insert, query, exportRange };
