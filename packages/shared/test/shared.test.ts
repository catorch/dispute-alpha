import { describe, expect, it } from "vitest";
import {
  DEFAULT_FLAG_RULES,
  MergeFieldError,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  ROLES,
  TEMPLATES,
  NOTIFY_EVENTS,
  can,
  clientCreate,
  loginRequest,
  evaluateRules,
  renderTemplate,
  uuidv7,
  validateTemplate,
  type RuleItem,
} from "../src";

describe("permissions", () => {
  it("every role has a list and only org_admin manages users and settings", () => {
    for (const r of ROLES) expect(ROLE_PERMISSIONS[r].length).toBeGreaterThan(0);
    expect(can("org_admin", "user:write")).toBe(true);
    expect(can("staff", "user:write")).toBe(false);
    expect(can("approver", "user:write")).toBe(false);
  });
  it("only approver and org_admin can approve letters", () => {
    expect(can("staff", "letter:approve")).toBe(false);
    expect(can("approver", "letter:approve")).toBe(true);
    expect(can("org_admin", "letter:approve")).toBe(true);
  });
  it("org_admin has every permission", () => expect([...ROLE_PERMISSIONS.org_admin].sort()).toEqual([...PERMISSIONS].sort()));
});

describe("renderTemplate", () => {
  const ctx = {
    client: { first_name: "Ana", last_name: "<Ruiz>", address_block: ["1 Main St", "Austin, TX 78701"], ssn_last4: "6789", dob: "1980-01-01" },
    date: "2026-11-05",
    items: [
      { furnisher: "Acme Bank", account_mask: "****1234" },
      { furnisher: "Zeta", account_mask: "****9999" },
    ],
  };
  it("escapes values and renders multi-line arrays", () => {
    const out = renderTemplate("<p>{{client.first_name}} {{client.last_name}}</p><p>{{client.address_block}}</p>", ctx);
    expect(out).toBe("<p>Ana &lt;Ruiz&gt;</p><p>1 Main St<br>Austin, TX 78701</p>");
  });
  it("loops over items", () => {
    const out = renderTemplate("<ul>{{#each items}}<li>{{item.furnisher}} {{item.account_mask}}</li>{{/each}}</ul>", ctx);
    expect(out).toBe("<ul><li>Acme Bank ****1234</li><li>Zeta ****9999</li></ul>");
  });
  it("keeps deferred PII tokens for render time", () => {
    const stored = renderTemplate("DOB: {{client.dob}} SSN: xxx-xx-{{client.ssn_last4}}", ctx, { defer: ["client.dob"] });
    expect(stored).toBe("DOB: {{client.dob}} SSN: xxx-xx-6789");
    expect(renderTemplate(stored, { client: { dob: "1980-01-01" } })).toBe("DOB: 1980-01-01 SSN: xxx-xx-6789");
  });
  it("throws on unknown fields", () => {
    expect(() => renderTemplate("{{client.ssn}}", ctx)).toThrow(MergeFieldError);
    expect(validateTemplate("{{client.ssn}} {{client.first_name}} {{item.furnisher}}")).toEqual(["client.ssn"]);
  });
});

describe("evaluateRules", () => {
  const base: RuleItem = { id: "", bureau: "equifax", itemType: "collection", furnisher: "Acme", accountMask: "****1", balance: 0, creditLimit: null, openedAt: "2020-01-01", reportedAt: "2024-01-01", status: "collection", details: {} };
  const rules = DEFAULT_FLAG_RULES.map((r, i) => ({ ...r, id: `r${i}` }));
  const client = { firstName: "Ana", lastName: "Ruiz", address: { line1: "1 Main", city: "Austin", state: "TX", zip: "78701" } };
  const now = Date.parse("2026-11-05");

  it("flags zero-balance collections, old lates, hard inquiries, old public records", () => {
    const items: RuleItem[] = [
      { ...base, id: "c0" },
      { ...base, id: "c1", balance: 50 },
      { ...base, id: "t1", itemType: "tradeline", balance: 100, details: { lastLateAt: "2018-03-01" } },
      { ...base, id: "t2", itemType: "tradeline", balance: 100, details: { lastLateAt: "2023-03-01" } },
      { ...base, id: "i1", itemType: "inquiry", details: { inquiryType: "hard" } },
      { ...base, id: "i2", itemType: "inquiry", details: { inquiryType: "soft" } },
      { ...base, id: "p1", itemType: "public_record", reportedAt: "2017-06-01" },
    ];
    const hits = evaluateRules(rules, items, client, now);
    const ids = new Set(hits.map((h) => h.itemId));
    expect([...ids].sort()).toEqual(["c0", "i1", "p1", "t1"]);
    expect(hits.find((h) => h.itemId === "c0")?.reason).toBe("Collection from Acme reported with a $0 balance");
  });

  it("flags accounts reported differently across bureaus", () => {
    const items: RuleItem[] = [
      { ...base, id: "a", itemType: "tradeline", balance: 100 },
      { ...base, id: "b", itemType: "tradeline", bureau: "experian", balance: 250 },
      { ...base, id: "c", itemType: "tradeline", bureau: "transunion", furnisher: "Other", balance: 5 },
    ];
    const hits = evaluateRules(rules.filter((r) => r.kind === "cross_bureau_mismatch"), items, client, now);
    expect(hits.map((h) => h.itemId).sort()).toEqual(["a", "b"]);
  });

  it("flags personal info that differs from the client record", () => {
    const items: RuleItem[] = [
      { ...base, id: "pi1", itemType: "personal_info", details: { lastName: "RUIZ", zip: "78701" } },
      { ...base, id: "pi2", itemType: "personal_info", details: { lastName: "Smith" } },
    ];
    expect(evaluateRules(rules, items, client, now).map((h) => h.itemId)).toEqual(["pi2"]);
  });
});

describe("notification templates", () => {
  it("never reference sensitive data", () => {
    const vars = { orgName: "Org", link: "https://app/x", code: "123456", days: 3, counts: { tasks: 1, overdue: 2, uploads: 3 }, detail: "d" };
    for (const e of NOTIFY_EVENTS) {
      const r = TEMPLATES[e](vars);
      const all = `${r.subject} ${r.text} ${r.inApp}`.toLowerCase();
      for (const bad of ["ssn", "social security", "account number", "date of birth", "balance"]) expect(all, `${e} mentions ${bad}`).not.toContain(bad);
    }
  });
});

describe("schemas", () => {
  it("uses plain-English validation messages", () => {
    const r = loginRequest.safeParse({ email: "nope", password: "", turnstileToken: "" });
    const msgs = Object.fromEntries((r.success ? [] : r.error.issues).map((i) => [i.path.join("."), i.message]));
    expect(msgs).toEqual({ email: "Enter a valid email address", password: "Enter your password", turnstileToken: "Complete the verification" });
    const c = clientCreate.safeParse({ firstName: "", lastName: "x".repeat(101) });
    const cm = Object.fromEntries((c.success ? [] : c.error.issues).map((i) => [i.path.join("."), i.message]));
    expect(cm.firstName).toBe("This field is required");
    expect(cm.lastName).toBe("Use 100 characters or fewer");
    expect(cm.dob).toBe("This field is required");
    expect(JSON.stringify(cm)).not.toMatch(/Too small|expected/);
  });

  it("normalizes SSNs and rejects bad ones", () => {
    const ok = clientCreate.parse({ firstName: "A", lastName: "B", email: "A@X.COM", dob: "1980-01-01", ssn: "123-45-6789", address: { line1: "1", city: "c", state: "tx", zip: "78701" } });
    expect(ok.ssn).toBe("123456789");
    expect(ok.email).toBe("a@x.com");
    expect(ok.address.state).toBe("TX");
    expect(clientCreate.safeParse({ ...ok, ssn: "12345" }).success).toBe(false);
  });
});

it("uuidv7 is time-ordered and versioned", () => {
  const a = uuidv7(1000);
  const b = uuidv7(2000);
  expect(a < b).toBe(true);
  expect(a[14]).toBe("7");
});
