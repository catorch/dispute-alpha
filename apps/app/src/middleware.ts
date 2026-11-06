import type { MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";
import { auditRepo, auth as authRepo, orgs } from "@da/db";
import { randomToken, redact, sha256Hex } from "@da/crypto";
import { AppError, type Permission, ROLE_PERMISSIONS, uuidv7 } from "@da/shared";
import { isDevLike } from "./env";
import { verifyAccessJwt } from "./lib/access";
import { type AppEnv, type Ctx, audit, dbFor, fieldCrypto, ipHash } from "./lib/context";
import { log } from "./lib/log";

export const STAFF_IDLE_MS = 30 * 60_000;
export const CLIENT_IDLE_MS = 60 * 60_000;
export const STAFF_COOKIE = "da_staff";
export const CLIENT_COOKIE = "da_client";

/** Request id, per-request services, and the audit collector. */
export const base: MiddlewareHandler<AppEnv> = async (c, next) => {
  const requestId = c.req.header("cf-ray") ?? uuidv7();
  c.set("requestId", requestId);
  c.set("db", dbFor(c.env));
  c.set("fc", fieldCrypto(c.env));
  c.set("audit", []);
  const started = Date.now();
  await next();
  c.header("X-Request-Id", requestId);
  // Sensitive data must never be cached at the edge (R7.6).
  c.header("Cache-Control", "no-store");
  securityHeaders(c);
  const p = c.get("principal");
  log.info("request", { requestId, method: c.req.method, route: c.req.routePath, status: c.res.status, ms: Date.now() - started, actor: p?.id, org: p?.orgId });
};

/** R7.5: headers on every API response (static assets get the same set from public/_headers). */
export function securityHeaders(c: Ctx) {
  c.header("X-Frame-Options", "DENY");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  c.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
}

/** Writes collected audit entries after the handler. Mutations with no explicit entry get a generic one (R19.1). */
export const auditTrail: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  const entries = c.get("audit");
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
  // Edit-lock leases are presence signals, not changes to data, so they are not audited.
  const isLease = c.req.routePath.endsWith("/lock");
  if (!entries.length && mutating && !isLease && c.res.status < 400) audit(c, { action: `${c.req.method} ${c.req.routePath}`, entityType: "request" });
  if (!entries.length) return;
  const ip = await ipHash(c);
  try {
    await auditRepo.insert(c.get("db"), entries.map((e) => ({ ...e, ipHash: e.ipHash ?? ip })));
  } catch (err) {
    log.error("audit_write_failed", { requestId: c.get("requestId"), err: String(err) });
    throw err;
  }
};

export const onError = (err: Error, c: Ctx) => {
  if (err instanceof AppError) return c.json({ error: { code: err.code, message: err.publicMessage, details: err.details } }, err.status);
  if (err instanceof HTTPException) return c.json({ error: { code: "http_error", message: err.message } }, err.status);
  log.error("unhandled", { requestId: c.get("requestId"), route: c.req.routePath, err: err.stack ?? String(err) });
  // Generic body: no stack traces or internals in responses.
  return c.json({ error: { code: "internal", message: "Something went wrong", requestId: c.get("requestId") } }, 500);
};

const cookieOpts = (path: string, maxAgeMs: number) => ({ httpOnly: true, secure: true, sameSite: "Lax" as const, path, maxAge: Math.floor(maxAgeMs / 1000) });

/**
 * Staff: verify the Access JWT on every request (R3.2), map email to an active user (R3.3),
 * and keep an app session with a 30-minute idle timeout (R3.4). After an idle expiry, a session
 * can only be reopened with an Access token issued after the expiry, i.e. a fresh Access login.
 */
export const staffAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const db = c.get("db");
  let email: string;
  let iat = Date.now();
  const devEmail = c.env.APP_ENV === "local" ? (c.req.header("x-dev-staff-email") ?? c.env.DEV_STAFF_EMAIL) : undefined;
  if (devEmail) {
    email = devEmail.toLowerCase();
  } else {
    const token = c.req.header("cf-access-jwt-assertion");
    if (!token) throw new AppError("unauthenticated", 401, "Sign in required");
    try {
      ({ email, iat } = await verifyAccessJwt(c.env, token));
    } catch {
      throw new AppError("unauthenticated", 401, "Invalid access token");
    }
  }
  const user = await orgs.findActiveUserByEmail(db, email);
  if (!user) {
    audit(c, { orgId: null, actorKind: "anonymous", action: "auth.staff.denied", entityType: "user", diff: { email } });
    throw new AppError("forbidden", 403, "Your account does not have access");
  }

  const raw = getCookie(c, STAFF_COOKIE);
  let s = raw ? await authRepo.findSession(db, await sha256Hex(raw)) : undefined;
  if (s && (s.principalKind !== "staff" || s.principalId !== user.id)) s = undefined;
  const now = Date.now();
  if (s && s.expiresAt < now) {
    await authRepo.deleteSession(db, s.id);
    await orgs.setReauthAfter(db, user.id, now);
    deleteCookie(c, STAFF_COOKIE, { path: "/api" });
    throw new AppError("session_expired", 401, "Your session expired. Sign in again.");
  }
  if (s) {
    await authRepo.touchSession(db, s.id, STAFF_IDLE_MS);
  } else {
    if (!devEmail && user.reauthAfter && iat <= user.reauthAfter) throw new AppError("session_expired", 401, "Your session expired. Sign in again.");
    const token = randomToken();
    s = await authRepo.createSession(db, { tokenHash: await sha256Hex(token), principalKind: "staff", principalId: user.id, orgId: user.orgId, idleMs: STAFF_IDLE_MS, ipHash: (await ipHash(c)) ?? undefined });
    setCookie(c, STAFF_COOKIE, token, cookieOpts("/api", 12 * 3600_000));
  }
  c.set("principal", { kind: "staff", id: user.id, orgId: user.orgId, email: user.email, displayName: user.displayName, role: user.role, permissions: ROLE_PERMISSIONS[user.role], sessionId: s.id });
  await next();
};

/** Client portal: cookie session with a 60-minute idle timeout (R4.5). */
export const clientAuth = (opts: { allowMfaPending?: boolean } = {}): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const db = c.get("db");
    const raw = getCookie(c, CLIENT_COOKIE);
    if (!raw) throw new AppError("unauthenticated", 401, "Sign in required");
    const s = await authRepo.findSession(db, await sha256Hex(raw));
    if (!s || s.principalKind !== "client" || s.expiresAt < Date.now()) {
      if (s) await authRepo.deleteSession(db, s.id);
      deleteCookie(c, CLIENT_COOKIE, { path: "/api" });
      throw new AppError("session_expired", 401, "Your session expired. Sign in again.");
    }
    if (s.mfaPending && !opts.allowMfaPending) throw new AppError("mfa_required", 401, "Enter your verification code");
    const acct = await authRepo.getAccount(db, s.principalId);
    if (!acct || acct.status !== "active" || acct.lockedAt) {
      await authRepo.deleteSession(db, s.id);
      throw new AppError("unauthenticated", 401, "Sign in required");
    }
    await authRepo.touchSession(db, s.id, CLIENT_IDLE_MS);
    c.set("principal", { kind: "client", id: acct.id, orgId: acct.orgId, clientId: acct.clientId, email: acct.email, sessionId: s.id, mfaPending: s.mfaPending });
    await next();
  };

export const setClientCookie = (c: Ctx, token: string) => setCookie(c, CLIENT_COOKIE, token, cookieOpts("/api", 12 * 3600_000));
export const clearClientCookie = (c: Ctx) => deleteCookie(c, CLIENT_COOKIE, { path: "/api" });

/** RBAC (R5.3, R5.4): Access proves identity, the app still decides what the user may do. */
export const requirePerm = (perm: Permission): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const p = c.get("principal");
    if (p?.kind !== "staff" || !p.permissions.includes(perm)) {
      audit(c, { action: "denied", entityType: "permission", entityId: perm, diff: { route: c.req.routePath, method: c.req.method } });
      throw new AppError("forbidden", 403, "You do not have permission to do that");
    }
    await next();
  };

/** Rate limit by key; 429 when exceeded (R4.6). */
export async function rateLimit(binding: RateLimit, key: string) {
  const { success } = await binding.limit({ key });
  if (!success) throw new AppError("rate_limited", 429, "Too many attempts. Wait a minute and try again.");
}

/** Validates JSON body or query with a Zod schema; issues are returned without echoing values. */
export async function body<T extends z.ZodType>(c: Ctx, schema: T): Promise<z.output<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new AppError("invalid_json", 400, "Request body must be JSON");
  }
  return parse(schema, raw);
}
export const query = <T extends z.ZodType>(c: Ctx, schema: T): z.output<T> => parse(schema, c.req.query());
export function parse<T extends z.ZodType>(schema: T, raw: unknown): z.output<T> {
  const r = schema.safeParse(raw);
  if (!r.success) throw new AppError("validation_failed", 400, "Some fields are invalid", r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  return r.data;
}

export const devOnly = (c: Ctx) => {
  if (!isDevLike(c.env)) throw new AppError("not_found", 404, "Not found");
};
export { redact };
