import { readSecret } from "@da/crypto";
import { AppError } from "@da/shared";
import { type Env, isDevLike } from "../env";

/** Cloudflare's documented dummy token. Only the test environment short-circuits on it (tests have no network). */
export const TEST_TURNSTILE_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

/** R7.7: login, invite acceptance, and password reset. */
export async function verifyTurnstile(env: Env, token: string, ip?: string | null) {
  // Local and test runs accept Cloudflare's dummy token without a network call; deployed envs never do.
  if (isDevLike(env) && token === TEST_TURNSTILE_TOKEN) return;
  if (env.APP_ENV === "test") throw new AppError("turnstile_failed", 400, "Verification failed. Please try again.");
  const body = new FormData();
  body.set("secret", await readSecret(env.TURNSTILE_SECRET, "TURNSTILE_SECRET"));
  body.set("response", token);
  if (ip) body.set("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
  const j = (await res.json()) as { success: boolean };
  if (!j.success) throw new AppError("turnstile_failed", 400, "Verification failed. Please try again.");
}
