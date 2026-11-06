import type { SecretBinding } from "@da/crypto";
import type { NotifyMessage } from "@da/shared";
import type { ClientLock } from "./durable/client-lock";

export type AppEnvName = "local" | "test" | "staging" | "production";

export interface Env {
  APP_ENV: AppEnvName;
  PUBLIC_URL: string;
  /** Cloudflare Access team domain, e.g. "acme.cloudflareaccess.com" */
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  /** JWKS JSON override; honored only when APP_ENV is local or test. */
  ACCESS_JWKS?: string;
  /** Local development only: act as this staff email without Access. */
  DEV_STAFF_EMAIL?: string;
  PASSWORD_COST?: "test";

  DB: D1Database;
  DOCS: R2Bucket;
  QUARANTINE: R2Bucket;
  LETTERS: R2Bucket;
  REPORTS_RAW: R2Bucket;

  Q_NOTIFY: Queue<NotifyMessage>;
  Q_SCAN: Queue<{ documentId: string }>;
  Q_AUDIT_EXPORT: Queue<{ exportId: string }>;

  WF_IMPORT: Workflow<{ orgId: string; clientId: string; reportId: string }>;
  WF_LETTER: Workflow<{ orgId: string; letterId: string }>;
  WF_DEADLINE: Workflow<{ orgId: string; letterId: string; dueAt: number }>;

  CLIENT_LOCK: DurableObjectNamespace<ClientLock>;
  AUTH_LIMIT: RateLimit;
  IMPORT_LIMIT: RateLimit;
  METRICS?: AnalyticsEngineDataset;

  ENC_KEY_V1: SecretBinding;
  ENC_KEY_V2?: SecretBinding;
  ENC_KEY_CURRENT?: string;
  HMAC_KEY: SecretBinding;
  TURNSTILE_SECRET: SecretBinding;

  CREDIT_PROVIDER: "fake";
  CREDIT_WEBHOOK_SECRET?: SecretBinding;
  ESIGN_PROVIDER: "dropbox_sign" | "fake";
  ESIGN_API_KEY?: SecretBinding;
  ESIGN_TEMPLATE_ID?: string;
  ESIGN_WEBHOOK_SECRET?: SecretBinding;
  TWILIO_AUTH_TOKEN?: SecretBinding;
  SENTRY_DSN?: string;
}

export const isDevLike = (env: Env) => env.APP_ENV === "local" || env.APP_ENV === "test";
