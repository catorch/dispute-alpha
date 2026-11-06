import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

// Full local journey; needs the local stack (dev seed endpoint, emails in the server log).
test.skip(!!process.env.BASE_URL, "local stack only");
test.describe.configure({ mode: "serial" });

const STAFF = { "x-dev-staff-email": "staff@local.test" };
const APPROVER = { "x-dev-staff-email": "approver@local.test" };

function totp(secret: string, t = Date.now()) {
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secret.replace(/=+$/, "")) bits += alpha.indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)?.map((b) => Number.parseInt(b, 2)) ?? []);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(t / 30_000)));
  const h = createHmac("sha1", key).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, "0");
}

const email = `e2e.${Date.now()}@example.test`;
let clientUrl = "";

test.beforeAll(async ({ request }) => {
  const r = await request.post("/api/v1/dev/seed");
  expect([200, 201]).toContain(r.status());
});

test("staff creates a client, uploads a document, imports a report, drafts letters", async ({ browser }) => {
  const ctx = await browser.newContext({ extraHTTPHeaders: STAFF });
  const page = await ctx.newPage();
  await page.goto("/admin/clients/new");
  await page.getByLabel("First name").fill("Erin");
  await page.getByLabel("Last name").fill("Tester");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Date of birth").fill("1990-06-01");
  await page.getByLabel("Social Security number").fill(`5${String(Date.now()).slice(-8)}`);
  await page.getByLabel("Street address").fill("1 Main St");
  await page.getByLabel("City").fill("Austin");
  await page.getByLabel("State").fill("TX");
  await page.getByLabel("ZIP").fill("78701");
  await page.getByRole("button", { name: "Create client" }).click();
  await expect(page.getByRole("heading", { name: "Erin Tester" })).toBeVisible();
  clientUrl = page.url().split("?")[0];

  // Documents: quarantine → scan (jobs queue consumer) → available.
  await page.getByRole("tab", { name: "Documents" }).click();
  await page.getByLabel("Document type").selectOption("proof_of_address");
  await page.getByLabel("File").setInputFiles({ name: "poa.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%%EOF\n") });
  await page.getByRole("button", { name: "Upload" }).click();
  await expect(page.getByText("Uploaded.")).toBeVisible();
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole("cell", { name: "poa.pdf" }).locator("..").getByText("Available")).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 60_000 });

  // Reports: the import workflow runs in da-jobs.
  await page.getByRole("tab", { name: "Reports" }).click();
  await page.getByRole("button", { name: "Import report" }).click();
  await expect(page.getByLabel("Import progress").getByText("Complete")).toBeVisible({ timeout: 90_000 });

  // Letters: a dispute round from flagged items.
  await page.getByRole("tab", { name: "Letters" }).click();
  await page.getByRole("button", { name: "New dispute round" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Template").selectOption({ index: 1 });
  await dialog.getByRole("button", { name: "Create drafts" }).click();
  // Lands on the first draft, with the stored dispute reasons.
  await expect(page.getByRole("heading", { name: /^Letter to (Equifax|Experian|TransUnion)/ })).toBeVisible();
  await expect(page.getByRole("cell", { name: /reported with a \$0 balance|7-year|across bureaus|Hard inquiry/ }).first()).toBeVisible();
  // Edit in the rich-text editor (holds the client edit lock), then submit for approval.
  const body = page.getByRole("textbox", { name: "Letter body" });
  await body.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" Thank you.");
  await page.getByRole("button", { name: /submit for approval/i }).click();
  await expect(page.getByText(/Pending approval/i).first()).toBeVisible();
  await ctx.close();
});

test("client accepts the invite, enrolls an authenticator, and reaches the portal", async ({ browser }) => {
  const staff = await browser.newContext({ extraHTTPHeaders: STAFF });
  const sp = await staff.newPage();
  await sp.goto(`${clientUrl}?tab=overview`);
  await sp.getByRole("button", { name: "Send portal invite" }).click();
  await expect(sp.getByText("Invite emailed")).toBeVisible();
  await staff.close();

  // Local email goes to the server log (EMAIL_PROVIDER=memory).
  let link = "";
  await expect(async () => {
    const log = readFileSync(process.env.E2E_LOG ?? "", "utf8");
    const block = log.split("[email:local]").reverse().find((b) => b.includes(`to=${email}`) && b.includes("/invite/"));
    link = block?.match(/https?:\/\/\S+\/invite\/[A-Za-z0-9_-]+/)?.[0] ?? "";
    expect(link).not.toBe("");
  }).toPass({ timeout: 30_000 });

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(new URL(link).pathname);
  await expect(page.getByRole("heading", { name: "Welcome, Erin" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  const secret = (await page.getByRole("group", { name: "Authenticator setup key" }).locator("code").innerText()).trim();
  await page.getByLabel("Verification code").fill(totp(secret));
  await page.getByLabel("Password", { exact: true }).fill("e2e password that is long");
  await page.getByLabel("Confirm password").fill("e2e password that is long");
  await page.getByRole("button", { name: /Create account|Finish|Complete/ }).click();
  await expect(page).toHaveURL(/\/portal/);
  await page.goto("/portal/documents");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await ctx.close();
});

test("approvers see the approval queue", async ({ browser }) => {
  const ctx = await browser.newContext({ extraHTTPHeaders: APPROVER });
  const page = await ctx.newPage();
  await page.goto("/admin");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await ctx.close();
});
