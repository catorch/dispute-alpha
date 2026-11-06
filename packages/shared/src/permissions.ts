import type { Role } from "./enums";

export const PERMISSIONS = [
  "client:read",
  "client:read_pii",
  "client:write",
  "client:assign",
  "document:read",
  "document:write",
  "report:read",
  "report:import",
  "flag:write",
  "letter:read",
  "letter:write",
  "letter:approve",
  "task:read",
  "task:write",
  "template:write",
  "rule:write",
  "user:write",
  "org:write",
  "audit:read",
  "audit:export",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const STAFF: Permission[] = [
  "client:read",
  "client:read_pii",
  "client:write",
  "document:read",
  "document:write",
  "report:read",
  "report:import",
  "flag:write",
  "letter:read",
  "letter:write",
  "task:read",
  "task:write",
  "audit:read",
];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  staff: STAFF,
  approver: [...STAFF, "letter:approve"],
  org_admin: PERMISSIONS,
};

export const can = (role: Role, perm: Permission) => ROLE_PERMISSIONS[role]?.includes(perm) ?? false;
