import { Hono } from "hono";
import { auth as authRepo, clients, orgs } from "@da/db";
import { randomToken, sha256Hex } from "@da/crypto";
import { AppError, inviteComplete, inviteStart, loginRequest, mfaRequest, resetComplete, resetRequest } from "@da/shared";
import { type AppEnv, type Ctx, audit, clientIp, clientP, ipHash } from "../lib/context";
import { dummyVerify, hashPassword, verifyPassword } from "../lib/password";
import { link, notify } from "../lib/services";
import { newTotpSecret, otpauthUrl, verifyTotp } from "../lib/totp";
import { verifyTurnstile } from "../lib/turnstile";
import { CLIENT_IDLE_MS, body, clearClientCookie, clientAuth, rateLimit, setClientCookie } from "../middleware";

const MFA_CODE_TTL = 10 * 60_000;
const RESET_TTL = 60 * 60_000;
const MAX_CODE_ATTEMPTS = 5;

const sixDigits = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
const codeHash = (subject: string, code: string) => sha256Hex(`${subject}:${code}`);

async function sendEmailCode(c: Ctx, subjectId: string, orgId: string, email: string) {
  const code = sixDigits();
  await authRepo.createChallenge(c.get("db"), subjectId, await codeHash(subjectId, code), MFA_CODE_TTL);
  await notify(c.env, { id: `mfa:${subjectId}:${Date.now()}`, orgId, recipient: { kind: "email", email }, event: "mfa_code", vars: { code }, channels: ["email"] });
}

/** Checks an email code; returns false on mismatch and burns an attempt. */
async function checkEmailCode(c: Ctx, subjectId: string, code: string) {
  const db = c.get("db");
  const ch = await authRepo.findChallenge(db, subjectId);
  if (!ch || ch.attempts >= MAX_CODE_ATTEMPTS) return false;
  if (ch.codeHash !== (await codeHash(subjectId, code))) {
    await authRepo.bumpChallenge(db, ch.id, ch.attempts + 1);
    return false;
  }
  await authRepo.deleteChallenges(db, subjectId);
  return true;
}

async function newSession(c: Ctx, acct: { id: string; orgId: string }, mfaPending: boolean) {
  const token = randomToken();
  const s = await authRepo.createSession(c.get("db"), {
    tokenHash: await sha256Hex(token),
    principalKind: "client",
    principalId: acct.id,
    orgId: acct.orgId,
    mfaPending,
    idleMs: mfaPending ? MFA_CODE_TTL : CLIENT_IDLE_MS,
    ipHash: (await ipHash(c)) ?? undefined,
  });
  setClientCookie(c, token);
  return s;
}

const invalidCreds = () => new AppError("invalid_credentials", 401, "Email or password is incorrect");

export const authRoutes = new Hono<AppEnv>()
  // ---------- login (R4.4, R4.6, R4.7) ----------
  .post("/client/login", async (c) => {
    const input = await body(c, loginRequest);
    await rateLimit(c.env.AUTH_LIMIT, `ip:${clientIp(c) ?? "unknown"}`);
    await rateLimit(c.env.AUTH_LIMIT, `acct:${input.email}`);
    await verifyTurnstile(c.env, input.turnstileToken, clientIp(c));
    const db = c.get("db");
    const acct = await authRepo.findAccountByEmail(db, input.email);
    if (!acct || acct.status !== "active") {
      dummyVerify(c.env);
      audit(c, { orgId: null, action: "auth.login.failed", entityType: "client_account", diff: { reason: "unknown_account" } });
      throw invalidCreds();
    }
    if (acct.lockedAt) {
      audit(c, { orgId: acct.orgId, actorKind: "client", actorId: acct.id, action: "auth.login.locked", entityType: "client_account", entityId: acct.id });
      throw new AppError("account_locked", 423, "This account is locked. Reset your password or contact your specialist.");
    }
    if (!verifyPassword(acct.passwordHash, input.password)) {
      const n = await authRepo.recordLoginFailure(db, acct);
      audit(c, { orgId: acct.orgId, actorKind: "client", actorId: acct.id, action: n >= authRepo.LOCKOUT_THRESHOLD ? "auth.login.lockout" : "auth.login.failed", entityType: "client_account", entityId: acct.id, diff: { failures: n } });
      throw invalidCreds();
    }
    await authRepo.resetLoginFailures(db, acct.id);
    const s = await newSession(c, acct, true);
    if (acct.mfaType === "email") await sendEmailCode(c, s.id, acct.orgId, acct.email);
    audit(c, { orgId: acct.orgId, actorKind: "client", actorId: acct.id, action: "auth.login.password_ok", entityType: "client_account", entityId: acct.id });
    return c.json({ mfaRequired: true, mfaType: acct.mfaType });
  })

  .post("/client/mfa", clientAuth({ allowMfaPending: true }), async (c) => {
    const p = clientP(c);
    if (!p.mfaPending) return c.json({ ok: true });
    const { code } = await body(c, mfaRequest);
    await rateLimit(c.env.AUTH_LIMIT, `mfa:${p.id}`);
    const db = c.get("db");
    const acct = await authRepo.getAccount(db, p.id);
    if (!acct) throw new AppError("unauthenticated", 401, "Sign in required");
    let ok = false;
    if (acct.mfaType === "totp" && acct.totpSecretEnc) {
      const secret = await c.get("fc").decrypt("client_account.totp", acct.totpSecretEnc);
      const step = await verifyTotp(secret, code, Date.now(), acct.totpLastStep);
      if (step !== null) {
        await authRepo.setTotpStep(db, acct.id, step);
        ok = true;
      }
    } else {
      ok = await checkEmailCode(c, p.sessionId, code);
    }
    if (!ok) {
      const n = await authRepo.recordLoginFailure(db, acct);
      audit(c, { action: "auth.mfa.failed", entityType: "client_account", entityId: acct.id, diff: { failures: n } });
      if (n >= authRepo.LOCKOUT_THRESHOLD) {
        await authRepo.deleteSession(db, p.sessionId);
        throw new AppError("account_locked", 423, "This account is locked. Reset your password or contact your specialist.");
      }
      throw new AppError("invalid_code", 401, "That code is not valid");
    }
    // Rotate the session after MFA so the pre-MFA token cannot be reused (session fixation).
    await authRepo.deleteSession(db, p.sessionId);
    await authRepo.resetLoginFailures(db, acct.id);
    await newSession(c, acct, false);
    audit(c, { action: "auth.login.success", entityType: "client_account", entityId: acct.id });
    return c.json({ ok: true });
  })

  .post("/client/mfa/resend", clientAuth({ allowMfaPending: true }), async (c) => {
    const p = clientP(c);
    await rateLimit(c.env.AUTH_LIMIT, `mfa-resend:${p.id}`);
    const acct = await authRepo.getAccount(c.get("db"), p.id);
    if (p.mfaPending && acct?.mfaType === "email") await sendEmailCode(c, p.sessionId, p.orgId, acct.email);
    return c.json({ ok: true });
  })

  .post("/client/logout", clientAuth({ allowMfaPending: true }), async (c) => {
    await authRepo.deleteSession(c.get("db"), clientP(c).sessionId);
    clearClientCookie(c);
    audit(c, { action: "auth.logout", entityType: "client_account", entityId: clientP(c).id });
    return c.json({ ok: true });
  })

  // ---------- invites (R4.1, R4.2, R4.9) ----------
  .get("/client/invite/:token", async (c) => {
    await rateLimit(c.env.AUTH_LIMIT, `ip:${clientIp(c) ?? "unknown"}`);
    const { inv, client } = await loadInvite(c);
    return c.json({ email: client.email, firstName: client.firstName, expiresAt: inv.expiresAt });
  })

  .post("/client/invite/:token/start", async (c) => {
    const input = await body(c, inviteStart);
    await rateLimit(c.env.AUTH_LIMIT, `ip:${clientIp(c) ?? "unknown"}`);
    await verifyTurnstile(c.env, input.turnstileToken, clientIp(c));
    const { inv, client } = await loadInvite(c);
    const db = c.get("db");
    if (input.mfaType === "totp") {
      const secret = newTotpSecret();
      await authRepo.setInviteEnrollment(db, inv.id, "totp", await c.get("fc").encrypt("invite.totp", secret));
      return c.json({ mfaType: "totp", secret, otpauthUrl: otpauthUrl(secret, client.email) });
    }
    await authRepo.setInviteEnrollment(db, inv.id, "email", null);
    await sendEmailCode(c, inv.id, inv.orgId, client.email);
    return c.json({ mfaType: "email", sent: true });
  })

  .post("/client/invite/:token/complete", async (c) => {
    const input = await body(c, inviteComplete);
    await rateLimit(c.env.AUTH_LIMIT, `ip:${clientIp(c) ?? "unknown"}`);
    const { inv, client } = await loadInvite(c);
    const db = c.get("db");
    const fc = c.get("fc");
    if (!inv.mfaType) throw new AppError("mfa_enrollment_required", 400, "Choose a verification method first");
    let totpSecretEnc: string | null = null;
    if (inv.mfaType === "totp") {
      if (!inv.pendingTotpEnc) throw new AppError("mfa_enrollment_required", 400, "Choose a verification method first");
      const secret = await fc.decrypt("invite.totp", inv.pendingTotpEnc);
      if ((await verifyTotp(secret, input.code)) === null) throw new AppError("invalid_code", 401, "That code is not valid");
      totpSecretEnc = await fc.encrypt("client_account.totp", secret);
    } else if (!(await checkEmailCode(c, inv.id, input.code))) {
      throw new AppError("invalid_code", 401, "That code is not valid");
    }
    if (await authRepo.findAccountByEmail(db, client.email)) throw new AppError("account_exists", 409, "An account already exists for this email. Sign in instead.");
    const acct = await authRepo.createAccount(db, { orgId: inv.orgId, clientId: client.id, email: client.email, passwordHash: hashPassword(c.env, input.password), mfaType: inv.mfaType, totpSecretEnc });
    await authRepo.acceptInvite(db, inv.id);
    await newSession(c, acct, false);
    audit(c, { orgId: inv.orgId, actorKind: "client", actorId: acct.id, action: "invite.accepted", entityType: "client", entityId: client.id });
    return c.json({ ok: true });
  })

  // ---------- password reset (R4.8) ----------
  .post("/client/reset/request", async (c) => {
    const input = await body(c, resetRequest);
    await rateLimit(c.env.AUTH_LIMIT, `ip:${clientIp(c) ?? "unknown"}`);
    await verifyTurnstile(c.env, input.turnstileToken, clientIp(c));
    const db = c.get("db");
    const acct = await authRepo.findAccountByEmail(db, input.email);
    if (acct && acct.status === "active") {
      const token = randomToken();
      await authRepo.createReset(db, acct.id, await sha256Hex(token), RESET_TTL);
      await notify(c.env, { id: `reset:${acct.id}:${Date.now()}`, orgId: acct.orgId, recipient: { kind: "email", email: acct.email }, event: "password_reset", vars: { link: link(c.env, `/reset/${token}`) }, channels: ["email"] });
      audit(c, { orgId: acct.orgId, actorKind: "client", actorId: acct.id, action: "auth.reset.requested", entityType: "client_account", entityId: acct.id });
    }
    // Same response either way: never reveal whether an email has an account.
    return c.json({ ok: true }, 202);
  })

  .post("/client/reset/:token", async (c) => {
    const input = await body(c, resetComplete);
    await rateLimit(c.env.AUTH_LIMIT, `ip:${clientIp(c) ?? "unknown"}`);
    await verifyTurnstile(c.env, input.turnstileToken, clientIp(c));
    const db = c.get("db");
    const r = await authRepo.findReset(db, await sha256Hex(c.req.param("token")));
    if (!r || r.usedAt || r.expiresAt < Date.now()) throw new AppError("reset_invalid", 410, "This reset link is invalid or has expired");
    const acct = await authRepo.getAccount(db, r.clientAccountId);
    if (!acct) throw new AppError("reset_invalid", 410, "This reset link is invalid or has expired");
    await authRepo.useReset(db, r.id);
    await authRepo.setPassword(db, acct.id, hashPassword(c.env, input.password));
    await authRepo.deletePrincipalSessions(db, "client", acct.id);
    audit(c, { orgId: acct.orgId, actorKind: "client", actorId: acct.id, action: "auth.reset.completed", entityType: "client_account", entityId: acct.id });
    return c.json({ ok: true });
  });

async function loadInvite(c: Ctx) {
  const db = c.get("db");
  const inv = await authRepo.findInvite(db, await sha256Hex(c.req.param("token") ?? ""));
  if (!inv || inv.acceptedAt || inv.expiresAt < Date.now()) throw new AppError("invite_invalid", 410, "This invitation is invalid or has expired");
  const client = await clients.getClientRow(db, inv.orgId, inv.clientId);
  if (!client) throw new AppError("invite_invalid", 410, "This invitation is invalid or has expired");
  return { inv, client };
}

/** Issues a portal invite (R9.5). Used by the staff clients routes. */
export async function issueInvite(c: Ctx, orgId: string, clientId: string, createdBy: string) {
  const db = c.get("db");
  const org = await orgs.getOrg(db, orgId);
  const days = org?.settings.inviteExpiryDays ?? 7;
  const token = randomToken();
  const inv = await authRepo.createInvite(db, { orgId, clientId, tokenHash: await sha256Hex(token), expiresAt: Date.now() + days * 864e5, createdBy });
  const client = await clients.getClientRow(db, orgId, clientId);
  if (!client) throw new AppError("not_found", 404, "Client not found");
  await notify(c.env, { id: `invite:${inv.id}`, orgId, recipient: { kind: "email", email: client.email }, event: "invite", vars: { orgName: org?.name, link: link(c.env, `/invite/${token}`), days }, channels: ["email"] });
  // The raw token goes only to the client's inbox, never back to staff.
  return { inviteId: inv.id, expiresAt: inv.expiresAt };
}
