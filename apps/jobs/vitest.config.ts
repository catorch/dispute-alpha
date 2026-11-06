import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const b64 = (n: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString("base64");

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      // Workflow classes are exercised through their run* functions with a fake step, so no
      // workflow or container bindings are needed here; the browser is faked per test.
      main: "./test/entry.ts",
      miniflare: {
        compatibilityDate: "2026-11-01",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
        r2Buckets: ["DOCS", "QUARANTINE", "LETTERS", "REPORTS_RAW", "BACKUPS"],
        bindings: {
          APP_ENV: "test",
          PUBLIC_URL: "https://app.test",
          ENC_KEY_V1: b64(32),
          ENC_KEY_V2: b64(32),
          ENC_KEY_CURRENT: "1",
          HMAC_KEY: b64(32),
          EMAIL_PROVIDER: "memory",
          MAIL_FROM: "no-reply@notify.test",
          CREDIT_PROVIDER: "fake",
          OPS_ALERT_EMAIL: "ops@acme.test",
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "../../migrations")),
        },
      },
    })),
  ],
  test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/setup.ts"] },
});
