import { and, desc, eq, inArray, isNotNull, lt, max, sql } from "drizzle-orm";
import { type LetterStatus, type LetterSummary, type PortalLetter, type TemplateDto, uuidv7 } from "@da/shared";
import type { DB } from "../client";
import { client, disputeRound, letter, letterAttachment, letterItem, letterTemplate, response } from "../schema";

export type LetterRow = typeof letter.$inferSelect;

// ---------- templates (versioned: a save is a new row with the same name, R14.2) ----------
const toTemplateDto = (t: typeof letterTemplate.$inferSelect): TemplateDto => ({ id: t.id, name: t.name, version: t.version, bodyHtml: t.bodyHtml, active: t.active, createdAt: t.createdAt });

/** Latest version of each template name. */
export async function listTemplates(db: DB, orgId: string, opts: { includeHistory?: boolean } = {}) {
  const rows = await db.select().from(letterTemplate).where(eq(letterTemplate.orgId, orgId)).orderBy(letterTemplate.name, desc(letterTemplate.version));
  if (opts.includeHistory) return rows.map(toTemplateDto);
  const seen = new Set<string>();
  return rows.filter((r) => !seen.has(r.name) && seen.add(r.name)).map(toTemplateDto);
}
export const getTemplate = async (db: DB, orgId: string, id: string) => {
  const t = await db.query.letterTemplate.findFirst({ where: and(eq(letterTemplate.orgId, orgId), eq(letterTemplate.id, id)) });
  return t ? toTemplateDto(t) : null;
};
export async function createTemplateVersion(db: DB, orgId: string, name: string, bodyHtml: string, createdBy: string) {
  const [{ v }] = await db.select({ v: max(letterTemplate.version) }).from(letterTemplate).where(and(eq(letterTemplate.orgId, orgId), eq(letterTemplate.name, name)));
  const row = { id: uuidv7(), orgId, name, version: (v ?? 0) + 1, bodyHtml, active: true, createdBy, createdAt: Date.now() };
  await db.batch([
    db.update(letterTemplate).set({ active: false }).where(and(eq(letterTemplate.orgId, orgId), eq(letterTemplate.name, name))),
    db.insert(letterTemplate).values(row),
  ]);
  return toTemplateDto(row);
}
export const setTemplateActive = (db: DB, orgId: string, id: string, active: boolean) =>
  db.update(letterTemplate).set({ active }).where(and(eq(letterTemplate.orgId, orgId), eq(letterTemplate.id, id)));

// ---------- dispute rounds ----------
export async function nextRoundNumber(db: DB, orgId: string, clientId: string) {
  const [{ n }] = await db.select({ n: max(disputeRound.number) }).from(disputeRound).where(and(eq(disputeRound.orgId, orgId), eq(disputeRound.clientId, clientId)));
  return (n ?? 0) + 1;
}

export type NewLetter = { targetKind: "bureau" | "furnisher"; targetName: string; templateId: string; templateVersion: number; bodyHtml: string; items: { reportItemId: string; reason: string }[] };

/** Round + letters + letter items in one atomic batch. */
export async function createRound(db: DB, orgId: string, clientId: string, createdBy: string, letters: NewLetter[]) {
  const now = Date.now();
  const roundId = uuidv7();
  const number = await nextRoundNumber(db, orgId, clientId);
  const letterRows = letters.map((l) => ({
    id: uuidv7(),
    orgId,
    clientId,
    disputeRoundId: roundId,
    targetKind: l.targetKind,
    targetName: l.targetName,
    templateId: l.templateId,
    templateVersion: l.templateVersion,
    status: "draft" as const,
    bodyHtml: l.bodyHtml,
    createdBy,
    createdAt: now,
    updatedAt: now,
  }));
  const itemRows = letters.flatMap((l, i) => l.items.map((it) => ({ letterId: letterRows[i].id, reportItemId: it.reportItemId, reason: it.reason })));
  await db.batch([
    db.insert(disputeRound).values({ id: roundId, orgId, clientId, number, createdBy, createdAt: now }),
    ...letterRows.map((r) => db.insert(letter).values(r)),
    ...itemRows.map((r) => db.insert(letterItem).values(r)),
  ]);
  return { roundId, number, letterIds: letterRows.map((r) => r.id) };
}
export const getRound = (db: DB, orgId: string, id: string) => db.query.disputeRound.findFirst({ where: and(eq(disputeRound.orgId, orgId), eq(disputeRound.id, id)) });
export const lettersInRound = (db: DB, orgId: string, roundId: string) => db.select().from(letter).where(and(eq(letter.orgId, orgId), eq(letter.disputeRoundId, roundId)));

// ---------- letters ----------
export const getLetter = (db: DB, orgId: string, id: string) => db.query.letter.findFirst({ where: and(eq(letter.orgId, orgId), eq(letter.id, id)) });
export const getLetterById = (db: DB, id: string) => db.query.letter.findFirst({ where: eq(letter.id, id) });

/**
 * Status changes are compare-and-set on the current status, so two concurrent
 * transitions (e.g. approve and reject) cannot both succeed. Returns true if applied.
 */
export async function transitionLetter(db: DB, orgId: string, id: string, from: LetterStatus | LetterStatus[], patch: Partial<LetterRow> & { status: LetterStatus }) {
  const froms = Array.isArray(from) ? from : [from];
  const res = await db
    .update(letter)
    .set({ ...patch, updatedAt: Date.now() })
    .where(and(eq(letter.orgId, orgId), eq(letter.id, id), inArray(letter.status, froms)))
    .returning({ id: letter.id });
  return res.length > 0;
}
export const updateLetterBody = (db: DB, orgId: string, id: string, bodyHtml: string) =>
  db.update(letter).set({ bodyHtml, updatedAt: Date.now() }).where(and(eq(letter.orgId, orgId), eq(letter.id, id), eq(letter.status, "draft")));
export const setLetterFields = (db: DB, id: string, patch: Partial<LetterRow>) => db.update(letter).set({ ...patch, updatedAt: Date.now() }).where(eq(letter.id, id));

export const letterItemRows = (db: DB, letterId: string) => db.select().from(letterItem).where(eq(letterItem.letterId, letterId));
export const setLetterItemOutcome = (db: DB, letterId: string, reportItemId: string, outcome: NonNullable<(typeof letterItem.$inferSelect)["outcome"]>) =>
  db.update(letterItem).set({ outcome }).where(and(eq(letterItem.letterId, letterId), eq(letterItem.reportItemId, reportItemId)));

export const attachmentIds = async (db: DB, letterId: string) => (await db.select().from(letterAttachment).where(eq(letterAttachment.letterId, letterId))).map((a) => a.documentId);
export async function setAttachments(db: DB, letterId: string, documentIds: string[]) {
  await db.batch([db.delete(letterAttachment).where(eq(letterAttachment.letterId, letterId)), ...documentIds.map((documentId) => db.insert(letterAttachment).values({ letterId, documentId }))]);
}

const summaryCols = {
  id: letter.id,
  clientId: letter.clientId,
  firstName: client.firstName,
  lastName: client.lastName,
  disputeRoundId: letter.disputeRoundId,
  roundNumber: disputeRound.number,
  targetKind: letter.targetKind,
  targetName: letter.targetName,
  status: letter.status,
  createdById: letter.createdBy,
  createdAt: letter.createdAt,
  sentAt: letter.sentAt,
  responseDueAt: letter.responseDueAt,
};
type SummaryRow = { [K in keyof typeof summaryCols]: unknown };
const toSummary = (r: SummaryRow): LetterSummary => {
  const { firstName, lastName, ...rest } = r as LetterSummary & { firstName: string; lastName: string };
  return { ...rest, clientName: `${firstName} ${lastName}` };
};

export async function listLetters(db: DB, orgId: string, f: { clientId?: string; status?: LetterStatus[] }) {
  const conds = [eq(letter.orgId, orgId)];
  if (f.clientId) conds.push(eq(letter.clientId, f.clientId));
  if (f.status?.length) conds.push(inArray(letter.status, f.status));
  const rows = await db
    .select(summaryCols)
    .from(letter)
    .innerJoin(client, eq(client.id, letter.clientId))
    .innerJoin(disputeRound, eq(disputeRound.id, letter.disputeRoundId))
    .where(and(...conds))
    .orderBy(desc(letter.createdAt))
    .limit(200);
  return rows.map(toSummary);
}
export async function letterSummary(db: DB, orgId: string, id: string) {
  const [r] = await db
    .select(summaryCols)
    .from(letter)
    .innerJoin(client, eq(client.id, letter.clientId))
    .innerJoin(disputeRound, eq(disputeRound.id, letter.disputeRoundId))
    .where(and(eq(letter.orgId, orgId), eq(letter.id, id)));
  return r ? toSummary(r) : null;
}
export async function portalLetters(db: DB, orgId: string, clientId: string): Promise<PortalLetter[]> {
  const rows = await db
    .select({ id: letter.id, targetName: letter.targetName, status: letter.status, sentAt: letter.sentAt, responseDueAt: letter.responseDueAt })
    .from(letter)
    .where(and(eq(letter.orgId, orgId), eq(letter.clientId, clientId)))
    .orderBy(desc(letter.createdAt));
  return rows;
}

/** Letters still marked sent past their due date: the overdue safety net (R16.6). */
export const overdueCandidates = (db: DB, now: number) =>
  db.select().from(letter).where(and(eq(letter.status, "sent"), isNotNull(letter.responseDueAt), lt(letter.responseDueAt, now)));
export const lettersByStatus = (db: DB, statuses: LetterStatus[]) => db.select().from(letter).where(inArray(letter.status, statuses));
export async function overdueCountsByCreator(db: DB, orgId: string) {
  return db
    .select({ createdBy: letter.createdBy, n: sql<number>`count(*)` })
    .from(letter)
    .where(and(eq(letter.orgId, orgId), eq(letter.status, "overdue")))
    .groupBy(letter.createdBy);
}

// ---------- responses ----------
export async function insertResponse(db: DB, orgId: string, r: { letterId: string; receivedAt: number; documentId?: string; notes?: string; loggedBy: string }) {
  const row = { id: uuidv7(), orgId, letterId: r.letterId, receivedAt: r.receivedAt, documentId: r.documentId ?? null, notes: r.notes ?? null, loggedBy: r.loggedBy, createdAt: Date.now() };
  await db.insert(response).values(row);
  return row;
}
export const responsesForLetter = (db: DB, orgId: string, letterId: string) => db.select().from(response).where(and(eq(response.orgId, orgId), eq(response.letterId, letterId)));
