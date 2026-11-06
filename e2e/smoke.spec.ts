import { expect, test } from "@playwright/test";

// Safe against any environment: read-only, no data created. Run on staging and after production deploys.
test("@smoke health endpoint reports all bindings healthy", async ({ request }) => {
  const res = await request.get("/api/v1/health");
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, checks: { d1: true, r2: true, queue: true } });
  expect(res.headers()["cache-control"]).toBe("no-store");
});

test("@smoke client sign-in page renders with security headers", async ({ page }) => {
  const res = await page.goto("/login");
  expect(res?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Sign in to your portal" })).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
  const h = res?.headers() ?? {};
  expect(h["x-frame-options"]).toBe("DENY");
  expect(h["content-security-policy"]).toContain("default-src 'self'");
});

test("@smoke unauthenticated API calls are refused", async ({ playwright, baseURL }) => {
  const anon = await playwright.request.newContext({ baseURL });
  expect((await anon.get("/api/v1/portal/me")).status()).toBe(401);
  await anon.dispose();
});
