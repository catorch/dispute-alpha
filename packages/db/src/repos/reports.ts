import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { FieldCrypto } from "@da/crypto";
import { type FlagDto, type FlagRuleDto, type FlagRuleInput, type ReportDto, type ReportItemDto, REPORT_ACTIVE, uuidv7 } from "@da/shared";
import { type DB, chunk, parseJson } from "../client";
import { flag, flagRule, report, reportItem } from "../schema";

export type ReportRow = typeof report.$inferSelect;
export type ReportItemRow = typeof reportItem.$inferSelect;

export async function activeImport(db: DB, orgId: string, clientId: string) {
  return db.query.report.findFirst({ where: and(eq(report.orgId, orgId), eq(report.clientId, clientId), inArray(report.status, [...REPORT_ACTIVE])) });
}
export async function createReport(db: DB, orgId: string, clientId: string, provider: string, requestedBy: string) {
  const now = Date.now();
  const row = { id: uuidv7(), orgId, clientId, provider, status: "requested" as const, requestedBy, requestedAt: now, createdAt: now };
  await db.insert(report).values(row);
  return row;
}
export const getReport = (db: DB, orgId: string, id: string) => db.query.report.findFirst({ where: and(eq(report.orgId, orgId), eq(report.id, id)) });
export const getReportById = (db: DB, id: string) => db.query.report.findFirst({ where: eq(report.id, id) });
export const findReportByProviderRef = (db: DB, providerRef: string) => db.query.report.findFirst({ where: eq(report.providerRef, providerRef) });
export const updateReport = (db: DB, id: string, patch: Partial<Pick<ReportRow, "status" | "providerRef" | "workflowId" | "rawObjectKey" | "completedAt" | "error">>) =>
  db.update(report).set(patch).where(eq(report.id, id));
export const staleWaitingReports = (db: DB, before: number) =>
  db.select().from(report).where(and(inArray(report.status, [...REPORT_ACTIVE]), sql`${report.requestedAt} < ${before}`));

export async function listReports(db: DB, orgId: string, clientId: string): Promise<ReportDto[]> {
  const rows = await db.select().from(report).where(and(eq(report.orgId, orgId), eq(report.clientId, clientId))).orderBy(desc(report.requestedAt));
  if (!rows.length) return [];
  const counts = await db
    .select({ reportId: reportItem.reportId, items: sql<number>`count(distinct ${reportItem.id})`, flagged: sql<number>`count(distinct ${flag.reportItemId})` })
    .from(reportItem)
    .leftJoin(flag, eq(flag.reportItemId, reportItem.id))
    .where(and(eq(reportItem.orgId, orgId), inArray(reportItem.reportId, rows.map((r) => r.id))))
    .groupBy(reportItem.reportId);
  const byId = new Map(counts.map((c) => [c.reportId, c]));
  return rows.map((r) => ({
    id: r.id,
    clientId: r.clientId,
    status: r.status,
    provider: r.provider,
    requestedAt: r.requestedAt,
    completedAt: r.completedAt,
    error: r.error,
    itemCount: Number(byId.get(r.id)?.items ?? 0),
    flaggedCount: Number(byId.get(r.id)?.flagged ?? 0),
  }));
}

export type NormalizedItemInput = Omit<ReportItemRow, "id" | "orgId" | "reportId" | "clientId" | "createdAt" | "outcome" | "accountNumberEnc"> & { accountNumber: string | null };

/** Writes items in chunks; each chunk commits atomically through db.batch (R12.4, R20.4, R20.5). */
export async function insertItems(db: DB, fc: FieldCrypto, r: { orgId: string; reportId: string; clientId: string }, items: NormalizedItemInput[]) {
  const now = Date.now();
  const rows = await Promise.all(
    items.map(async ({ accountNumber, ...i }) => ({
      ...i,
      id: uuidv7(),
      orgId: r.orgId,
      reportId: r.reportId,
      clientId: r.clientId,
      accountNumberEnc: accountNumber ? await fc.encrypt("report_item.account_number", accountNumber) : null,
      createdAt: now,
    })),
  );
  // 19 columns per row; D1 allows 100 bound parameters per statement, so 5 rows per insert, 1,000 rows per batch.
  for (const batch of chunk(chunk(rows, 5), 200)) {
    const [first, ...rest] = batch.map((part) => db.insert(reportItem).values(part));
    if (first) await db.batch([first, ...rest]);
  }
  return rows.length;
}

export const itemsForReport = (db: DB, orgId: string, reportId: string) =>
  db.select().from(reportItem).where(and(eq(reportItem.orgId, orgId), eq(reportItem.reportId, reportId)));
export const getItem = (db: DB, orgId: string, id: string) => db.query.reportItem.findFirst({ where: and(eq(reportItem.orgId, orgId), eq(reportItem.id, id)) });
export const itemsByIds = async (db: DB, orgId: string, ids: string[]) =>
  ids.length ? db.select().from(reportItem).where(and(eq(reportItem.orgId, orgId), inArray(reportItem.id, ids))) : [];
export const setItemOutcome = (db: DB, orgId: string, id: string, outcome: ReportItemRow["outcome"]) =>
  db.update(reportItem).set({ outcome }).where(and(eq(reportItem.orgId, orgId), eq(reportItem.id, id)));

const toFlagDto = (f: typeof flag.$inferSelect): FlagDto => ({ id: f.id, reason: f.reason, source: f.source, ruleId: f.ruleId, createdAt: f.createdAt });

/** Item DTOs with masked account numbers and flags; full numbers stay encrypted. */
export async function itemDtos(db: DB, orgId: string, rows: ReportItemRow[]): Promise<ReportItemDto[]> {
  const flags = rows.length
    ? (await Promise.all(chunk(rows.map((r) => r.id), 90).map((ids) => db.select().from(flag).where(and(eq(flag.orgId, orgId), inArray(flag.reportItemId, ids)))))).flat()
    : [];
  const byItem = new Map<string, FlagDto[]>();
  for (const f of flags) byItem.set(f.reportItemId, [...(byItem.get(f.reportItemId) ?? []), toFlagDto(f)]);
  return rows.map((r) => ({
    id: r.id,
    reportId: r.reportId,
    bureau: r.bureau,
    itemType: r.itemType,
    furnisher: r.furnisher,
    accountMask: r.accountMask,
    balance: r.balance,
    creditLimit: r.creditLimit,
    openedAt: r.openedAt,
    reportedAt: r.reportedAt,
    status: r.status,
    paymentHistory: parseJson<string[] | null>(r.paymentHistoryJson, null),
    details: parseJson<Record<string, unknown>>(r.detailsJson, {}),
    fingerprint: r.fingerprint,
    outcome: r.outcome,
    flags: byItem.get(r.id) ?? [],
  }));
}

/** Same tradeline across all imports for a client, by fingerprint (R13.4). */
export const itemHistory = (db: DB, orgId: string, clientId: string, fingerprint: string) =>
  db.select().from(reportItem).where(and(eq(reportItem.orgId, orgId), eq(reportItem.clientId, clientId), eq(reportItem.fingerprint, fingerprint))).orderBy(desc(reportItem.createdAt));

// ---------- flags ----------
export async function insertFlags(db: DB, orgId: string, hits: { itemId: string; ruleId: string | null; reason: string; source: "rule" | "manual"; createdBy?: string | null }[]) {
  const now = Date.now();
  const rows = hits.map((h) => ({ id: uuidv7(), orgId, reportItemId: h.itemId, ruleId: h.ruleId, reason: h.reason, source: h.source, createdBy: h.createdBy ?? null, createdAt: now }));
  for (const part of chunk(rows, 10)) await db.insert(flag).values(part);
  return rows;
}
export const getFlag = (db: DB, orgId: string, id: string) => db.query.flag.findFirst({ where: and(eq(flag.orgId, orgId), eq(flag.id, id)) });
export const deleteFlag = (db: DB, orgId: string, id: string) => db.delete(flag).where(and(eq(flag.orgId, orgId), eq(flag.id, id)));
export const flagsForItems = async (db: DB, orgId: string, ids: string[]) =>
  ids.length ? (await Promise.all(chunk(ids, 90).map((part) => db.select().from(flag).where(and(eq(flag.orgId, orgId), inArray(flag.reportItemId, part)))))).flat() : [];

// ---------- flag rules (R13.6) ----------
const toRuleDto = (r: typeof flagRule.$inferSelect): FlagRuleDto => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  itemTypes: parseJson(r.itemTypesJson, []),
  condition: parseJson(r.conditionJson, null),
  reasonTemplate: r.reasonTemplate,
  active: r.active,
});
export const listRules = async (db: DB, orgId: string) => (await db.select().from(flagRule).where(eq(flagRule.orgId, orgId)).orderBy(flagRule.createdAt)).map(toRuleDto);
export const activeRules = async (db: DB, orgId: string) =>
  (await db.select().from(flagRule).where(and(eq(flagRule.orgId, orgId), eq(flagRule.active, true)))).map(toRuleDto);
export async function createRule(db: DB, orgId: string, input: FlagRuleInput) {
  const row = {
    id: uuidv7(),
    orgId,
    name: input.name,
    kind: input.kind,
    itemTypesJson: JSON.stringify(input.itemTypes),
    conditionJson: input.condition ? JSON.stringify(input.condition) : null,
    reasonTemplate: input.reasonTemplate,
    active: input.active,
    createdAt: Date.now(),
  };
  await db.insert(flagRule).values(row);
  return toRuleDto(row);
}
export async function updateRule(db: DB, orgId: string, id: string, input: Partial<FlagRuleInput>) {
  const before = await db.query.flagRule.findFirst({ where: and(eq(flagRule.orgId, orgId), eq(flagRule.id, id)) });
  if (!before) return null;
  const patch = {
    ...(input.name !== undefined && { name: input.name }),
    ...(input.kind !== undefined && { kind: input.kind }),
    ...(input.itemTypes !== undefined && { itemTypesJson: JSON.stringify(input.itemTypes) }),
    ...(input.condition !== undefined && { conditionJson: JSON.stringify(input.condition) }),
    ...(input.reasonTemplate !== undefined && { reasonTemplate: input.reasonTemplate }),
    ...(input.active !== undefined && { active: input.active }),
  };
  await db.update(flagRule).set(patch).where(and(eq(flagRule.orgId, orgId), eq(flagRule.id, id)));
  return { before: toRuleDto(before), after: toRuleDto({ ...before, ...patch }) };
}

/** Makes a retried parse step idempotent: clear what a failed attempt may have written. */
export const deleteItemsForBureau = (db: DB, reportId: string, bureau: ReportItemRow["bureau"]) =>
  db.delete(reportItem).where(and(eq(reportItem.reportId, reportId), eq(reportItem.bureau, bureau)));
/** Clears rule-generated flags (manual flags are kept) before re-running the rule engine. */
export async function deleteRuleFlags(db: DB, orgId: string, itemIds: string[]) {
  for (const part of chunk(itemIds, 90)) await db.delete(flag).where(and(eq(flag.orgId, orgId), eq(flag.source, "rule"), inArray(flag.reportItemId, part)));
}
