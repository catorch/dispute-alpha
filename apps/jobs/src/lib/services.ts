import { type DB, getDb } from "@da/db";
import { type FieldCrypto, fieldCryptoFromEnv, readSecret } from "@da/crypto";
import {
  CloudflareEmailSender,
  type CreditProvider,
  type EmailSender,
  FakeCreditProvider,
  MemoryEmailSender,
  PostmarkEmailSender,
  type SmsSender,
  TwilioSmsSender,
} from "@da/providers";
import type { NotifyMessage } from "@da/shared";
import type { Env } from "../env";

let cachedFc: { env: Env; fc: FieldCrypto } | undefined;
export function fieldCrypto(env: Env) {
  if (cachedFc?.env !== env) cachedFc = { env, fc: fieldCryptoFromEnv(env as unknown as Record<string, unknown>) };
  return cachedFc.fc;
}
export const dbFor = (env: Env): DB => getDb(env.DB);

const memoryEmail = new MemoryEmailSender();

/** Selected by EMAIL_PROVIDER, so the beta Email Service can be swapped for Postmark by config (R18.3). */
export async function emailSender(env: Env): Promise<EmailSender> {
  if (env.EMAIL_PROVIDER === "postmark") return new PostmarkEmailSender(await readSecret(env.POSTMARK_TOKEN, "POSTMARK_TOKEN"), env.MAIL_FROM);
  if (env.EMAIL_PROVIDER === "cloudflare") {
    if (!env.EMAIL) throw new Error("EMAIL binding missing");
    return new CloudflareEmailSender(env.EMAIL, env.MAIL_FROM);
  }
  if (env.APP_ENV === "production") throw new Error("Memory email sender is not allowed in production");
  return memoryEmail;
}

export async function smsSender(env: Env): Promise<SmsSender | null> {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM) return null;
  return new TwilioSmsSender(env.TWILIO_ACCOUNT_SID, await readSecret(env.TWILIO_AUTH_TOKEN), env.TWILIO_FROM);
}

export function creditProvider(env: Env): CreditProvider {
  return new FakeCreditProvider({ pendingPolls: Number(env.FAKE_PENDING_POLLS ?? 0) });
}

export async function notify(env: Env, msgs: NotifyMessage | NotifyMessage[]) {
  const list = Array.isArray(msgs) ? msgs : [msgs];
  if (list.length) await env.Q_NOTIFY.sendBatch(list.map((body) => ({ body })));
}

export const link = (env: Env, path: string) => `${env.PUBLIC_URL.replace(/\/$/, "")}${path}`;

export function metric(env: Env, name: string, orgId: string, value = 1) {
  env.METRICS?.writeDataPoint({ indexes: [orgId], blobs: [name], doubles: [value] });
}

/**
 * Operations alert (R23.4). Sent directly, not through the notifications queue, so an alert
 * about that queue cannot loop back into it. Never include PII in `detail`.
 */
export async function opsAlert(env: Env, subject: string, detail: string) {
  console.error(JSON.stringify({ level: "error", msg: "ops_alert", subject, detail }));
  const tasks: Promise<unknown>[] = [];
  if (env.OPS_ALERT_EMAIL) tasks.push(emailSender(env).then((s) => s.send({ to: env.OPS_ALERT_EMAIL as string, subject: `[Dispute Alpha ${env.APP_ENV}] ${subject}`, text: detail })));
  if (env.SLACK_WEBHOOK_URL)
    tasks.push(readSecret(env.SLACK_WEBHOOK_URL).then((url) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: `*${subject}* (${env.APP_ENV})\n${detail}` }) })));
  const results = await Promise.allSettled(tasks);
  for (const r of results) if (r.status === "rejected") console.error(JSON.stringify({ level: "error", msg: "ops_alert_failed", err: String(r.reason) }));
}

export { memoryEmail };
