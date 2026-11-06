import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

// R27.1: WCAG 2.1 AA checks with axe on every main route, plus a keyboard-only sign-in.
test.skip(!!process.env.BASE_URL, "local stack only");
test.describe.configure({ mode: "serial" });

const STAFF = { "x-dev-staff-email": "admin@local.test" };

async function audit(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  await expect(page.locator("h1").first()).toBeVisible();
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).exclude("iframe").analyze();
  const serious = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  const summary = serious.map((v) => `${v.id} (${v.impact}): ${v.nodes.length} node(s) e.g. ${v.nodes[0]?.target.join(" ")} — ${v.help}`);
  expect(summary, `${path}\n${summary.join("\n")}`).toEqual([]);
}

function totp(secret: string, t = Date.now()) {
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secret) bits += alpha.indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)?.map((b) => Number.parseInt(b, 2)) ?? []);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(t / 30_000)));
  const h = createHmac("sha1", key).update(msg).digest();
  return String((h.readUInt32BE(h[h.length - 1] & 15) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

let clientId = "";
test.beforeAll(async ({ playwright, baseURL }) => {
  const api = await playwright.request.newContext({ baseURL, extraHTTPHeaders: STAFF });
  await api.post("/api/v1/dev/seed");
  const c = await api.post("/api/v1/clients", {
    data: { firstName: "Axe", lastName: "Checker", email: `axe.${Date.now()}@example.test`, phone: "+15125550123", dob: "1980-01-01", ssn: `7${String(Date.now()).slice(-8)}`, address: { line1: "1 Main", city: "Austin", state: "TX", zip: "78701" } },
  });
  clientId = (await c.json()).id;
  await api.post(`/api/v1/clients/${clientId}/reports/import`);
  await api.dispose();
});

test("public pages", async ({ page }) => {
  for (const p of ["/login", "/forgot"]) await audit(page, p);
});

test("staff pages", async ({ browser }) => {
  const ctx = await browser.newContext({ extraHTTPHeaders: STAFF });
  const page = await ctx.newPage();
  for (const p of ["/admin", "/admin/clients", "/admin/clients/new", "/admin/letters", "/admin/tasks", "/admin/users", "/admin/org", "/admin/templates", "/admin/rules", "/admin/audit"]) await audit(page, p);
  for (const tab of ["overview", "timeline", "notes", "documents", "reports", "letters", "audit"]) await audit(page, `/admin/clients/${clientId}?tab=${tab}`);
  await ctx.close();
});

test("dark appearance meets contrast too", async ({ browser }) => {
  const ctx = await browser.newContext({ extraHTTPHeaders: STAFF });
  await ctx.addInitScript(() => localStorage.setItem("da-theme", "dark"));
  const page = await ctx.newPage();
  for (const p of ["/login", "/admin", "/admin/clients", `/admin/clients/${clientId}?tab=reports`, "/admin/letters", "/admin/audit"]) {
    await audit(page, p);
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
  }
  await ctx.close();
});

test("appearance switcher is a keyboard-operable radio group that persists", async ({ browser }) => {
  const ctx = await browser.newContext({ extraHTTPHeaders: STAFF, colorScheme: "dark" });
  const page = await ctx.newPage();
  await page.goto("/admin");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const group = page.getByRole("radiogroup", { name: "Appearance" });
  await group.getByRole("radio", { name: "Light appearance" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(group.getByRole("radio", { name: "Dark appearance" })).toHaveAttribute("aria-checked", "true");
  await expect(group.getByRole("radio", { name: "Dark appearance" })).toBeFocused();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await ctx.close();
});

test("client portal pages at phone width, and keyboard-only sign-in", async ({ browser, playwright, baseURL }) => {
  const staff = await playwright.request.newContext({ baseURL, extraHTTPHeaders: STAFF });
  const email = `axe.portal.${Date.now()}@example.test`;
  const c = await (await staff.post("/api/v1/clients", { data: { firstName: "Pat", lastName: "Portal", email, dob: "1981-02-02", ssn: `6${String(Date.now()).slice(-8)}`, address: { line1: "2 Main", city: "Austin", state: "TX", zip: "78701" } } })).json();
  await staff.post(`/api/v1/clients/${c.id}/invite`);
  await staff.dispose();
  let token = "";
  await expect(async () => {
    const block = readFileSync(process.env.E2E_LOG ?? "", "utf8").split("[email:local]").reverse().find((b) => b.includes(`to=${email}`));
    token = block?.match(/\/invite\/([A-Za-z0-9_-]+)/)?.[1] ?? "";
    expect(token).not.toBe("");
  }).toPass({ timeout: 30_000 });

  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const page = await ctx.newPage();
  const start = await (await page.request.post(`/api/v1/auth/client/invite/${token}/start`, { data: { turnstileToken: "XXXX.DUMMY.TOKEN.XXXX", mfaType: "totp" } })).json();
  expect((await page.request.post(`/api/v1/auth/client/invite/${token}/complete`, { data: { password: "axe portal password!!", code: totp(start.secret) } })).status()).toBe(200);
  for (const p of ["/portal", "/portal/documents", "/portal/reports", "/portal/letters", "/portal/settings"]) await audit(page, p);
  // No horizontal scrolling at 375 px.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

  // Keyboard only: reach the form, type, and submit with Enter.
  await page.request.post("/api/v1/auth/client/logout");
  await page.goto("/login?turnstile=test");
  await page.keyboard.press("Tab");
  for (let i = 0; i < 10 && !(await page.getByLabel("Email").evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
  await expect(page.getByLabel("Email")).toBeFocused();
  await page.keyboard.type(email);
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Password")).toBeFocused();
  await page.keyboard.type("axe portal password!!");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Enter your verification code" })).toBeVisible();
  await expect(page.getByLabel("Verification code")).toBeFocused();
  await ctx.close();
});
