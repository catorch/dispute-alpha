export const ROLES = ["org_admin", "approver", "staff"] as const;
export type Role = (typeof ROLES)[number];

export const CLIENT_STATUS = ["intake", "active", "paused", "closed"] as const;
export type ClientStatus = (typeof CLIENT_STATUS)[number];
/** Allowed client status transitions (R9.4). */
export const CLIENT_TRANSITIONS: Record<ClientStatus, ClientStatus[]> = {
  intake: ["active", "closed"],
  active: ["paused", "closed"],
  paused: ["active", "closed"],
  closed: [],
};

export const AUTH_STATUS = ["none", "sent", "signed", "declined", "expired"] as const;
export type AuthStatus = (typeof AUTH_STATUS)[number];

export const DOC_TYPES = ["government_id", "proof_of_address", "ssn_card", "bureau_response", "authorization", "letter", "audit_export", "other"] as const;
export type DocType = (typeof DOC_TYPES)[number];
/** Types a user may upload; the rest are system-generated. */
export const UPLOADABLE_DOC_TYPES = ["government_id", "proof_of_address", "ssn_card", "bureau_response", "other"] as const satisfies readonly DocType[];
/** Types encrypted at the application level before storage (R10.8). */
export const ENCRYPTED_DOC_TYPES: readonly DocType[] = ["government_id", "ssn_card"];
export const DOC_STATUS = ["scan_pending", "available", "rejected", "expired"] as const;
export type DocStatus = (typeof DOC_STATUS)[number];
export const UPLOAD_MIME = ["application/pdf", "image/jpeg", "image/png", "image/heic"] as const;
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

export const BUREAUS = ["equifax", "experian", "transunion"] as const;
export type Bureau = (typeof BUREAUS)[number];
export const ITEM_TYPES = ["tradeline", "collection", "inquiry", "public_record", "personal_info"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export const REPORT_STATUS = ["requested", "waiting", "parsing", "flagging", "complete", "failed"] as const;
export type ReportStatus = (typeof REPORT_STATUS)[number];
export const REPORT_ACTIVE: readonly ReportStatus[] = ["requested", "waiting", "parsing", "flagging"];

export const LETTER_STATUS = [
  "draft",
  "pending_approval",
  "approved",
  "rendering",
  "ready_to_mail",
  "render_failed",
  "sent",
  "response_received",
  "overdue",
  "closed",
] as const;
export type LetterStatus = (typeof LETTER_STATUS)[number];
export const TARGET_KINDS = ["bureau", "furnisher"] as const;
export const OUTCOMES = ["deleted", "updated", "verified", "no_response"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const TASK_STATUS = ["open", "done"] as const;
export const MFA_TYPES = ["totp", "email"] as const;
export type MfaType = (typeof MFA_TYPES)[number];

export const DEFAULT_ORG_SETTINGS = {
  deadlineDays: 30,
  reminderOffsetsDays: [7, 3],
  selfApproval: false,
  senderBlock: { name: "", addressLines: [] as string[] },
  smsEnabled: false,
  inviteExpiryDays: 7,
};
export type OrgSettings = typeof DEFAULT_ORG_SETTINGS;
