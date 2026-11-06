import { z } from "zod";
import { BUREAUS, CLIENT_STATUS, ITEM_TYPES, MFA_TYPES, OUTCOMES, ROLES, TARGET_KINDS, UPLOADABLE_DOC_TYPES } from "./enums";

/**
 * Plain-English messages for Zod's generic issues, shared by the SPA forms and the API.
 * Field-specific messages set on a schema still take precedence.
 */
z.config({
  customError: (iss) => {
    if (iss.code === "invalid_type" && iss.input === undefined) return "This field is required";
    if (iss.code === "too_small" && iss.origin === "string") return Number(iss.minimum) <= 1 ? "This field is required" : `Use at least ${iss.minimum} characters`;
    if (iss.code === "too_big" && iss.origin === "string") return `Use ${iss.maximum} characters or fewer`;
    if (iss.code === "too_small" && iss.origin === "array") return Number(iss.minimum) <= 1 ? "Choose at least one" : `Choose at least ${iss.minimum}`;
    if (iss.code === "too_big" && iss.origin === "array") return `Choose ${iss.maximum} or fewer`;
    if (iss.code === "too_small" && iss.origin === "number") return `Use ${iss.minimum} or more`;
    if (iss.code === "too_big" && iss.origin === "number") return `Use ${iss.maximum} or less`;
    if (iss.code === "invalid_format" && iss.format === "email") return "Enter a valid email address";
    if (iss.code === "invalid_value") return "Choose one of the options";
    return undefined;
  },
});

const id = z.string().min(1).max(64);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const email = z.string().trim().toLowerCase().pipe(z.email()).pipe(z.string().max(254));
export const password = z.string().min(12, "Use at least 12 characters").max(200);
const turnstileToken = z.string().min(1, "Complete the verification").max(4096);
const otp = z.string().regex(/^\d{6}$/, "Enter the 6-digit code");

export const address = z.object({
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1).max(100),
  state: z.string().trim().toUpperCase().length(2),
  zip: z.string().trim().regex(/^\d{5}(-\d{4})?$/, "Use a 5 or 9 digit ZIP"),
});
export type Address = z.infer<typeof address>;

/** Accepts 123-45-6789 or 123456789, normalizes to 9 digits. */
export const ssn = z
  .string()
  .transform((s) => s.replace(/[\s-]/g, ""))
  .pipe(z.string().regex(/^\d{9}$/, "SSN must be 9 digits"));

// ---------- clients ----------
export const clientCreate = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  email,
  phone: z.string().trim().max(30).optional(),
  dob: isoDate,
  ssn,
  address,
  assignedStaffId: id.optional(),
  confirmDuplicate: z.boolean().optional(),
});
export const clientUpdate = z
  .object({ firstName: z.string().trim().min(1).max(100), lastName: z.string().trim().min(1).max(100), email, phone: z.string().trim().max(30), address })
  .partial();
export const clientStatusChange = z.object({ status: z.enum(CLIENT_STATUS) });
export const clientAssign = z.object({ staffId: id });
export const clientListQuery = z.object({
  status: z.enum(CLIENT_STATUS).optional(),
  assignedTo: id.optional(),
  q: z.string().max(100).optional(),
  cursor: z.string().max(100).optional(),
});
export const noteCreate = z.object({ body: z.string().trim().min(1).max(10_000) });

// ---------- client auth ----------
export const loginRequest = z.object({ email, password: z.string().min(1, "Enter your password").max(200), turnstileToken });
export const mfaRequest = z.object({ code: otp });
export const inviteStart = z.object({ turnstileToken, mfaType: z.enum(MFA_TYPES) });
export const inviteComplete = z.object({ password, code: otp });
export const resetRequest = z.object({ email, turnstileToken });
export const resetComplete = z.object({ password, turnstileToken });

// ---------- documents ----------
export const documentUploadMeta = z.object({ type: z.enum(UPLOADABLE_DOC_TYPES) });

// ---------- reports & flags ----------
export const flagCreate = z.object({ reason: z.string().trim().min(3).max(500) });
export const flagDelete = z.object({ reason: z.string().trim().min(3).max(500) });

type Cond =
  | { field: string; op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "in" | "exists" | "missing" | "older_than_years" | "neq_client"; value?: unknown }
  | { all: Cond[] }
  | { any: Cond[] };
export const flagCondition: z.ZodType<Cond> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(flagCondition).min(1) }),
    z.object({ any: z.array(flagCondition).min(1) }),
    z.object({
      field: z.string().min(1).max(64),
      op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "contains", "in", "exists", "missing", "older_than_years", "neq_client"]),
      value: z.unknown().optional(),
    }),
  ]),
);
export type FlagCondition = Cond;
export const flagRuleInput = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["condition", "cross_bureau_mismatch"]).default("condition"),
  itemTypes: z.array(z.enum(ITEM_TYPES)).min(1),
  condition: flagCondition.optional(),
  reasonTemplate: z.string().trim().min(1).max(500),
  active: z.boolean().default(true),
});
export type FlagRuleInput = z.infer<typeof flagRuleInput>;

// ---------- letters ----------
export const disputeRoundCreate = z.object({
  itemIds: z.array(id).min(1).max(200),
  targetKind: z.enum(TARGET_KINDS),
  templateId: id,
});
export const letterUpdate = z.object({
  bodyHtml: z.string().min(1).max(200_000).optional(),
  attachmentDocumentIds: z.array(id).max(20).optional(),
});
export const letterReject = z.object({ reason: z.string().trim().min(3).max(1000) });
export const letterSent = z.object({ sentAt: isoDate, trackingNumber: z.string().trim().max(64).optional() });
export const letterResponse = z.object({
  receivedAt: isoDate,
  outcomes: z.array(z.object({ reportItemId: id, outcome: z.enum(OUTCOMES) })).min(1),
  documentId: id.optional(),
  notes: z.string().max(5000).optional(),
});

// ---------- tasks ----------
export const taskCreate = z.object({
  title: z.string().trim().min(1).max(300),
  assigneeId: id,
  dueAt: isoDate.optional(),
  entityType: z.enum(["client", "letter", "report", "document"]).optional(),
  entityId: id.optional(),
});
export const taskUpdate = z
  .object({ title: z.string().trim().min(1).max(300), assigneeId: id, dueAt: isoDate.nullable(), status: z.enum(["open", "done"]) })
  .partial();
export const taskListQuery = z.object({ status: z.enum(["open", "done"]).optional(), assignee: z.string().max(64).optional() });

// ---------- admin ----------
export const templateCreate = z.object({ name: z.string().trim().min(1).max(120), bodyHtml: z.string().min(1).max(200_000) });
export const templateVersion = z.object({ bodyHtml: z.string().min(1).max(200_000) });
export const userCreate = z.object({ email, displayName: z.string().trim().min(1).max(120), role: z.enum(ROLES) });
export const userUpdate = z
  .object({ displayName: z.string().trim().min(1).max(120), role: z.enum(ROLES), status: z.enum(["active", "inactive"]) })
  .partial();
export const orgSettingsUpdate = z
  .object({
    deadlineDays: z.number().int().min(1).max(120),
    reminderOffsetsDays: z.array(z.number().int().min(1).max(60)).max(5),
    selfApproval: z.boolean(),
    senderBlock: z.object({ name: z.string().max(200), addressLines: z.array(z.string().max(200)).max(6) }),
    smsEnabled: z.boolean(),
    inviteExpiryDays: z.number().int().min(1).max(30),
  })
  .partial();
export const auditQuery = z.object({
  entityType: z.string().max(40).optional(),
  entityId: id.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  cursor: z.string().max(100).optional(),
});
export const auditExportRequest = z.object({ from: isoDate, to: isoDate, entityType: z.string().max(40).optional() });

// ---------- portal ----------
export const portalPreferences = z.object({ smsOptIn: z.boolean() });

export const bureau = z.enum(BUREAUS);
