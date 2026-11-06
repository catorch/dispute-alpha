import { argon2id } from "@noble/hashes/argon2.js";
import { b64, timingSafeEqual, unb64 } from "@da/crypto";
import type { Env } from "../env";

/** OWASP minimum for Argon2id: 19 MiB, 2 iterations, parallelism 1 (R4.3). */
const PROD = { m: 19456, t: 2, p: 1 };
/** Cheap parameters, honored only when APP_ENV=test so the suite stays fast. */
const TEST = { m: 64, t: 1, p: 1 };
const params = (env: Env) => (env.APP_ENV === "test" && env.PASSWORD_COST === "test" ? TEST : PROD);

/** PHC string: $argon2id$v=19$m=..,t=..,p=..$salt$hash */
export function hashPassword(env: Env, password: string): string {
  const { m, t, p } = params(env);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = argon2id(new TextEncoder().encode(password), salt, { m, t, p, dkLen: 32 });
  return `$argon2id$v=19$m=${m},t=${t},p=${p}$${b64(salt)}$${b64(hash)}`;
}

export function verifyPassword(stored: string, password: string): boolean {
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([^$]+)\$([^$]+)$/.exec(stored);
  if (!m) return false;
  const hash = argon2id(new TextEncoder().encode(password), unb64(m[4]), { m: +m[1], t: +m[2], p: +m[3], dkLen: 32 });
  return timingSafeEqual(b64(hash), m[5]);
}

/** Burns comparable CPU when the account does not exist, so timing does not reveal valid emails. */
export function dummyVerify(env: Env) {
  const { m, t, p } = params(env);
  argon2id(new Uint8Array(8), new Uint8Array(16), { m, t, p, dkLen: 32 });
}
