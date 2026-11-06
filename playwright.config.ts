import { defineConfig, devices } from "@playwright/test";

/**
 * Local (default): boots an isolated stack via scripts/e2e-server.sh and runs every test.
 * Staging/production: set BASE_URL (and CF_ACCESS_CLIENT_ID/SECRET for Access) and run `--grep @smoke`.
 */
const remote = !!process.env.BASE_URL;
const port = process.env.E2E_PORT ?? "8788";
const baseURL = process.env.BASE_URL ?? `http://localhost:${port}`;
const accessHeaders: Record<string, string> =
  process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET
    ? { "CF-Access-Client-Id": process.env.CF_ACCESS_CLIENT_ID, "CF-Access-Client-Secret": process.env.CF_ACCESS_CLIENT_SECRET }
    : {};
process.env.E2E_LOG ??= "/tmp/da-e2e-server.log";

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: { baseURL, extraHTTPHeaders: accessHeaders, trace: "retain-on-failure", ...devices["Desktop Chrome"] },
  webServer: remote
    ? undefined
    : { command: "bash scripts/e2e-server.sh", url: `${baseURL}/api/v1/health`, reuseExistingServer: !process.env.CI, timeout: 240_000, env: { E2E_PORT: port, E2E_LOG: process.env.E2E_LOG } },
});
