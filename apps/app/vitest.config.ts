import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { exportJWK, generateKeyPair } from "jose";
import { defineConfig } from "vitest/config";

const b64 = (n: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString("base64");

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      // A throwaway Access signing key: tests sign staff JWTs, the app verifies them via ACCESS_JWKS.
      const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
      const pub = { ...(await exportJWK(publicKey)), kid: "test", alg: "RS256", use: "sig" };
      const priv = { ...(await exportJWK(privateKey)), kid: "test", alg: "RS256" };
      return {
        main: "./src/index.ts",
        miniflare: {
          compatibilityDate: "2026-11-01",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: ["DB"],
          r2Buckets: ["DOCS", "QUARANTINE", "LETTERS", "REPORTS_RAW"],
          queueProducers: { Q_NOTIFY: "notifications", Q_SCAN: "doc-scan", Q_AUDIT_EXPORT: "audit-export" },
          durableObjects: { CLIENT_LOCK: "ClientLock" },
          bindings: {
            APP_ENV: "test",
            PASSWORD_COST: "test",
            PUBLIC_URL: "https://app.test",
            ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
            ACCESS_AUD: "test-aud",
            ACCESS_JWKS: JSON.stringify({ keys: [pub] }),
            TEST_ACCESS_PRIVATE_JWK: JSON.stringify(priv),
            ENC_KEY_V1: b64(32),
            HMAC_KEY: b64(32),
            TURNSTILE_SECRET: "unused-in-test",
            CREDIT_PROVIDER: "fake",
            CREDIT_WEBHOOK_SECRET: "credit-secret",
            ESIGN_PROVIDER: "fake",
            ESIGN_WEBHOOK_SECRET: "esign-secret",
            TWILIO_AUTH_TOKEN: "twilio-token",
            TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "../../migrations")),
          },
        },
      };
    }),
  ],
  test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/setup.ts"] },
});
