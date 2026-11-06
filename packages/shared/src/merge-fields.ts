/**
 * Handlebars-style merge fields for letter templates (R14.2, R14.3).
 * Supported syntax: `{{path.to.value}}` and one loop `{{#each items}}...{{item.field}}...{{/each}}`.
 * All values are HTML-escaped. Unknown fields are an error so a typo never ships in a letter.
 */
export const MERGE_FIELDS = [
  { key: "client.first_name", label: "Client first name" },
  { key: "client.last_name", label: "Client last name" },
  { key: "client.full_name", label: "Client full name" },
  { key: "client.address_block", label: "Client address (multi-line)" },
  { key: "client.ssn_last4", label: "SSN last 4" },
  { key: "client.dob", label: "Date of birth (filled in only on the final PDF)" },
  { key: "sender.name", label: "Sender name" },
  { key: "sender.address_block", label: "Sender address (multi-line)" },
  { key: "target.name", label: "Recipient (bureau or furnisher)" },
  { key: "date", label: "Today's date" },
  { key: "round.number", label: "Dispute round number" },
] as const;
export const ITEM_MERGE_FIELDS = [
  { key: "item.furnisher", label: "Creditor / furnisher" },
  { key: "item.account_mask", label: "Masked account number" },
  { key: "item.bureau", label: "Bureau" },
  { key: "item.type", label: "Item type" },
  { key: "item.status", label: "Reported status" },
  { key: "item.balance", label: "Reported balance" },
  { key: "item.reason", label: "Dispute reason (from flags)" },
] as const;

/**
 * Fields kept as tokens in the stored letter body and resolved only when the PDF is rendered,
 * so decrypted PII never lands in D1 (R6.1).
 */
export const DEFERRED_FIELDS = ["client.dob"] as const;

export class MergeFieldError extends Error {}

const esc = (v: unknown) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const lookup = (ctx: Record<string, unknown>, path: string): unknown =>
  path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), ctx);

const TOKEN = /\{\{\s*([a-z0-9_.]+)\s*\}\}/gi;
const LOOP = /\{\{#each items\}\}([\s\S]*?)\{\{\/each\}\}/g;

/** Multi-line values (address blocks) are passed as arrays and rendered with <br>. */
const fmt = (v: unknown) => (Array.isArray(v) ? v.map(esc).join("<br>") : esc(v));

export function renderTemplate(html: string, ctx: Record<string, unknown>, opts: { defer?: readonly string[]; strict?: boolean } = {}): string {
  const defer = new Set(opts.defer ?? []);
  const strict = opts.strict ?? true;
  const items = (ctx.items as Record<string, unknown>[] | undefined) ?? [];
  const sub = (scope: Record<string, unknown>) => (m: string, key: string) => {
    if (defer.has(key)) return m;
    const v = lookup(scope, key);
    if (v === undefined) {
      if (strict) throw new MergeFieldError(`Unknown merge field {{${key}}}`);
      return m;
    }
    return fmt(v);
  };
  const looped = html.replace(LOOP, (_, inner: string) => items.map((item) => inner.replace(TOKEN, sub({ ...ctx, item }))).join(""));
  return looped.replace(TOKEN, sub(ctx));
}

/** Lists merge-field keys used by a template, for validation in the template editor. */
export function usedFields(html: string): string[] {
  return [...new Set([...html.matchAll(TOKEN)].map((m) => m[1]))];
}

export function validateTemplate(html: string): string[] {
  const known = new Set<string>([...MERGE_FIELDS, ...ITEM_MERGE_FIELDS].map((f) => f.key));
  return usedFields(html).filter((k) => !known.has(k));
}
