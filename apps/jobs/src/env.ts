import type { SecretBinding } from "@da/crypto";
import type { NotifyMessage } from "@da/shared";
import type { ClamAvContainer } from "./container";

export interface Env {
  APP_ENV: "local" | "test" | "staging" | "production";
  PUBLIC_URL: string;

  DB: D1Database;
  DOCS: R2Bucket;
  QUARANTINE: R2Bucket;
  LETTERS: R2Bucket;
  REPORTS_RAW: R2Bucket;
  BACKUPS: R2Bucket;

  Q_NOTIFY: Queue<NotifyMessage>;
  Q_PDF: Queue<PdfRenderMessage>;

  WF_IMPORT: Workflow<ImportParams>;
  WF_LETTER: Workflow<LetterParams>;
  WF_DEADLINE: Workflow<DeadlineParams>;

  BROWSER?: Fetcher;
  EMAIL?: SendEmail;
  CLAMAV?: DurableObjectNamespace<ClamAvContainer>;
  /** Local only: "container" uses the real ClamAV container instead of the EICAR stand-in. */
  SCANNER?: "container";
  METRICS?: AnalyticsEngineDataset;

  ENC_KEY_V1: SecretBinding;
  ENC_KEY_V2?: SecretBinding;
  ENC_KEY_CURRENT?: string;
  HMAC_KEY: SecretBinding;

  EMAIL_PROVIDER: "cloudflare" | "postmark" | "memory";
  MAIL_FROM: string;
  POSTMARK_TOKEN?: SecretBinding;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: SecretBinding;
  TWILIO_FROM?: string;

  CREDIT_PROVIDER: "fake";
  /** Fake provider only: number of "pending" polls before the report is ready. */
  FAKE_PENDING_POLLS?: string;

  OPS_ALERT_EMAIL?: string;
  SLACK_WEBHOOK_URL?: SecretBinding;

  /** D1 export via the REST API (R21.2). */
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: SecretBinding;
  D1_DATABASE_ID?: string;

  SENTRY_DSN?: string;
}

export type ImportParams = { orgId: string; clientId: string; reportId: string };
export type LetterParams = { orgId: string; letterId: string };
export type DeadlineParams = { orgId: string; letterId: string; dueAt: number };
export type PdfRenderMessage = { letterId: string; instanceId: string };
