/** Pure display and form helpers (unit-tested in format.test.ts). */
import type { DocStatus, LetterStatus, Permission, ReportItemDto, ReportStatus } from "@da/shared";

/** Progressive SSN mask for a text input: keeps up to 9 digits, formats as 123-45-6789. */
export function formatSsnInput(raw: string): string {
  const d = raw.replace(/\D/g, "").slice(0, 9);
  if (d.length <= 3) return d;
  if (d.length <= 5) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
}

/** "pending_approval" -> "Pending approval" */
export const humanize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1).replace(/_/g, " ") : "");

const dateFmt = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });
const dateTimeFmt = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
export const fmtDate = (ms: number | null | undefined) => (ms == null ? "—" : dateFmt.format(ms));
export const fmtDateTime = (ms: number | null | undefined) => (ms == null ? "—" : dateTimeFmt.format(ms));
export const fmtMoney = (n: number | null | undefined) => (n == null ? "—" : money.format(n));
/** Local calendar day as YYYY-MM-DD, for `<input type="date">` defaults. */
export const todayIso = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export type Tone = "gray" | "blue" | "green" | "amber" | "red" | "indigo";
const TONES: Record<string, Tone> = {
  // clients
  intake: "blue", active: "green", paused: "amber", closed: "gray",
  // documents
  scan_pending: "amber", available: "green", rejected: "red", expired: "gray",
  // reports
  requested: "blue", waiting: "blue", parsing: "blue", flagging: "blue", complete: "green", failed: "red",
  // letters
  draft: "gray", pending_approval: "amber", approved: "indigo", rendering: "indigo", ready_to_mail: "blue",
  render_failed: "red", sent: "blue", response_received: "green", overdue: "red",
  // authorization
  none: "gray", signed: "green", declined: "red",
  // tasks & outcomes
  open: "blue", done: "green", deleted: "green", updated: "blue", verified: "amber", no_response: "gray",
};
export const toneOf = (status: string): Tone => TONES[status] ?? "gray";

const DOC_LABELS: Record<DocStatus, string> = { scan_pending: "Scan pending", available: "Available", rejected: "Rejected", expired: "Expired" };
export const docStatusLabel = (s: DocStatus) => DOC_LABELS[s];

/** Report import stepper: index of the current step; failed reports stop where they are. */
export const REPORT_STEPS = ["requested", "waiting", "parsing", "flagging", "complete"] as const satisfies readonly ReportStatus[];
export const reportStepIndex = (s: ReportStatus) => (s === "failed" ? -1 : REPORT_STEPS.indexOf(s));

/** Main path a letter takes; render_failed and overdue are side states shown against it. */
export const LETTER_PATH = ["draft", "pending_approval", "approved", "rendering", "ready_to_mail", "sent", "response_received", "closed"] as const satisfies readonly LetterStatus[];
export function letterPathIndex(s: LetterStatus): number {
  if (s === "render_failed") return LETTER_PATH.indexOf("rendering");
  if (s === "overdue") return LETTER_PATH.indexOf("sent");
  return LETTER_PATH.indexOf(s);
}

export type LetterAction = "edit" | "submit" | "approve" | "reject" | "retry" | "markSent" | "logResponse" | "close" | "followUp";
/** Actions offered for a letter in a given status, filtered by the viewer's permissions. The server re-checks all of them. */
export function letterActions(status: LetterStatus, perms: readonly Permission[]): LetterAction[] {
  const write = perms.includes("letter:write");
  const approve = perms.includes("letter:approve");
  const byStatus: Partial<Record<LetterStatus, [LetterAction, boolean][]>> = {
    draft: [["edit", write], ["submit", write]],
    pending_approval: [["approve", approve], ["reject", approve]],
    render_failed: [["retry", write]],
    ready_to_mail: [["markSent", write]],
    sent: [["logResponse", write]],
    overdue: [["logResponse", write]],
    response_received: [["close", write]],
    closed: [["followUp", write]],
  };
  return (byStatus[status] ?? []).filter(([, ok]) => ok).map(([a]) => a);
}

export function groupBy<T, K>(items: readonly T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const i of items) {
    const k = key(i);
    const arr = m.get(k);
    if (arr) arr.push(i);
    else m.set(k, [i]);
  }
  return m;
}

/** Cross-bureau grouping key: same furnisher (case/punctuation-insensitive) and masked account. */
export const compareKey = (i: Pick<ReportItemDto, "furnisher" | "accountMask" | "itemType">) =>
  `${(i.furnisher ?? "").toLowerCase().replace(/[^a-z0-9]/g, "")}|${i.accountMask ?? ""}|${i.itemType}`;

/** Zod-style issues (client parse or API `details`) to a field -> message map; first message wins. */
export function issuesToMap(issues: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(issues)) return out;
  for (const i of issues as { path?: unknown; message?: unknown }[]) {
    const path = Array.isArray(i.path) ? i.path.join(".") : String(i.path ?? "");
    if (typeof i.message === "string" && !(path in out)) out[path] = i.message;
  }
  return out;
}

/** Stored letter bodies keep `{{client.dob}}` until the PDF render; show a chip instead of the raw token. */
export const renderLetterHtml = (html: string) =>
  html.replace(/\{\{\s*client\.dob\s*\}\}/g, '<span class="dob-chip">DOB inserted at print</span>');

/** Turns an absolute notification link into an in-app path when it points at this origin. */
export function inAppPath(link: string, origin: string): string | null {
  try {
    const u = new URL(link, origin);
    return u.origin === origin ? u.pathname + u.search : null;
  } catch {
    return null;
  }
}

/** Client-facing letter status: plain language, no internal workflow states. */
export function portalLetterLabel(s: LetterStatus): string {
  if (["draft", "pending_approval", "approved", "rendering", "render_failed"].includes(s)) return "Being prepared";
  return { ready_to_mail: "Ready to mail", sent: "Mailed, awaiting response", overdue: "Response past due", response_received: "Response received", closed: "Completed" }[s as string] ?? humanize(s);
}
