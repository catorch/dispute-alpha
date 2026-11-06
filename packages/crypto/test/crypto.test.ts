import { describe, expect, it } from "vitest";
import { FieldCrypto, SecretsStoreKeyProvider, b64, redact, randomToken } from "../src";

const key = () => b64(crypto.getRandomValues(new Uint8Array(32)));
const env = { ENC_KEY_V1: key(), ENC_KEY_V2: key(), HMAC_KEY: "hmac-test-key" };
const fc = (v = 1) => new FieldCrypto(new SecretsStoreKeyProvider(env, v), async () => env.HMAC_KEY);

describe("FieldCrypto", () => {
  it("round-trips and prefixes the key version", async () => {
    const ct = await fc().encrypt("ssn", "123456789");
    expect(ct.startsWith("v1:")).toBe(true);
    expect(ct).not.toContain("123456789");
    expect(await fc().decrypt("ssn", ct)).toBe("123456789");
  });

  it("binds ciphertext to its field (AAD)", async () => {
    const ct = await fc().encrypt("ssn", "123456789");
    await expect(fc().decrypt("dob", ct)).rejects.toThrow();
  });

  it("decrypts old versions after rotation and reports rotation need", async () => {
    const old = await fc(1).encrypt("dob", "1980-01-01");
    const c2 = fc(2);
    expect(c2.needsRotation(old)).toBe(true);
    const rotated = await c2.rotate("dob", old);
    expect(rotated.startsWith("v2:")).toBe(true);
    expect(await c2.decrypt("dob", rotated)).toBe("1980-01-01");
    expect(c2.needsRotation(rotated)).toBe(false);
  });

  it("encrypts bytes with AAD", async () => {
    const data = new TextEncoder().encode("%PDF-1.7 fake");
    const enc = await fc().encryptBytes("doc:1", data);
    expect(new TextDecoder().decode(await fc().decryptBytes("doc:1", enc))).toBe("%PDF-1.7 fake");
    await expect(fc().decryptBytes("doc:2", enc)).rejects.toThrow();
  });

  it("produces a stable keyed HMAC", async () => {
    const a = await fc().hmac("123456789");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await fc(2).hmac("123456789")).toBe(a);
    expect(await new FieldCrypto(new SecretsStoreKeyProvider(env, 1), async () => "other").hmac("123456789")).not.toBe(a);
  });

  it("rejects keys of the wrong size", async () => {
    const bad = new FieldCrypto(new SecretsStoreKeyProvider({ ENC_KEY_V1: b64(new Uint8Array(16)) }, 1), async () => "x");
    await expect(bad.encrypt("ssn", "1")).rejects.toThrow(/32 bytes/);
  });
});

describe("redact", () => {
  it("strips sensitive keys at any depth", () => {
    const out = redact({ ssn: "1", nested: { dob: "x", account_number: "9", ok: 1 }, list: [{ password: "p", bodyHtml: "<p>", name: "n" }] });
    expect(out).toEqual({ ssn: "[REDACTED]", nested: { dob: "[REDACTED]", account_number: "[REDACTED]", ok: 1 }, list: [{ password: "[REDACTED]", bodyHtml: "[REDACTED]", name: "n" }] });
  });
});

it("randomToken is url-safe and long", () => {
  expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
});
