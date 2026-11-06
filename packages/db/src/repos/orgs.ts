import { and, eq, inArray } from "drizzle-orm";
import { DEFAULT_FLAG_RULES, DEFAULT_ORG_SETTINGS, type OrgSettings, type Role, type UserDto, uuidv7 } from "@da/shared";
import { type DB, parseJson } from "../client";
import { flagRule, letterTemplate, organization, session, user } from "../schema";
import { DEFAULT_TEMPLATE_HTML } from "../seed-content";

export async function getOrg(db: DB, orgId: string) {
  const o = await db.query.organization.findFirst({ where: eq(organization.id, orgId) });
  if (!o) return null;
  return { id: o.id, name: o.name, settings: { ...DEFAULT_ORG_SETTINGS, ...parseJson<Partial<OrgSettings>>(o.settingsJson, {}) } };
}

export async function updateOrgSettings(db: DB, orgId: string, patch: Partial<OrgSettings>) {
  const o = await getOrg(db, orgId);
  if (!o) return null;
  const settings = { ...o.settings, ...patch };
  await db.update(organization).set({ settingsJson: JSON.stringify(settings) }).where(eq(organization.id, orgId));
  return { before: o.settings, after: settings };
}

/** Creates an organization with its first admin, the default template, and default flag rules. */
export async function createOrg(db: DB, name: string, admin: { email: string; displayName: string }) {
  const now = Date.now();
  const orgId = uuidv7();
  const adminId = uuidv7();
  await db.batch([
    db.insert(organization).values({ id: orgId, name, settingsJson: JSON.stringify(DEFAULT_ORG_SETTINGS), createdAt: now }),
    db.insert(user).values({ id: adminId, orgId, email: admin.email.toLowerCase(), displayName: admin.displayName, role: "org_admin", createdAt: now }),
    db.insert(letterTemplate).values({ id: uuidv7(), orgId, name: "Standard bureau dispute", version: 1, bodyHtml: DEFAULT_TEMPLATE_HTML, createdBy: adminId, createdAt: now }),
    ...DEFAULT_FLAG_RULES.map((r) =>
      db.insert(flagRule).values({
        id: uuidv7(),
        orgId,
        name: r.name,
        kind: r.kind,
        itemTypesJson: JSON.stringify(r.itemTypes),
        conditionJson: r.condition ? JSON.stringify(r.condition) : null,
        reasonTemplate: r.reasonTemplate,
        createdAt: now,
      }),
    ),
  ] as const);
  return { orgId, adminId };
}

// ---------- staff users ----------
const toUserDto = (u: typeof user.$inferSelect): UserDto => ({ id: u.id, email: u.email, displayName: u.displayName, role: u.role, status: u.status, createdAt: u.createdAt });

/** Identity lookup for Access login: not org-scoped because it establishes the org. */
export const findActiveUserByEmail = (db: DB, email: string) =>
  db.query.user.findFirst({ where: and(eq(user.email, email.toLowerCase()), eq(user.status, "active")) });

export const getUser = (db: DB, orgId: string, id: string) => db.query.user.findFirst({ where: and(eq(user.orgId, orgId), eq(user.id, id)) });

export async function listUsers(db: DB, orgId: string) {
  const rows = await db.select().from(user).where(eq(user.orgId, orgId)).orderBy(user.displayName);
  return rows.map(toUserDto);
}

export async function userNames(db: DB, orgId: string, ids: (string | null | undefined)[]) {
  const uniq = [...new Set(ids.filter((x): x is string => !!x))];
  if (!uniq.length) return new Map<string, string>();
  const rows = await db.select({ id: user.id, name: user.displayName }).from(user).where(and(eq(user.orgId, orgId), inArray(user.id, uniq)));
  return new Map(rows.map((r) => [r.id, r.name]));
}

export async function createUser(db: DB, orgId: string, input: { email: string; displayName: string; role: Role }) {
  const row = { id: uuidv7(), orgId, email: input.email.toLowerCase(), displayName: input.displayName, role: input.role, createdAt: Date.now() };
  await db.insert(user).values(row);
  return toUserDto({ ...row, status: "active", reauthAfter: null });
}

export async function updateUser(db: DB, orgId: string, id: string, patch: Partial<{ displayName: string; role: Role; status: "active" | "inactive" }>) {
  const before = await getUser(db, orgId, id);
  if (!before) return null;
  await db.update(user).set(patch).where(and(eq(user.orgId, orgId), eq(user.id, id)));
  if (patch.status === "inactive") await db.delete(session).where(and(eq(session.principalKind, "staff"), eq(session.principalId, id)));
  return { before: toUserDto(before), after: toUserDto({ ...before, ...patch }) };
}

export const setReauthAfter = (db: DB, userId: string, at: number) => db.update(user).set({ reauthAfter: at }).where(eq(user.id, userId));

export async function orgAdmins(db: DB, orgId: string) {
  return db.select({ id: user.id }).from(user).where(and(eq(user.orgId, orgId), eq(user.role, "org_admin"), eq(user.status, "active")));
}
export async function approvers(db: DB, orgId: string) {
  return db.select({ id: user.id }).from(user).where(and(eq(user.orgId, orgId), inArray(user.role, ["org_admin", "approver"]), eq(user.status, "active")));
}
export const activeStaff = (db: DB, orgId: string) =>
  db.select({ id: user.id, email: user.email }).from(user).where(and(eq(user.orgId, orgId), eq(user.status, "active")));
export const allOrgs = (db: DB) => db.select({ id: organization.id, name: organization.name }).from(organization);
