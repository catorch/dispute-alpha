import { documents } from "@da/db";

type DocumentRow = documents.DocumentRow;
import { AppError, UPLOAD_MAX_BYTES, UPLOAD_MIME, UPLOADABLE_DOC_TYPES, uuidv7 } from "@da/shared";
import type { Env } from "../env";
import { type Ctx, audit } from "./context";

type Mime = (typeof UPLOAD_MIME)[number];

/** Detects the real type from magic bytes; the browser-supplied MIME type is not trusted. */
export function sniffMime(head: Uint8Array): Mime | null {
  const s = (a: number, b: number) => String.fromCharCode(...head.slice(a, b));
  if (s(0, 5) === "%PDF-") return "application/pdf";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head[0] === 0x89 && s(1, 4) === "PNG") return "image/png";
  if (s(4, 8) === "ftyp" && ["heic", "heix", "hevc", "mif1", "msf1"].includes(s(8, 12))) return "image/heic";
  return null;
}

const safeName = (n: string) => n.replace(/[\\/\r\n"]/g, "_").slice(0, 200) || "upload";

/** R10.1, R10.2: validate, store in quarantine under an id-only key, enqueue a scan. */
export async function acceptUpload(c: Ctx, who: { orgId: string; clientId: string; kind: "staff" | "client"; id: string }) {
  const len = Number(c.req.header("content-length") ?? 0);
  if (len > UPLOAD_MAX_BYTES + 64 * 1024) throw new AppError("too_large", 413, "Files must be 25 MB or smaller");
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    throw new AppError("invalid_upload", 400, "Send the file as multipart form data");
  }
  const file = form.get("file");
  const type = String(form.get("type") ?? "");
  if (!(file instanceof File)) throw new AppError("invalid_upload", 400, "Attach a file");
  if (!(UPLOADABLE_DOC_TYPES as readonly string[]).includes(type)) throw new AppError("invalid_type", 400, "Choose a document type");
  if (file.size > UPLOAD_MAX_BYTES) throw new AppError("too_large", 413, "Files must be 25 MB or smaller");
  if (file.size === 0) throw new AppError("invalid_upload", 400, "The file is empty");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = sniffMime(bytes.slice(0, 16));
  if (!mime) throw new AppError("unsupported_type", 415, "Upload a PDF, JPEG, PNG, or HEIC file");

  const id = uuidv7();
  const key = documents.docKey(who.orgId, who.clientId, id);
  await c.env.QUARANTINE.put(key, bytes, { httpMetadata: { contentType: mime } });
  const row = await documents.insertDocument(c.get("db"), {
    id,
    orgId: who.orgId,
    clientId: who.clientId,
    type,
    status: "scan_pending",
    bucket: "quarantine",
    objectKey: key,
    filename: safeName(file.name),
    mime,
    size: bytes.length,
    encrypted: false,
    uploadedByKind: who.kind,
    uploadedById: who.id,
  });
  await c.env.Q_SCAN.send({ documentId: id });
  audit(c, { action: "document.uploaded", entityType: "document", entityId: id, diff: { type, mime, size: bytes.length, clientId: who.clientId } });
  return documents.toDocumentDto(row);
}

export const bucketFor = (env: Env, d: DocumentRow): R2Bucket => env[documents.BUCKET_BINDING[d.bucket as keyof typeof documents.BUCKET_BINDING]];

/** R10.9: authorized, audited streaming download. Never a presigned or public URL. */
export async function streamDocument(c: Ctx, d: DocumentRow) {
  if (d.status !== "available") throw new AppError("not_available", 409, d.status === "scan_pending" ? "Scan pending" : "This document is not available");
  const obj = await bucketFor(c.env, d).get(d.objectKey);
  if (!obj) throw new AppError("not_found", 404, "Document not found");
  audit(c, { action: "document.download", entityType: "document", entityId: d.id, diff: { clientId: d.clientId, type: d.type } });
  const headers = {
    "Content-Type": d.mime,
    "Content-Disposition": `attachment; filename="${d.filename.replace(/[^\x20-\x7e]/g, "_")}"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (d.encrypted) {
    const plain = await c.get("fc").decryptBytes(`doc:${d.id}`, await obj.arrayBuffer());
    return new Response(plain, { headers });
  }
  return new Response(obj.body, { headers });
}
