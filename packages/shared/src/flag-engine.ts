import type { FlagCondition } from "./schemas";

/** Normalized report item as seen by the rule engine. */
export type RuleItem = {
  id: string;
  bureau: string;
  itemType: string;
  furnisher: string | null;
  accountMask: string | null;
  balance: number | null;
  creditLimit: number | null;
  openedAt: string | null;
  reportedAt: string | null;
  status: string | null;
  details: Record<string, unknown>;
};
export type RuleClient = { firstName: string; lastName: string; address: { line1: string; city: string; state: string; zip: string } };
export type Rule = { id: string; kind: "condition" | "cross_bureau_mismatch"; itemTypes: string[]; condition?: FlagCondition | null; reasonTemplate: string };
export type FlagHit = { itemId: string; ruleId: string; reason: string };

const get = (item: RuleItem, field: string): unknown => {
  const path = field.startsWith("details.") ? field.slice(8).split(".") : [field];
  const root: Record<string, unknown> = field.startsWith("details.") ? item.details : (item as unknown as Record<string, unknown>);
  return path.reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), root);
};
const norm = (v: unknown) => String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");

function test(c: FlagCondition, item: RuleItem, client: RuleClient, now: number): boolean {
  if ("all" in c) return c.all.every((x) => test(x, item, client, now));
  if ("any" in c) return c.any.some((x) => test(x, item, client, now));
  const v = get(item, c.field);
  switch (c.op) {
    case "exists":
      return v !== undefined && v !== null && v !== "";
    case "missing":
      return v === undefined || v === null || v === "";
    case "eq":
      return typeof c.value === "string" ? norm(v) === norm(c.value) : v === c.value;
    case "neq":
      return typeof c.value === "string" ? norm(v) !== norm(c.value) : v !== c.value;
    case "gt":
      return typeof v === "number" && v > Number(c.value);
    case "gte":
      return typeof v === "number" && v >= Number(c.value);
    case "lt":
      return typeof v === "number" && v < Number(c.value);
    case "lte":
      return typeof v === "number" && v <= Number(c.value);
    case "contains":
      return v != null && norm(v).includes(norm(c.value));
    case "in":
      return Array.isArray(c.value) && c.value.map(norm).includes(norm(v));
    case "older_than_years": {
      if (typeof v !== "string") return false;
      const t = Date.parse(v);
      return !Number.isNaN(t) && now - t > Number(c.value) * 365.25 * 864e5;
    }
    case "neq_client": {
      if (v == null || v === "") return false;
      const path = String(c.value).split(".");
      const cv = path.reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), client);
      return cv != null && norm(v) !== norm(cv);
    }
  }
}

const reason = (tpl: string, item: RuleItem) => tpl.replace(/\{\{\s*([a-zA-Z.]+)\s*\}\}/g, (_, f: string) => String(get(item, f) ?? ""));

/** Cross-bureau key: same account reported by several bureaus. */
export const accountKey = (i: RuleItem) => `${i.itemType}|${norm(i.furnisher).replace(/[^a-z0-9]/g, "")}|${norm(i.accountMask)}`;

export function evaluateRules(rules: Rule[], items: RuleItem[], client: RuleClient, now = Date.now()): FlagHit[] {
  const hits: FlagHit[] = [];
  for (const rule of rules) {
    const scoped = items.filter((i) => rule.itemTypes.includes(i.itemType));
    if (rule.kind === "cross_bureau_mismatch") {
      const groups = new Map<string, RuleItem[]>();
      for (const i of scoped) groups.set(accountKey(i), [...(groups.get(accountKey(i)) ?? []), i]);
      for (const g of groups.values()) {
        if (new Set(g.map((i) => i.bureau)).size < 2) continue;
        const differs = new Set(g.map((i) => i.balance)).size > 1 || new Set(g.map((i) => norm(i.status))).size > 1;
        if (differs) for (const i of g) hits.push({ itemId: i.id, ruleId: rule.id, reason: reason(rule.reasonTemplate, i) });
      }
      continue;
    }
    if (!rule.condition) continue;
    for (const i of scoped) if (test(rule.condition, i, client, now)) hits.push({ itemId: i.id, ruleId: rule.id, reason: reason(rule.reasonTemplate, i) });
  }
  return hits;
}

/** Default rule set seeded for a new organization (editable by Org Admin, R13.6). */
export const DEFAULT_FLAG_RULES: (Omit<Rule, "id"> & { name: string })[] = [
  { name: "Collection with $0 balance", kind: "condition", itemTypes: ["collection"], condition: { field: "balance", op: "eq", value: 0 }, reasonTemplate: "Collection from {{furnisher}} reported with a $0 balance" },
  {
    name: "Late payment older than 7 years",
    kind: "condition",
    itemTypes: ["tradeline"],
    condition: { field: "details.lastLateAt", op: "older_than_years", value: 7 },
    reasonTemplate: "Late payment on {{furnisher}} is past the 7-year reporting period",
  },
  { name: "Hard inquiry to confirm", kind: "condition", itemTypes: ["inquiry"], condition: { field: "details.inquiryType", op: "eq", value: "hard" }, reasonTemplate: "Hard inquiry by {{furnisher}}: confirm it was authorized" },
  { name: "Inconsistent across bureaus", kind: "cross_bureau_mismatch", itemTypes: ["tradeline", "collection"], condition: null, reasonTemplate: "{{furnisher}} is reported differently across bureaus" },
  {
    name: "Personal information mismatch",
    kind: "condition",
    itemTypes: ["personal_info"],
    condition: { any: [{ field: "details.lastName", op: "neq_client", value: "lastName" }, { field: "details.zip", op: "neq_client", value: "address.zip" }] },
    reasonTemplate: "Personal information does not match client records",
  },
  { name: "Public record older than 7 years", kind: "condition", itemTypes: ["public_record"], condition: { field: "reportedAt", op: "older_than_years", value: 7 }, reasonTemplate: "Public record from {{reportedAt}} may be obsolete" },
];
