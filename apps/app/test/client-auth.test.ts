import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { totpAt } from "../src/lib/totp";
import { Client, TURNSTILE, clientInput, enrollClient, makeEnv, seedOrg } from "./helpers";

const nextStepCode = (secret: string) => totpAt(secret, Math.floor(Date.now() / 30_000) + 1);

async function setup() {
  const t = makeEnv();
  const s = await seedOrg(t);
  const input = clientInput();
  const created = await s.staff.client.json("POST", "/api/v1/clients", input, 201);
  return { t, s, input, clientId: created.id as string };
}

describe("invites and enrollment (R4.1, R4.2, R4.9)", () => {
  it("enrolls with TOTP, logs in, and reaches the portal", async () => {
    const { t, s, input, clientId } = await setup();
    const { portal } = await enrollClient(t, s.staff.client, clientId);
    const me = await portal.json("GET", "/api/v1/portal/me");
    expect(me).toMatchObject({ kind: "client", clientId, email: input.email, mfaType: "totp" });
    // The invite email carries a link but no PII.
    const inv = t.notifications().find((m) => m.event === "invite");
    expect(JSON.stringify(inv)).not.toContain(input.ssn.replace(/-/g, ""));
  });

  it("invites are single-use and expire", async () => {
    const { t, s, clientId } = await setup();
    const { token } = await enrollClient(t, s.staff.client, clientId);
    expect((await new Client(t).get(`/api/v1/auth/client/invite/${token}`)).status).toBe(410);
    const other = await s.staff.client.json("POST", "/api/v1/clients", clientInput(), 201);
    await s.staff.client.json("POST", `/api/v1/clients/${other.id}/invite`, {}, 201);
    const tok2 = String(t.notifications().filter((m) => m.event === "invite").at(-1)?.vars?.link).split("/invite/")[1];
    await env.DB.prepare("UPDATE invite SET expires_at = ? WHERE client_id = ?").bind(Date.now() - 1, other.id).run();
    expect((await new Client(t).get(`/api/v1/auth/client/invite/${tok2}`)).status).toBe(410);
  });

  it("refuses a second invite once the client has an account", async () => {
    const { t, s, clientId } = await setup();
    await enrollClient(t, s.staff.client, clientId);
    expect((await s.staff.client.post(`/api/v1/clients/${clientId}/invite`)).status).toBe(409);
  });

  it("enrolls with email codes", async () => {
    const { t, s, clientId } = await setup();
    await s.staff.client.json("POST", `/api/v1/clients/${clientId}/invite`, {}, 201);
    const token = String(t.notifications().at(-1)?.vars?.link).split("/invite/")[1];
    const portal = new Client(t);
    await portal.json("POST", `/api/v1/auth/client/invite/${token}/start`, { turnstileToken: TURNSTILE, mfaType: "email" });
    const code = String(t.notifications().filter((m) => m.event === "mfa_code").at(-1)?.vars?.code);
    expect((await portal.post(`/api/v1/auth/client/invite/${token}/complete`, { password: "a long enough password", code: code === "000000" ? "111111" : "000000" })).status).toBe(401);
    await portal.json("POST", `/api/v1/auth/client/invite/${token}/complete`, { password: "a long enough password", code });
    expect((await portal.json("GET", "/api/v1/portal/me")).mfaType).toBe("email");
  });

  it("requires Turnstile", async () => {
    const { t, s, clientId } = await setup();
    await s.staff.client.json("POST", `/api/v1/clients/${clientId}/invite`, {}, 201);
    const token = String(t.notifications().at(-1)?.vars?.link).split("/invite/")[1];
    const res = await new Client(t).post(`/api/v1/auth/client/invite/${token}/start`, { turnstileToken: "bad", mfaType: "totp" });
    expect(res.status).toBe(400);
    expect((await res.json<any>()).error.code).toBe("turnstile_failed");
  });
});

describe("login, MFA, lockout (R4.4–R4.7)", () => {
  it("requires MFA before portal access and rotates the session after MFA", async () => {
    const { t, s, input, clientId } = await setup();
    const { secret, password } = await enrollClient(t, s.staff.client, clientId);
    const c = new Client(t);
    expect(await c.json("POST", "/api/v1/auth/client/login", { email: input.email, password, turnstileToken: TURNSTILE })).toEqual({ mfaRequired: true, mfaType: "totp" });
    const preMfa = c.cookies.get("da_client");
    expect((await c.get("/api/v1/portal/me")).status).toBe(401);
    await c.json("POST", "/api/v1/auth/client/mfa", { code: await nextStepCode(secret) });
    expect(c.cookies.get("da_client")).not.toBe(preMfa);
    expect((await c.get("/api/v1/portal/me")).status).toBe(200);
    // The pre-MFA token is dead.
    const stale = new Client(t);
    stale.cookies.set("da_client", preMfa ?? "");
    expect((await stale.get("/api/v1/portal/me")).status).toBe(401);
  });

  it("rejects TOTP replay", async () => {
    const { t, s, input, clientId } = await setup();
    const { secret, password } = await enrollClient(t, s.staff.client, clientId);
    const code = await nextStepCode(secret);
    const a = new Client(t);
    await a.json("POST", "/api/v1/auth/client/login", { email: input.email, password, turnstileToken: TURNSTILE });
    await a.json("POST", "/api/v1/auth/client/mfa", { code });
    const b = new Client(t);
    await b.json("POST", "/api/v1/auth/client/login", { email: input.email, password, turnstileToken: TURNSTILE });
    expect((await b.post("/api/v1/auth/client/mfa", { code })).status).toBe(401);
  });

  it("gives the same error for unknown emails and wrong passwords", async () => {
    const { t, s, input, clientId } = await setup();
    await enrollClient(t, s.staff.client, clientId);
    const c = new Client(t);
    const a = await c.post("/api/v1/auth/client/login", { email: input.email, password: "wrong password!!", turnstileToken: TURNSTILE });
    const b = await c.post("/api/v1/auth/client/login", { email: "nobody@example.test", password: "wrong password!!", turnstileToken: TURNSTILE });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect((await a.json<any>()).error).toEqual((await b.json<any>()).error);
  });

  it("locks the account after 10 failures; staff can unlock", async () => {
    const { t, s, input, clientId } = await setup();
    const { password } = await enrollClient(t, s.staff.client, clientId);
    const c = new Client(t);
    for (let i = 0; i < 10; i++) await c.post("/api/v1/auth/client/login", { email: input.email, password: "wrong password!!", turnstileToken: TURNSTILE });
    const locked = await c.post("/api/v1/auth/client/login", { email: input.email, password, turnstileToken: TURNSTILE });
    expect(locked.status).toBe(423);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'auth.login.lockout'").first<{ n: number }>())?.n).toBeGreaterThan(0);
    await s.staff.client.json("POST", `/api/v1/clients/${clientId}/unlock`);
    expect((await c.post("/api/v1/auth/client/login", { email: input.email, password, turnstileToken: TURNSTILE })).status).toBe(200);
  });

  it("rate limits by IP and by account", async () => {
    const counts = new Map<string, number>();
    const limiter = { limit: async ({ key }: { key: string }) => ({ success: (counts.set(key, (counts.get(key) ?? 0) + 1).get(key) ?? 0) <= 5 }) } as RateLimit;
    const t = makeEnv({ AUTH_LIMIT: limiter });
    const c = new Client(t);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await c.post("/api/v1/auth/client/login", { email: "x@example.test", password: "whatever!!", turnstileToken: TURNSTILE })).status);
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses[5]).toBe(429);
  });

  it("email MFA sends a code on login", async () => {
    const { t, s, input, clientId } = await setup();
    await s.staff.client.json("POST", `/api/v1/clients/${clientId}/invite`, {}, 201);
    const token = String(t.notifications().at(-1)?.vars?.link).split("/invite/")[1];
    const p = new Client(t);
    await p.json("POST", `/api/v1/auth/client/invite/${token}/start`, { turnstileToken: TURNSTILE, mfaType: "email" });
    await p.json("POST", `/api/v1/auth/client/invite/${token}/complete`, { password: "a long enough password", code: String(t.notifications().at(-1)?.vars?.code) });
    const c = new Client(t);
    await c.json("POST", "/api/v1/auth/client/login", { email: input.email, password: "a long enough password", turnstileToken: TURNSTILE });
    const code = String(t.notifications().filter((m) => m.event === "mfa_code").at(-1)?.vars?.code);
    await c.json("POST", "/api/v1/auth/client/mfa", { code });
    expect((await c.get("/api/v1/portal/me")).status).toBe(200);
  });

  it("logs out", async () => {
    const { t, s, clientId } = await setup();
    const { portal } = await enrollClient(t, s.staff.client, clientId);
    await portal.json("POST", "/api/v1/auth/client/logout");
    expect((await portal.get("/api/v1/portal/me")).status).toBe(401);
  });

  it("expires client sessions after 60 idle minutes", async () => {
    const { t, s, clientId } = await setup();
    const { portal } = await enrollClient(t, s.staff.client, clientId);
    await env.DB.prepare("UPDATE session SET expires_at = ? WHERE principal_kind = 'client'").bind(Date.now() - 1).run();
    expect((await portal.get("/api/v1/portal/me")).status).toBe(401);
  });
});

describe("password reset (R4.8)", () => {
  it("never reveals whether an email exists, and resets with a single-use link", async () => {
    const { t, s, input, clientId } = await setup();
    await enrollClient(t, s.staff.client, clientId);
    const c = new Client(t);
    const before = t.notifications().length;
    expect((await c.post("/api/v1/auth/client/reset/request", { email: "nobody@example.test", turnstileToken: TURNSTILE })).status).toBe(202);
    expect(t.notifications().length).toBe(before);
    expect((await c.post("/api/v1/auth/client/reset/request", { email: input.email, turnstileToken: TURNSTILE })).status).toBe(202);
    const token = String(t.notifications().at(-1)?.vars?.link).split("/reset/")[1];
    await c.json("POST", `/api/v1/auth/client/reset/${token}`, { password: "a brand new password", turnstileToken: TURNSTILE });
    expect((await c.post(`/api/v1/auth/client/reset/${token}`, { password: "another new password", turnstileToken: TURNSTILE })).status).toBe(410);
    expect((await c.post("/api/v1/auth/client/login", { email: input.email, password: "a brand new password", turnstileToken: TURNSTILE })).status).toBe(200);
  });

  it("rejects short passwords", async () => {
    const t = makeEnv();
    const res = await new Client(t).post("/api/v1/auth/client/reset/abc", { password: "short", turnstileToken: TURNSTILE });
    expect(res.status).toBe(400);
  });
});

describe("portal authenticator re-enrollment", () => {
  it("switches to a new TOTP secret after confirming a code", async () => {
    const { t, s, clientId } = await setup();
    const { portal } = await enrollClient(t, s.staff.client, clientId);
    const start = await portal.json("POST", "/api/v1/portal/mfa/totp/start");
    expect((await portal.post("/api/v1/portal/mfa/totp/confirm", { enrollmentToken: `${start.enrollmentToken}x`, code: "123456" })).status).toBe(400);
    await portal.json("POST", "/api/v1/portal/mfa/totp/confirm", { enrollmentToken: start.enrollmentToken, code: await totpAt(start.secret, Math.floor(Date.now() / 30_000)) });
  });
});
