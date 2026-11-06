import type { Context } from "hono";
import { type AuditInput, type DB, getDb } from "@da/db";
import { type FieldCrypto, fieldCryptoFromEnv, sha256Hex } from "@da/crypto";
import type { Permission, Role } from "@da/shared";
import type { Env } from "../env";

export type StaffPrincipal = { kind: "staff"; id: string; orgId: string; email: string; displayName: string; role: Role; permissions: readonly Permission[]; sessionId: string };
export type ClientPrincipal = { kind: "client"; id: string; orgId: string; clientId: string; email: string; sessionId: string; mfaPending: boolean };
export type Principal = StaffPrincipal | ClientPrincipal;

export type Vars = {
  requestId: string;
  db: DB;
  fc: FieldCrypto;
  principal?: Principal;
  audit: AuditInput[];
};
export type AppEnv = { Bindings: Env; Variables: Vars };
export type Ctx = Context<AppEnv>;

// One FieldCrypto per isolate so imported keys are cached across requests.
let cached: { env: Env; fc: FieldCrypto } | undefined;
export function fieldCrypto(env: Env) {
  if (cached?.env !== env) cached = { env, fc: fieldCryptoFromEnv(env as unknown as Record<string, unknown>) };
  return cached.fc;
}
export const dbFor = (env: Env) => getDb(env.DB);

export const staff = (c: Ctx) => {
  const p = c.get("principal");
  if (p?.kind !== "staff") throw new Error("staff principal required");
  return p;
};
export const clientP = (c: Ctx) => {
  const p = c.get("principal");
  if (p?.kind !== "client") throw new Error("client principal required");
  return p;
};

export const clientIp = (c: Ctx) => c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
/** IPs are stored hashed: enough to correlate abuse without keeping raw addresses. */
export const ipHash = async (c: Ctx) => {
  const ip = clientIp(c);
  return ip ? (await sha256Hex(`ip:${ip}`)).slice(0, 32) : null;
};

/** Records an audit entry for this request; the audit middleware writes them after the handler. */
export function audit(c: Ctx, e: Omit<AuditInput, "orgId" | "actorKind" | "actorId" | "sessionId" | "requestId"> & Partial<Pick<AuditInput, "orgId" | "actorKind" | "actorId">>) {
  const p = c.get("principal");
  c.get("audit").push({
    orgId: e.orgId ?? p?.orgId ?? null,
    actorKind: e.actorKind ?? p?.kind ?? "anonymous",
    actorId: e.actorId ?? p?.id ?? null,
    sessionId: p?.sessionId ?? null,
    requestId: c.get("requestId"),
    ...e,
  });
}
