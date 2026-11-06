import { and, desc, eq, inArray, like, lt, or } from "drizzle-orm";
import type { FieldCrypto } from "@da/crypto";
import {
  type Address,
  type ClientDetail,
  type ClientStatus,
  type ClientSummary,
  type NoteDto,
  type Page,
  type TimelineEntry,
  DAY,
  uuidv7,
} from "@da/shared";
import { type DB, parseJson } from "../client";
import { client, clientAccount, document, letter, note, report, response, task } from "../schema";
import { userNames } from "./orgs";

type ClientRow = typeof client.$inferSelect;
const PAGE = 50;

function toSummary(c: ClientRow, names: Map<string, string>): ClientSummary {
  return {
    id: c.id,
    firstName: c.firstName,
    lastName: c.lastName,
    email: c.email,
    status: c.status,
    authStatus: c.authStatus,
    ssnLast4: c.ssnLast4,
    assignedStaffId: c.assignedStaffId,
    assignedStaffName: c.assignedStaffId ? (names.get(c.assignedStaffId) ?? null) : null,
    createdAt: c.createdAt,
  };
}

export type NewClient = { firstName: string; lastName: string; email: string; phone?: string; dob: string; ssn: string; address: Address; assignedStaffId: string };

/** Returns other clients in the org with the same SSN, matched by keyed HMAC (R9.2). */
export async function findDuplicates(db: DB, fc: FieldCrypto, orgId: string, ssn: string) {
  const h = await fc.hmac(ssn);
  const rows = await db
    .select({ id: client.id, firstName: client.firstName, lastName: client.lastName })
    .from(client)
    .where(and(eq(client.orgId, orgId), eq(client.ssnHmac, h)));
  return rows.map((r) => ({ id: r.id, name: `${r.firstName} ${r.lastName}` }));
}

export async function createClient(db: DB, fc: FieldCrypto, orgId: string, input: NewClient) {
  const now = Date.now();
  const id = uuidv7();
  const row = {
    id,
    orgId,
    assignedStaffId: input.assignedStaffId,
    firstName: input.firstName,
    lastName: input.lastName,
    email: input.email,
    phone: input.phone ?? null,
    addressJson: JSON.stringify(input.address),
    dobEnc: await fc.encrypt("client.dob", input.dob),
    ssnEnc: await fc.encrypt("client.ssn", input.ssn),
    ssnLast4: input.ssn.slice(-4),
    ssnHmac: await fc.hmac(input.ssn),
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(client).values(row);
  return id;
}

export const getClientRow = (db: DB, orgId: string, id: string) => db.query.client.findFirst({ where: and(eq(client.orgId, orgId), eq(client.id, id)) });

export async function listClients(db: DB, orgId: string, q: { status?: ClientStatus; assignedTo?: string; q?: string; cursor?: string }): Promise<Page<ClientSummary>> {
  const conds = [eq(client.orgId, orgId)];
  if (q.status) conds.push(eq(client.status, q.status));
  if (q.assignedTo) conds.push(eq(client.assignedStaffId, q.assignedTo));
  if (q.cursor) conds.push(lt(client.id, q.cursor));
  if (q.q) {
    const term = q.q.trim();
    const pat = `%${term.replace(/[%_]/g, "")}%`;
    const search = /^\d{4}$/.test(term) ? eq(client.ssnLast4, term) : or(like(client.firstName, pat), like(client.lastName, pat), like(client.email, pat));
    if (search) conds.push(search);
  }
  const rows = await db.select().from(client).where(and(...conds)).orderBy(desc(client.id)).limit(PAGE + 1);
  const page = rows.slice(0, PAGE);
  const names = await userNames(db, orgId, page.map((r) => r.assignedStaffId));
  return { items: page.map((r) => toSummary(r, names)), nextCursor: rows.length > PAGE ? page[page.length - 1].id : null };
}

export async function getClientDetail(db: DB, orgId: string, id: string): Promise<ClientDetail | null> {
  const c = await getClientRow(db, orgId, id);
  if (!c) return null;
  const [names, acct] = await Promise.all([
    userNames(db, orgId, [c.assignedStaffId]),
    db.query.clientAccount.findFirst({ where: and(eq(clientAccount.orgId, orgId), eq(clientAccount.clientId, id)) }),
  ]);
  return {
    ...toSummary(c, names),
    phone: c.phone,
    address: parseJson<Address>(c.addressJson, { line1: "", city: "", state: "", zip: "" }),
    dobMasked: "**/**/****",
    hasPortalAccount: !!acct,
    portalLocked: !!acct?.lockedAt,
    smsOptIn: c.smsOptIn,
  };
}

/** The only function that decrypts SSN and DOB; callers must hold client:read_pii and audit the read. */
export async function getClientPii(db: DB, fc: FieldCrypto, orgId: string, id: string) {
  const c = await getClientRow(db, orgId, id);
  if (!c) return null;
  return { ssn: await fc.decrypt("client.ssn", c.ssnEnc), dob: await fc.decrypt("client.dob", c.dobEnc) };
}
export async function getClientDob(db: DB, fc: FieldCrypto, orgId: string, id: string) {
  const c = await getClientRow(db, orgId, id);
  return c ? fc.decrypt("client.dob", c.dobEnc) : null;
}

export async function updateClient(db: DB, orgId: string, id: string, patch: Partial<{ firstName: string; lastName: string; email: string; phone: string; address: Address }>) {
  const before = await getClientRow(db, orgId, id);
  if (!before) return null;
  const { address, ...rest } = patch;
  await db
    .update(client)
    .set({ ...rest, ...(address ? { addressJson: JSON.stringify(address) } : {}), updatedAt: Date.now() })
    .where(and(eq(client.orgId, orgId), eq(client.id, id)));
  return { before: { firstName: before.firstName, lastName: before.lastName, email: before.email, phone: before.phone, address: parseJson(before.addressJson, {}) }, after: patch };
}

export const setClientStatus = (db: DB, orgId: string, id: string, status: ClientStatus) =>
  db.update(client).set({ status, updatedAt: Date.now() }).where(and(eq(client.orgId, orgId), eq(client.id, id)));
export const assignClient = (db: DB, orgId: string, id: string, staffId: string) =>
  db.update(client).set({ assignedStaffId: staffId, updatedAt: Date.now() }).where(and(eq(client.orgId, orgId), eq(client.id, id)));
export const setAuthStatus = (db: DB, orgId: string, id: string, authStatus: ClientRow["authStatus"]) =>
  db.update(client).set({ authStatus, updatedAt: Date.now() }).where(and(eq(client.orgId, orgId), eq(client.id, id)));
export const setSmsOptIn = (db: DB, orgId: string, id: string, smsOptIn: boolean) =>
  db.update(client).set({ smsOptIn, updatedAt: Date.now() }).where(and(eq(client.orgId, orgId), eq(client.id, id)));
/** Twilio STOP arrives with only a phone number (R18.5). */
export const optOutSmsByPhone = (db: DB, phone: string) => db.update(client).set({ smsOptIn: false, updatedAt: Date.now() }).where(eq(client.phone, phone));

export const clientsAssignedTo = (db: DB, orgId: string, staffId: string) =>
  db.select({ id: client.id }).from(client).where(and(eq(client.orgId, orgId), eq(client.assignedStaffId, staffId)));

// ---------- notes ----------
export const NOTE_EDIT_WINDOW = DAY;
export async function addNote(db: DB, orgId: string, clientId: string, authorId: string, body: string) {
  const row = { id: uuidv7(), orgId, clientId, authorId, body, createdAt: Date.now() };
  await db.insert(note).values(row);
  return row;
}
export async function listNotes(db: DB, orgId: string, clientId: string): Promise<NoteDto[]> {
  const rows = await db.select().from(note).where(and(eq(note.orgId, orgId), eq(note.clientId, clientId))).orderBy(desc(note.createdAt));
  const names = await userNames(db, orgId, rows.map((r) => r.authorId));
  const now = Date.now();
  return rows.map((r) => ({ id: r.id, body: r.body, authorName: names.get(r.authorId) ?? "Unknown", createdAt: r.createdAt, editable: now - r.createdAt < NOTE_EDIT_WINDOW }));
}
export const getNote = (db: DB, orgId: string, id: string) => db.query.note.findFirst({ where: and(eq(note.orgId, orgId), eq(note.id, id)) });
export const updateNote = (db: DB, orgId: string, id: string, body: string) => db.update(note).set({ body }).where(and(eq(note.orgId, orgId), eq(note.id, id)));

// ---------- timeline (R9.6) ----------
export async function clientTimeline(db: DB, orgId: string, clientId: string): Promise<TimelineEntry[]> {
  const [docs, reps, lets, notes, tasks] = await Promise.all([
    db.select().from(document).where(and(eq(document.orgId, orgId), eq(document.clientId, clientId))),
    db.select().from(report).where(and(eq(report.orgId, orgId), eq(report.clientId, clientId))),
    db.select().from(letter).where(and(eq(letter.orgId, orgId), eq(letter.clientId, clientId))),
    db.select().from(note).where(and(eq(note.orgId, orgId), eq(note.clientId, clientId))),
    db.select().from(task).where(and(eq(task.orgId, orgId), eq(task.entityType, "client"), eq(task.entityId, clientId))),
  ]);
  const letterIds = lets.map((l) => l.id);
  const resps = letterIds.length ? await db.select().from(response).where(and(eq(response.orgId, orgId), inArray(response.letterId, letterIds))) : [];
  const out: TimelineEntry[] = [
    ...docs.map((d) => ({ at: d.createdAt, kind: "document" as const, id: d.id, title: `Document: ${d.type.replace(/_/g, " ")}`, detail: d.status })),
    ...reps.map((r) => ({ at: r.requestedAt, kind: "report" as const, id: r.id, title: "Credit report import", detail: r.status })),
    ...lets.map((l) => ({ at: l.createdAt, kind: "letter" as const, id: l.id, title: `Letter to ${l.targetName}`, detail: l.status })),
    ...resps.map((r) => ({ at: r.receivedAt, kind: "response" as const, id: r.id, title: "Bureau response logged" })),
    ...notes.map((n) => ({ at: n.createdAt, kind: "note" as const, id: n.id, title: "Note", detail: n.body.slice(0, 140) })),
    ...tasks.map((t) => ({ at: t.createdAt, kind: "task" as const, id: t.id, title: t.title, detail: t.status })),
  ];
  return out.sort((a, b) => b.at - a.at);
}
