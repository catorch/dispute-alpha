import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Conventions (design 4): TEXT UUIDv7 ids, integer epoch-ms timestamps, `_enc` columns hold
 * FieldCrypto ciphertext ("v{n}:iv:ct"), `_json` columns hold JSON text.
 * Every tenant table carries org_id and is only queried through repositories scoped by it.
 */
const id = () => text("id").primaryKey();
const orgId = () => text("org_id").notNull();
const ts = (name: string) => integer(name);
const created = () => integer("created_at").notNull();

export const organization = sqliteTable("organization", {
  id: id(),
  name: text("name").notNull(),
  settingsJson: text("settings_json").notNull().default("{}"),
  createdAt: created(),
});

export const user = sqliteTable(
  "user",
  {
    id: id(),
    orgId: orgId(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    role: text("role", { enum: ["org_admin", "approver", "staff"] }).notNull(),
    status: text("status", { enum: ["active", "inactive"] }).notNull().default("active"),
    /** Access JWTs issued before this instant cannot open a new session (idle re-auth, R3.4). */
    reauthAfter: ts("reauth_after"),
    createdAt: created(),
  },
  (t) => [uniqueIndex("user_email").on(t.email), index("user_org").on(t.orgId)],
);

export const client = sqliteTable(
  "client",
  {
    id: id(),
    orgId: orgId(),
    assignedStaffId: text("assigned_staff_id"),
    status: text("status", { enum: ["intake", "active", "paused", "closed"] }).notNull().default("intake"),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    email: text("email").notNull(),
    phone: text("phone"),
    addressJson: text("address_json").notNull(),
    dobEnc: text("dob_enc").notNull(),
    ssnEnc: text("ssn_enc").notNull(),
    ssnLast4: text("ssn_last4").notNull(),
    ssnHmac: text("ssn_hmac").notNull(),
    authStatus: text("auth_status", { enum: ["none", "sent", "signed", "declined", "expired"] }).notNull().default("none"),
    smsOptIn: integer("sms_opt_in", { mode: "boolean" }).notNull().default(false),
    createdAt: created(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("client_org_status").on(t.orgId, t.status), index("client_assigned").on(t.assignedStaffId), index("client_ssn_hmac").on(t.orgId, t.ssnHmac)],
);

export const clientAccount = sqliteTable(
  "client_account",
  {
    id: id(),
    orgId: orgId(),
    clientId: text("client_id").notNull(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    mfaType: text("mfa_type", { enum: ["totp", "email"] }).notNull(),
    totpSecretEnc: text("totp_secret_enc"),
    /** Last accepted TOTP step, so a code cannot be replayed. */
    totpLastStep: integer("totp_last_step"),
    status: text("status", { enum: ["active", "disabled"] }).notNull().default("active"),
    failedLogins: integer("failed_logins").notNull().default(0),
    lockedAt: ts("locked_at"),
    createdAt: created(),
  },
  (t) => [uniqueIndex("client_account_email").on(t.email), uniqueIndex("client_account_client").on(t.clientId)],
);

export const session = sqliteTable(
  "session",
  {
    id: id(),
    /** SHA-256 of the cookie value; the raw token is never stored. */
    tokenHash: text("token_hash").notNull(),
    principalKind: text("principal_kind", { enum: ["staff", "client"] }).notNull(),
    principalId: text("principal_id").notNull(),
    orgId: orgId(),
    mfaPending: integer("mfa_pending", { mode: "boolean" }).notNull().default(false),
    lastSeenAt: integer("last_seen_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    ipHash: text("ip_hash"),
    createdAt: created(),
  },
  (t) => [uniqueIndex("session_token").on(t.tokenHash), index("session_expires").on(t.expiresAt), index("session_principal").on(t.principalKind, t.principalId)],
);

export const mfaChallenge = sqliteTable("mfa_challenge", {
  id: id(),
  /** session id (login) or invite id (enrollment) */
  subjectId: text("subject_id").notNull(),
  codeHash: text("code_hash").notNull(),
  attempts: integer("attempts").notNull().default(0),
  expiresAt: integer("expires_at").notNull(),
  createdAt: created(),
}, (t) => [index("mfa_challenge_subject").on(t.subjectId)]);

export const invite = sqliteTable(
  "invite",
  {
    id: id(),
    orgId: orgId(),
    clientId: text("client_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    mfaType: text("mfa_type", { enum: ["totp", "email"] }),
    pendingTotpEnc: text("pending_totp_enc"),
    expiresAt: integer("expires_at").notNull(),
    acceptedAt: ts("accepted_at"),
    createdBy: text("created_by").notNull(),
    createdAt: created(),
  },
  (t) => [uniqueIndex("invite_token").on(t.tokenHash), index("invite_expires").on(t.expiresAt)],
);

export const passwordReset = sqliteTable(
  "password_reset",
  {
    id: id(),
    clientAccountId: text("client_account_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: integer("expires_at").notNull(),
    usedAt: ts("used_at"),
    createdAt: created(),
  },
  (t) => [uniqueIndex("password_reset_token").on(t.tokenHash), index("password_reset_expires").on(t.expiresAt)],
);

export const document = sqliteTable(
  "document",
  {
    id: id(),
    orgId: orgId(),
    clientId: text("client_id"),
    type: text("type").notNull(),
    status: text("status", { enum: ["scan_pending", "available", "rejected", "expired"] }).notNull(),
    bucket: text("bucket", { enum: ["quarantine", "documents", "letters", "backups"] }).notNull(),
    objectKey: text("object_key").notNull(),
    filename: text("filename").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    encrypted: integer("encrypted", { mode: "boolean" }).notNull().default(false),
    uploadedByKind: text("uploaded_by_kind", { enum: ["staff", "client", "system"] }).notNull(),
    uploadedById: text("uploaded_by_id"),
    scanResultJson: text("scan_result_json"),
    createdAt: created(),
  },
  (t) => [index("document_client").on(t.clientId, t.createdAt), index("document_status").on(t.status, t.createdAt)],
);

export const esignRequest = sqliteTable(
  "esign_request",
  {
    id: id(),
    orgId: orgId(),
    clientId: text("client_id").notNull(),
    provider: text("provider").notNull(),
    providerRequestId: text("provider_request_id").notNull(),
    status: text("status", { enum: ["sent", "signed", "declined", "expired"] }).notNull(),
    signedDocumentId: text("signed_document_id"),
    createdAt: created(),
  },
  (t) => [uniqueIndex("esign_provider_request").on(t.providerRequestId), index("esign_client").on(t.clientId)],
);

export const webhookEvent = sqliteTable(
  "webhook_event",
  {
    id: id(),
    provider: text("provider").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    payloadHash: text("payload_hash").notNull(),
    receivedAt: integer("received_at").notNull(),
    processedAt: ts("processed_at"),
  },
  (t) => [uniqueIndex("webhook_event_provider_event").on(t.provider, t.providerEventId)],
);

export const report = sqliteTable(
  "report",
  {
    id: id(),
    orgId: orgId(),
    clientId: text("client_id").notNull(),
    provider: text("provider").notNull(),
    providerRef: text("provider_ref"),
    status: text("status", { enum: ["requested", "waiting", "parsing", "flagging", "complete", "failed"] }).notNull(),
    workflowId: text("workflow_id"),
    rawObjectKey: text("raw_object_key"),
    requestedBy: text("requested_by").notNull(),
    requestedAt: integer("requested_at").notNull(),
    completedAt: ts("completed_at"),
    error: text("error"),
    createdAt: created(),
  },
  (t) => [index("report_client").on(t.clientId, t.createdAt), index("report_status").on(t.status, t.requestedAt), index("report_provider_ref").on(t.providerRef)],
);

export const reportItem = sqliteTable(
  "report_item",
  {
    id: id(),
    orgId: orgId(),
    reportId: text("report_id").notNull(),
    clientId: text("client_id").notNull(),
    bureau: text("bureau", { enum: ["equifax", "experian", "transunion"] }).notNull(),
    itemType: text("item_type", { enum: ["tradeline", "collection", "inquiry", "public_record", "personal_info"] }).notNull(),
    furnisher: text("furnisher"),
    accountNumberEnc: text("account_number_enc"),
    accountMask: text("account_mask"),
    balance: real("balance"),
    creditLimit: real("credit_limit"),
    openedAt: text("opened_at"),
    reportedAt: text("reported_at"),
    status: text("status"),
    paymentHistoryJson: text("payment_history_json"),
    detailsJson: text("details_json").notNull().default("{}"),
    fingerprint: text("fingerprint").notNull(),
    outcome: text("outcome", { enum: ["deleted", "updated", "verified", "no_response"] }),
    createdAt: created(),
  },
  (t) => [index("report_item_report").on(t.reportId), index("report_item_fp").on(t.clientId, t.fingerprint)],
);

export const flagRule = sqliteTable(
  "flag_rule",
  {
    id: id(),
    orgId: orgId(),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["condition", "cross_bureau_mismatch"] }).notNull(),
    itemTypesJson: text("item_types_json").notNull(),
    conditionJson: text("condition_json"),
    reasonTemplate: text("reason_template").notNull(),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: created(),
  },
  (t) => [index("flag_rule_org").on(t.orgId)],
);

export const flag = sqliteTable(
  "flag",
  {
    id: id(),
    orgId: orgId(),
    reportItemId: text("report_item_id").notNull(),
    ruleId: text("rule_id"),
    reason: text("reason").notNull(),
    source: text("source", { enum: ["rule", "manual"] }).notNull(),
    createdBy: text("created_by"),
    createdAt: created(),
  },
  (t) => [index("flag_item").on(t.reportItemId)],
);

export const disputeRound = sqliteTable(
  "dispute_round",
  {
    id: id(),
    orgId: orgId(),
    clientId: text("client_id").notNull(),
    number: integer("number").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: created(),
  },
  (t) => [uniqueIndex("dispute_round_client_number").on(t.clientId, t.number)],
);

export const letterTemplate = sqliteTable(
  "letter_template",
  {
    id: id(),
    orgId: orgId(),
    name: text("name").notNull(),
    version: integer("version").notNull(),
    bodyHtml: text("body_html").notNull(),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: created(),
  },
  (t) => [uniqueIndex("letter_template_name_version").on(t.orgId, t.name, t.version)],
);

export const letter = sqliteTable(
  "letter",
  {
    id: id(),
    orgId: orgId(),
    clientId: text("client_id").notNull(),
    disputeRoundId: text("dispute_round_id").notNull(),
    targetKind: text("target_kind", { enum: ["bureau", "furnisher"] }).notNull(),
    targetName: text("target_name").notNull(),
    templateId: text("template_id").notNull(),
    templateVersion: integer("template_version").notNull(),
    status: text("status", {
      enum: ["draft", "pending_approval", "approved", "rendering", "ready_to_mail", "render_failed", "sent", "response_received", "overdue", "closed"],
    }).notNull(),
    bodyHtml: text("body_html").notNull(),
    lockedAt: ts("locked_at"),
    approvedBy: text("approved_by"),
    approvedAt: ts("approved_at"),
    rejectionReason: text("rejection_reason"),
    pdfDocumentId: text("pdf_document_id"),
    pipelineWorkflowId: text("pipeline_workflow_id"),
    sentAt: ts("sent_at"),
    trackingNumber: text("tracking_number"),
    responseDueAt: ts("response_due_at"),
    deadlineWorkflowId: text("deadline_workflow_id"),
    createdBy: text("created_by").notNull(),
    createdAt: created(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("letter_status").on(t.status), index("letter_due").on(t.responseDueAt), index("letter_client").on(t.clientId, t.createdAt), index("letter_round").on(t.disputeRoundId)],
);

export const letterItem = sqliteTable(
  "letter_item",
  {
    letterId: text("letter_id").notNull(),
    reportItemId: text("report_item_id").notNull(),
    reason: text("reason"),
    outcome: text("outcome", { enum: ["deleted", "updated", "verified", "no_response"] }),
  },
  (t) => [primaryKey({ columns: [t.letterId, t.reportItemId] }), index("letter_item_report_item").on(t.reportItemId)],
);

export const letterAttachment = sqliteTable(
  "letter_attachment",
  { letterId: text("letter_id").notNull(), documentId: text("document_id").notNull() },
  (t) => [primaryKey({ columns: [t.letterId, t.documentId] })],
);

export const response = sqliteTable(
  "response",
  {
    id: id(),
    orgId: orgId(),
    letterId: text("letter_id").notNull(),
    receivedAt: integer("received_at").notNull(),
    documentId: text("document_id"),
    notes: text("notes"),
    loggedBy: text("logged_by").notNull(),
    createdAt: created(),
  },
  (t) => [index("response_letter").on(t.letterId)],
);

export const task = sqliteTable(
  "task",
  {
    id: id(),
    orgId: orgId(),
    assigneeId: text("assignee_id").notNull(),
    title: text("title").notNull(),
    dueAt: ts("due_at"),
    status: text("status", { enum: ["open", "done"] }).notNull().default("open"),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    /** Prevents duplicate system tasks for the same event (idempotent consumers, R22.2). */
    dedupeKey: text("dedupe_key"),
    createdByKind: text("created_by_kind", { enum: ["staff", "system"] }).notNull(),
    createdById: text("created_by_id"),
    createdAt: created(),
  },
  (t) => [index("task_assignee_status").on(t.assigneeId, t.status), index("task_entity").on(t.entityType, t.entityId), uniqueIndex("task_dedupe").on(t.dedupeKey)],
);

export const note = sqliteTable(
  "note",
  { id: id(), orgId: orgId(), clientId: text("client_id").notNull(), body: text("body").notNull(), authorId: text("author_id").notNull(), createdAt: created() },
  (t) => [index("note_client").on(t.clientId, t.createdAt)],
);

export const notification = sqliteTable(
  "notification",
  {
    id: id(),
    orgId: orgId(),
    recipientKind: text("recipient_kind", { enum: ["staff", "client"] }).notNull(),
    recipientId: text("recipient_id").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    link: text("link"),
    readAt: ts("read_at"),
    createdAt: created(),
  },
  (t) => [index("notification_recipient").on(t.recipientKind, t.recipientId, t.readAt)],
);

/** Delivery ledger: one row per message id + channel, so queue redelivery never double-sends. */
export const notificationDelivery = sqliteTable(
  "notification_delivery",
  { messageId: text("message_id").notNull(), channel: text("channel").notNull(), deliveredAt: integer("delivered_at").notNull() },
  (t) => [primaryKey({ columns: [t.messageId, t.channel] })],
);

/** Append-only (R19.2). The repository exposes insert and select only. */
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: id(),
    orgId: text("org_id"),
    actorKind: text("actor_kind", { enum: ["staff", "client", "system", "anonymous", "webhook"] }).notNull(),
    actorId: text("actor_id"),
    sessionId: text("session_id"),
    requestId: text("request_id"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    diffJson: text("diff_json"),
    ipHash: text("ip_hash"),
    createdAt: created(),
  },
  (t) => [index("audit_entity").on(t.entityType, t.entityId), index("audit_created").on(t.createdAt), index("audit_org_created").on(t.orgId, t.createdAt)],
);

export const auditExport = sqliteTable("audit_export", {
  id: id(),
  orgId: orgId(),
  requestedBy: text("requested_by").notNull(),
  paramsJson: text("params_json").notNull(),
  status: text("status", { enum: ["queued", "ready", "failed"] }).notNull(),
  documentId: text("document_id"),
  createdAt: created(),
});

export const keyRotation = sqliteTable("key_rotation", {
  id: id(),
  toVersion: integer("to_version").notNull(),
  tableName: text("table_name").notNull(),
  lastId: text("last_id"),
  status: text("status", { enum: ["running", "done"] }).notNull(),
  updatedAt: integer("updated_at").notNull(),
});
