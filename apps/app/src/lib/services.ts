import { readSecret } from "@da/crypto";
import { DropboxSignProvider, type ESignProvider, FakeCreditProvider, FakeESignProvider, type CreditProvider } from "@da/providers";
import type { NotifyMessage } from "@da/shared";
import type { Env } from "../env";

/** All notification sending goes through the queue, never inline (R18.1). */
export async function notify(env: Env, msgs: NotifyMessage | NotifyMessage[]) {
  const list = Array.isArray(msgs) ? msgs : [msgs];
  if (!list.length) return;
  if (list.length === 1) await env.Q_NOTIFY.send(list[0]);
  else await env.Q_NOTIFY.sendBatch(list.map((body) => ({ body })));
}

export const link = (env: Env, path: string) => `${env.PUBLIC_URL.replace(/\/$/, "")}${path}`;

export async function esignProvider(env: Env): Promise<ESignProvider> {
  if (env.ESIGN_PROVIDER === "dropbox_sign") return new DropboxSignProvider(await readSecret(env.ESIGN_API_KEY, "ESIGN_API_KEY"), { testMode: env.APP_ENV !== "production" });
  return new FakeESignProvider(env.ESIGN_WEBHOOK_SECRET ? await readSecret(env.ESIGN_WEBHOOK_SECRET) : undefined);
}

export async function creditProvider(env: Env): Promise<CreditProvider> {
  // Only the fake exists until the vendor is chosen (decision D6).
  return new FakeCreditProvider({ webhookSecret: env.CREDIT_WEBHOOK_SECRET ? await readSecret(env.CREDIT_WEBHOOK_SECRET) : undefined });
}

/** Analytics Engine data point (R23.3); a missing binding is a no-op. */
export function metric(env: Env, name: string, orgId: string, value = 1) {
  env.METRICS?.writeDataPoint({ indexes: [orgId], blobs: [name], doubles: [value] });
}
