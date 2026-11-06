/**
 * Sessions, client portal accounts, invites, password resets, MFA challenges.
 * Lookups by token hash or email are deliberately not org-scoped: they establish the principal.
 */
import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import { uuidv7 } from "@da/shared";
import type { DB } from "../client";
import { clientAccount, invite, mfaChallenge, passwordReset, session } from "../schema";

export type SessionRow = typeof session.$inferSelect;

export async function createSession(db: DB, s: { tokenHash: string; principalKind: "staff" | "client"; principalId: string; orgId: string; mfaPending?: boolean; idleMs: number; ipHash?: string }) {
  const now = Date.now();
  const row = { id: uuidv7(), tokenHash: s.tokenHash, principalKind: s.principalKind, principalId: s.principalId, orgId: s.orgId, mfaPending: !!s.mfaPending, lastSeenAt: now, expiresAt: now + s.idleMs, ipHash: s.ipHash ?? null, createdAt: now };
  await db.insert(session).values(row);
  return row;
}
export const findSession = (db: DB, tokenHash: string) => db.query.session.findFirst({ where: eq(session.tokenHash, tokenHash) });
export const touchSession = (db: DB, id: string, idleMs: number) => {
  const now = Date.now();
  return db.update(session).set({ lastSeenAt: now, expiresAt: now + idleMs }).where(eq(session.id, id));
};
export const completeMfa = (db: DB, id: string) => db.update(session).set({ mfaPending: false }).where(eq(session.id, id));
export const deleteSession = (db: DB, id: string) => db.delete(session).where(eq(session.id, id));
export const deletePrincipalSessions = (db: DB, kind: "staff" | "client", principalId: string) =>
  db.delete(session).where(and(eq(session.principalKind, kind), eq(session.principalId, principalId)));
export const purgeExpiredSessions = (db: DB, now = Date.now()) => db.delete(session).where(lt(session.expiresAt, now));

// ---------- client accounts ----------
export type ClientAccountRow = typeof clientAccount.$inferSelect;
export const findAccountByEmail = (db: DB, email: string) => db.query.clientAccount.findFirst({ where: eq(clientAccount.email, email.toLowerCase()) });
export const getAccount = (db: DB, id: string) => db.query.clientAccount.findFirst({ where: eq(clientAccount.id, id) });
export const accountForClient = (db: DB, orgId: string, clientId: string) =>
  db.query.clientAccount.findFirst({ where: and(eq(clientAccount.orgId, orgId), eq(clientAccount.clientId, clientId)) });

export async function createAccount(db: DB, a: { orgId: string; clientId: string; email: string; passwordHash: string; mfaType: "totp" | "email"; totpSecretEnc: string | null }) {
  const row = { id: uuidv7(), ...a, email: a.email.toLowerCase(), createdAt: Date.now() };
  await db.insert(clientAccount).values(row);
  return row;
}
export const LOCKOUT_THRESHOLD = 10;
/** Increments failures; locks at the threshold (R4.7). Returns the new count. */
export async function recordLoginFailure(db: DB, acct: ClientAccountRow) {
  const n = acct.failedLogins + 1;
  await db
    .update(clientAccount)
    .set({ failedLogins: n, ...(n >= LOCKOUT_THRESHOLD ? { lockedAt: Date.now() } : {}) })
    .where(eq(clientAccount.id, acct.id));
  return n;
}
export const resetLoginFailures = (db: DB, id: string) => db.update(clientAccount).set({ failedLogins: 0 }).where(eq(clientAccount.id, id));
export const unlockAccount = (db: DB, orgId: string, id: string) =>
  db.update(clientAccount).set({ failedLogins: 0, lockedAt: null }).where(and(eq(clientAccount.orgId, orgId), eq(clientAccount.id, id)));
export const setPassword = (db: DB, id: string, passwordHash: string) =>
  db.update(clientAccount).set({ passwordHash, failedLogins: 0, lockedAt: null }).where(eq(clientAccount.id, id));
export const setTotpStep = (db: DB, id: string, step: number) => db.update(clientAccount).set({ totpLastStep: step }).where(eq(clientAccount.id, id));
export const setTotpSecret = (db: DB, id: string, totpSecretEnc: string) =>
  db.update(clientAccount).set({ totpSecretEnc, mfaType: "totp", totpLastStep: null }).where(eq(clientAccount.id, id));

// ---------- invites ----------
export async function createInvite(db: DB, i: { orgId: string; clientId: string; tokenHash: string; expiresAt: number; createdBy: string }) {
  const row = { id: uuidv7(), ...i, createdAt: Date.now() };
  await db.insert(invite).values(row);
  return row;
}
export const findInvite = (db: DB, tokenHash: string) => db.query.invite.findFirst({ where: eq(invite.tokenHash, tokenHash) });
export const setInviteEnrollment = (db: DB, id: string, mfaType: "totp" | "email", pendingTotpEnc: string | null) =>
  db.update(invite).set({ mfaType, pendingTotpEnc }).where(eq(invite.id, id));
export const acceptInvite = (db: DB, id: string) => db.update(invite).set({ acceptedAt: Date.now(), pendingTotpEnc: null }).where(and(eq(invite.id, id), isNull(invite.acceptedAt)));
/** Expired or accepted invites are removed by the weekly cleanup (R4.9). */
export const purgeInvites = (db: DB, now = Date.now()) => db.delete(invite).where(or(lt(invite.expiresAt, now), gt(invite.acceptedAt, 0)));

// ---------- password resets ----------
export async function createReset(db: DB, clientAccountId: string, tokenHash: string, ttlMs: number) {
  const now = Date.now();
  await db.insert(passwordReset).values({ id: uuidv7(), clientAccountId, tokenHash, expiresAt: now + ttlMs, createdAt: now });
}
export const findReset = (db: DB, tokenHash: string) => db.query.passwordReset.findFirst({ where: eq(passwordReset.tokenHash, tokenHash) });
export const useReset = (db: DB, id: string) => db.update(passwordReset).set({ usedAt: Date.now() }).where(and(eq(passwordReset.id, id), isNull(passwordReset.usedAt)));
export const purgeResets = (db: DB, now = Date.now()) => db.delete(passwordReset).where(lt(passwordReset.expiresAt, now));

// ---------- email MFA challenges ----------
export async function createChallenge(db: DB, subjectId: string, codeHash: string, ttlMs: number) {
  const now = Date.now();
  await db.batch([
    db.delete(mfaChallenge).where(eq(mfaChallenge.subjectId, subjectId)),
    db.insert(mfaChallenge).values({ id: uuidv7(), subjectId, codeHash, expiresAt: now + ttlMs, createdAt: now }),
  ]);
}
export const findChallenge = (db: DB, subjectId: string) => db.query.mfaChallenge.findFirst({ where: and(eq(mfaChallenge.subjectId, subjectId), gt(mfaChallenge.expiresAt, Date.now())) });
export const bumpChallenge = (db: DB, id: string, attempts: number) => db.update(mfaChallenge).set({ attempts }).where(eq(mfaChallenge.id, id));
export const deleteChallenges = (db: DB, subjectId: string) => db.delete(mfaChallenge).where(eq(mfaChallenge.subjectId, subjectId));
export const purgeChallenges = (db: DB, now = Date.now()) => db.delete(mfaChallenge).where(lt(mfaChallenge.expiresAt, now));
