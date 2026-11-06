import { and, desc, eq, inArray, lt } from "drizzle-orm";
import type { DocStatus, DocumentDto } from "@da/shared";
import type { DB } from "../client";
import { document } from "../schema";

export type DocumentRow = typeof document.$inferSelect;
export const BUCKET_BINDING = { quarantine: "QUARANTINE", documents: "DOCS", letters: "LETTERS", backups: "DOCS" } as const;

/** Object keys use ids only, never names or SSNs (R10.11). */
export const docKey = (orgId: string, clientId: string | null, docId: string) => (clientId ? `org/${orgId}/client/${clientId}/doc/${docId}` : `org/${orgId}/doc/${docId}`);

export const toDocumentDto = (d: DocumentRow): DocumentDto => ({
  id: d.id,
  clientId: d.clientId ?? "",
  type: d.type as DocumentDto["type"],
  status: d.status,
  filename: d.filename,
  mime: d.mime,
  size: d.size,
  uploadedByKind: d.uploadedByKind,
  createdAt: d.createdAt,
});

export async function insertDocument(db: DB, row: Omit<DocumentRow, "createdAt" | "scanResultJson"> & { scanResultJson?: string | null }) {
  const full = { scanResultJson: null, ...row, createdAt: Date.now() };
  await db.insert(document).values(full);
  return full as DocumentRow;
}
export const getDocument = (db: DB, orgId: string, id: string) => db.query.document.findFirst({ where: and(eq(document.orgId, orgId), eq(document.id, id)) });
/** Queue consumers receive ids from our own producers; the row carries its org. */
export const getDocumentById = (db: DB, id: string) => db.query.document.findFirst({ where: eq(document.id, id) });

export async function listDocuments(db: DB, orgId: string, clientId: string, opts: { visibleToClient?: boolean } = {}) {
  const rows = await db.select().from(document).where(and(eq(document.orgId, orgId), eq(document.clientId, clientId))).orderBy(desc(document.createdAt));
  // Clients see their own uploads and signed authorizations, not internal letters or exports.
  const visible = opts.visibleToClient ? rows.filter((r) => r.uploadedByKind === "client" || r.type === "authorization") : rows;
  return visible.map(toDocumentDto);
}
export async function documentsByIds(db: DB, orgId: string, ids: string[]) {
  if (!ids.length) return [];
  return db.select().from(document).where(and(eq(document.orgId, orgId), inArray(document.id, ids)));
}
export const markDocument = (db: DB, id: string, patch: Partial<Pick<DocumentRow, "status" | "bucket" | "objectKey" | "encrypted" | "scanResultJson">>) =>
  db.update(document).set(patch).where(eq(document.id, id));
export const staleQuarantine = (db: DB, before: number) =>
  db.select().from(document).where(and(eq(document.status, "scan_pending"), lt(document.createdAt, before)));
export const countByStatusBefore = async (db: DB, status: DocStatus, before: number) =>
  (await db.select({ id: document.id }).from(document).where(and(eq(document.status, status), lt(document.createdAt, before)))).length;
