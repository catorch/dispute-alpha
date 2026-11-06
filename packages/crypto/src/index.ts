/**
 * Field-level encryption, keyed HMAC, and key versioning (R6).
 * Every caller goes through FieldCrypto, so swapping Secrets Store for an external KMS
 * means writing one new KeyProvider (R6.7).
 */

const te = new TextEncoder();
const td = new TextDecoder();
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** A Secrets Store binding (`{ get() }`) or a plain string from `.dev.vars` / tests. */
export type SecretBinding = string | { get(): Promise<string> };
export const readSecret = async (s: SecretBinding | undefined, name = "secret"): Promise<string> => {
  if (s === undefined || s === null) throw new Error(`Missing ${name}`);
  return typeof s === "string" ? s : s.get();
};

export interface KeyProvider {
  readonly currentVersion: number;
  getKey(version: number): Promise<CryptoKey>;
}

/** Reads base64 32-byte keys from bindings named ENC_KEY_V1, ENC_KEY_V2, ... */
export class SecretsStoreKeyProvider implements KeyProvider {
  private cache = new Map<number, Promise<CryptoKey>>();
  constructor(
    private env: Record<string, unknown>,
    public readonly currentVersion: number,
  ) {}
  getKey(version: number): Promise<CryptoKey> {
    let k = this.cache.get(version);
    if (!k) {
      k = readSecret(this.env[`ENC_KEY_V${version}`] as SecretBinding, `ENC_KEY_V${version}`).then((raw) => {
        const bytes = unb64(raw.trim());
        if (bytes.length !== 32) throw new Error(`ENC_KEY_V${version} must be 32 bytes base64`);
        return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
      });
      k.catch(() => this.cache.delete(version));
      this.cache.set(version, k);
    }
    return k;
  }
}

const MAGIC = te.encode("DAE1");

export class FieldCrypto {
  private hmacKey?: Promise<CryptoKey>;
  constructor(
    private keys: KeyProvider,
    private hmacSecret: () => Promise<string>,
  ) {}

  /** Returns `v{n}:{iv}:{ct}`. AAD binds the ciphertext to its field so values cannot be swapped between columns. */
  async encrypt(field: string, plaintext: string): Promise<string> {
    const v = this.keys.currentVersion;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode(field) }, await this.keys.getKey(v), te.encode(plaintext));
    return `v${v}:${b64(iv)}:${b64(new Uint8Array(ct))}`;
  }

  async decrypt(field: string, value: string): Promise<string> {
    const m = /^v(\d+):([^:]+):(.+)$/.exec(value);
    if (!m) throw new Error("Malformed ciphertext");
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(m[2]), additionalData: te.encode(field) }, await this.keys.getKey(Number(m[1])), unb64(m[3]));
    return td.decode(pt);
  }

  /** Binary envelope: "DAE1" | version (1 byte) | iv (12) | ciphertext. Used for files in R2. */
  async encryptBytes(aad: string, data: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
    const v = this.keys.currentVersion;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode(aad) }, await this.keys.getKey(v), data));
    const out = new Uint8Array(4 + 1 + 12 + ct.length);
    out.set(MAGIC, 0);
    out[4] = v;
    out.set(iv, 5);
    out.set(ct, 17);
    return out;
  }

  async decryptBytes(aad: string, data: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
    const u = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (!MAGIC.every((b, i) => u[i] === b)) throw new Error("Not an encrypted envelope");
    const key = await this.keys.getKey(u[4]);
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: u.slice(5, 17), additionalData: te.encode(aad) }, key, u.slice(17)));
  }

  /** Keyed HMAC-SHA256 hex, for duplicate detection without decrypting (R6.4). */
  async hmac(value: string): Promise<string> {
    this.hmacKey ??= this.hmacSecret().then((s) => crypto.subtle.importKey("raw", te.encode(s), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]));
    const sig = await crypto.subtle.sign("HMAC", await this.hmacKey, te.encode(value));
    return hex(new Uint8Array(sig));
  }

  /** True when a ciphertext was written with an older key version (rotation job, R6.2). */
  needsRotation(value: string | null | undefined): boolean {
    return !!value && !value.startsWith(`v${this.keys.currentVersion}:`);
  }
  async rotate(field: string, value: string): Promise<string> {
    return this.encrypt(field, await this.decrypt(field, value));
  }
}

export function fieldCryptoFromEnv(env: Record<string, unknown>): FieldCrypto {
  const current = Number(env.ENC_KEY_CURRENT ?? 1);
  return new FieldCrypto(new SecretsStoreKeyProvider(env, current), () => readSecret(env.HMAC_KEY as SecretBinding, "HMAC_KEY"));
}

// ---------- small helpers ----------
export const hex = (u: Uint8Array) => [...u].map((b) => b.toString(16).padStart(2, "0")).join("");
export const sha256Hex = async (s: string) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(s))));
/** URL-safe random token (default 32 bytes = 256 bits). */
export const randomToken = (bytes = 32) => b64(crypto.getRandomValues(new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const timingSafeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
};
export const hmacSha256Hex = async (secret: string, msg: string) => {
  const k = await crypto.subtle.importKey("raw", te.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", k, te.encode(msg))));
};
export { b64, unb64 };

// ---------- log redaction (R6.8, R23.1) ----------
const SENSITIVE = /^(ssn|ssn_?enc|dob|dob_?enc|account_?number|account_?number_?enc|password|password_?hash|token|token_?hash|totp_?secret|body_?html|bodyhtml|secret|authorization|cookie|code|raw|payload)$/i;

export function redact<T>(value: T, depth = 0): T {
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = SENSITIVE.test(k) ? "[REDACTED]" : redact(v, depth + 1);
  return out as T;
}
