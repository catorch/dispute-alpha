/** Response shapes returned by the API. Kept as plain types so the SPA never imports the DB layer. */
import type { Address } from "./schemas";
import type {
  AuthStatus,
  Bureau,
  ClientStatus,
  DocStatus,
  DocType,
  ItemType,
  LetterStatus,
  OrgSettings,
  Outcome,
  ReportStatus,
  Role,
} from "./enums";
import type { Permission } from "./permissions";

export type Page<T> = { items: T[]; nextCursor: string | null };

export type Me =
  | { kind: "staff"; id: string; orgId: string; email: string; displayName: string; role: Role; permissions: Permission[] }
  | { kind: "client"; id: string; orgId: string; clientId: string; email: string; firstName: string; mfaType: string; smsOptIn: boolean };

export type UserDto = { id: string; email: string; displayName: string; role: Role; status: "active" | "inactive"; createdAt: number };

export type ClientSummary = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  status: ClientStatus;
  authStatus: AuthStatus;
  ssnLast4: string;
  assignedStaffId: string | null;
  assignedStaffName: string | null;
  createdAt: number;
};
export type ClientDetail = ClientSummary & {
  phone: string | null;
  address: Address;
  dobMasked: string;
  hasPortalAccount: boolean;
  portalLocked: boolean;
  smsOptIn: boolean;
};
export type ClientPii = { ssn: string; dob: string };
export type DuplicateWarning = { duplicateOf: { id: string; name: string }[] };

export type TimelineEntry = { at: number; kind: "document" | "report" | "letter" | "response" | "task" | "note" | "status"; id: string; title: string; detail?: string };

export type NoteDto = { id: string; body: string; authorName: string; createdAt: number; editable: boolean };

export type DocumentDto = {
  id: string;
  clientId: string;
  type: DocType;
  status: DocStatus;
  filename: string;
  mime: string;
  size: number;
  uploadedByKind: "staff" | "client" | "system";
  createdAt: number;
};

export type ReportDto = { id: string; clientId: string; status: ReportStatus; provider: string; requestedAt: number; completedAt: number | null; error: string | null; itemCount: number; flaggedCount: number };

export type FlagDto = { id: string; reason: string; source: "rule" | "manual"; ruleId: string | null; createdAt: number };
export type ReportItemDto = {
  id: string;
  reportId: string;
  bureau: Bureau;
  itemType: ItemType;
  furnisher: string | null;
  accountMask: string | null;
  balance: number | null;
  creditLimit: number | null;
  openedAt: string | null;
  reportedAt: string | null;
  status: string | null;
  paymentHistory: string[] | null;
  details: Record<string, unknown>;
  fingerprint: string;
  outcome: Outcome | null;
  flags: FlagDto[];
};

export type FlagRuleDto = { id: string; name: string; kind: "condition" | "cross_bureau_mismatch"; itemTypes: ItemType[]; condition: unknown; reasonTemplate: string; active: boolean };

export type TemplateDto = { id: string; name: string; version: number; bodyHtml: string; active: boolean; createdAt: number };

export type LetterSummary = {
  id: string;
  clientId: string;
  clientName: string;
  disputeRoundId: string;
  roundNumber: number;
  targetKind: "bureau" | "furnisher";
  targetName: string;
  status: LetterStatus;
  createdById: string;
  createdAt: number;
  sentAt: number | null;
  responseDueAt: number | null;
};
export type LetterDetail = LetterSummary & {
  bodyHtml: string;
  templateId: string;
  templateVersion: number;
  approvedById: string | null;
  approvedAt: number | null;
  rejectionReason: string | null;
  pdfDocumentId: string | null;
  trackingNumber: string | null;
  items: (ReportItemDto & { outcome: Outcome | null; disputeReason: string | null })[];
  attachments: DocumentDto[];
  createdByName: string | null;
  approvedByName: string | null;
  clientAuthStatus: AuthStatus;
};
/** Client-portal view: status only, never the body (R18.2 spirit, design 5.1). */
export type PortalLetter = { id: string; targetName: string; status: LetterStatus; sentAt: number | null; responseDueAt: number | null };

export type TaskDto = { id: string; title: string; assigneeId: string; assigneeName: string; dueAt: number | null; status: "open" | "done"; entityType: string | null; entityId: string | null; createdAt: number };

export type NotificationDto = { id: string; kind: string; title: string; link: string | null; readAt: number | null; createdAt: number };

export type AuditEntryDto = { id: string; actorKind: string; actorId: string | null; actorName: string | null; action: string; entityType: string; entityId: string | null; diff: unknown; requestId: string | null; createdAt: number };

export type LockState = { ok: true; expiresAt: number } | { ok: false; holder: { id: string; name: string }; expiresAt: number };

export type OrgSettingsDto = OrgSettings & { orgName: string };

export type ApiError = { error: { code: string; message: string; details?: unknown } };
