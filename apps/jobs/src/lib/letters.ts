import { PDFDocument, StandardFonts } from "pdf-lib";
import { type DB, clients, documents, letters, tasks } from "@da/db";
import type { FieldCrypto } from "@da/crypto";
import { renderTemplate, uuidv7 } from "@da/shared";
import type { Env } from "../env";
import { dbFor, link, notify } from "./services";

const PRINT_CSS = `
@page { size: Letter; margin: 1in 1in 1in 1in; }
html, body { margin: 0; padding: 0; }
body { font-family: "Times New Roman", Times, Georgia, serif; font-size: 12pt; line-height: 1.45; color: #000; }
p { margin: 0 0 10pt; }
ul, ol { margin: 0 0 10pt 18pt; padding: 0; }
li { margin-bottom: 4pt; }
h1, h2, h3 { font-size: 13pt; margin: 0 0 8pt; }
`;

/**
 * Builds the print HTML from the approved, locked body. Deferred PII (DOB) is resolved only here,
 * in memory. No external URLs: system fonts only, no images, JavaScript disabled at render.
 */
export async function letterHtml(db: DB, fc: FieldCrypto, orgId: string, letterId: string) {
  const l = await letters.getLetter(db, orgId, letterId);
  if (!l) throw new Error("letter not found");
  if (!l.lockedAt) throw new Error("letter is not locked");
  const dob = await clients.getClientDob(db, fc, orgId, l.clientId);
  const [y, m, d] = (dob ?? "").split("-");
  const body = renderTemplate(l.bodyHtml, { client: { dob: dob ? `${m}/${d}/${y}` : "" } }, { strict: false });
  return `<!doctype html><html><head><meta charset="utf-8"><style>${PRINT_CSS}</style></head><body>${body}</body></html>`;
}

export const FOOTER = `<div style="font-family: serif; font-size: 9pt; width: 100%; text-align: center; color: #444;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>`;

/** Appends supporting documents (PDF pages or images scaled onto Letter pages) to the rendered letter. */
export async function mergeAttachments(letterPdf: Uint8Array, atts: { mime: string; bytes: Uint8Array; filename: string }[]) {
  const out = await PDFDocument.load(letterPdf);
  for (const a of atts) {
    if (a.mime === "application/pdf") {
      const src = await PDFDocument.load(a.bytes, { ignoreEncryption: true });
      for (const page of await out.copyPages(src, src.getPageIndices())) out.addPage(page);
      continue;
    }
    const page = out.addPage([612, 792]);
    if (a.mime === "image/jpeg" || a.mime === "image/png") {
      const img = a.mime === "image/jpeg" ? await out.embedJpg(a.bytes) : await out.embedPng(a.bytes);
      const scale = Math.min(540 / img.width, 720 / img.height, 1);
      const w = img.width * scale;
      const h = img.height * scale;
      page.drawImage(img, { x: (612 - w) / 2, y: (792 - h) / 2, width: w, height: h });
    } else {
      // HEIC cannot be embedded by pdf-lib; staff are told to attach a PDF/JPEG/PNG copy.
      const font = await out.embedFont(StandardFonts.Helvetica);
      page.drawText(`Enclosure "${a.filename}" could not be embedded (unsupported image format).`, { x: 72, y: 720, size: 11, font });
    }
  }
  return out.save();
}

/** Loads attachment bytes, decrypting application-encrypted documents. */
export async function loadAttachments(env: Env, fc: FieldCrypto, orgId: string, letterId: string) {
  const db = dbFor(env);
  const ids = await letters.attachmentIds(db, letterId);
  const docs = await documents.documentsByIds(db, orgId, ids);
  const out: { mime: string; bytes: Uint8Array; filename: string }[] = [];
  for (const d of docs) {
    if (d.status !== "available") continue;
    const bucket = env[documents.BUCKET_BINDING[d.bucket as keyof typeof documents.BUCKET_BINDING]] as R2Bucket;
    const obj = await bucket.get(d.objectKey);
    if (!obj) continue;
    const raw = new Uint8Array(await obj.arrayBuffer());
    out.push({ mime: d.mime, filename: d.filename, bytes: d.encrypted ? await fc.decryptBytes(`doc:${d.id}`, raw) : raw });
  }
  return out;
}

/** Stores the final PDF and registers it as a document so it downloads through the audited path. */
export async function storeLetterPdf(env: Env, l: { id: string; orgId: string; clientId: string }, pdf: Uint8Array, docId = uuidv7()) {
  const db = dbFor(env);
  const existing = await documents.getDocument(db, l.orgId, docId);
  if (existing) return existing.id;
  const key = `org/${l.orgId}/client/${l.clientId}/letter/${l.id}/${docId}.pdf`;
  await env.LETTERS.put(key, pdf, { httpMetadata: { contentType: "application/pdf" } });
  await documents.insertDocument(db, {
    id: docId,
    orgId: l.orgId,
    clientId: l.clientId,
    type: "letter",
    status: "available",
    bucket: "letters",
    objectKey: key,
    filename: `dispute-letter-${l.id.slice(-8)}.pdf`,
    mime: "application/pdf",
    size: pdf.length,
    encrypted: false,
    uploadedByKind: "system",
    uploadedById: null,
  });
  return docId;
}

/** Who should hear about a letter: the client's assigned specialist, else the author. */
export async function letterOwner(db: DB, orgId: string, l: { clientId: string; createdBy: string }) {
  const c = await clients.getClientRow(db, orgId, l.clientId);
  return c?.assignedStaffId ?? l.createdBy;
}

/**
 * Marks a sent letter overdue, creates a task, and notifies staff and client (R16.4).
 * Shared by the deadline workflow and the daily safety-net sweep (R16.6); compare-and-set makes it idempotent.
 */
export async function markOverdue(env: Env, orgId: string, letterId: string) {
  const db = dbFor(env);
  const l = await letters.getLetter(db, orgId, letterId);
  if (!l) return false;
  const applied = await letters.transitionLetter(db, orgId, letterId, "sent", { status: "overdue" });
  if (!applied) return false;
  const owner = await letterOwner(db, orgId, l);
  await tasks.createTask(db, orgId, { title: `Bureau response overdue: ${l.targetName}`, assigneeId: owner, entityType: "letter", entityId: l.id, createdByKind: "system", dedupeKey: `overdue:${l.id}` });
  await notify(env, [
    { id: `overdue:${l.id}:staff`, orgId, recipient: { kind: "staff", id: owner }, event: "letter_overdue", vars: { link: link(env, `/admin/letters/${l.id}`) } },
    { id: `overdue:${l.id}:client`, orgId, recipient: { kind: "client", id: l.clientId }, event: "letter_overdue", vars: { link: link(env, "/portal/letters") } },
  ]);
  return true;
}
