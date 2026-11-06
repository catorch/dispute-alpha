/**
 * Notification events and their message templates (R18).
 * Templates receive only the non-sensitive variables below: never SSNs, account numbers,
 * report details, or letter content (R18.2). A unit test enforces this.
 */
export const NOTIFY_EVENTS = [
  "invite",
  "password_reset",
  "mfa_code",
  "report_ready",
  "import_failed",
  "document_available",
  "document_rejected",
  "authorization_signed",
  "authorization_declined",
  "letter_rejected",
  "letter_pending_approval",
  "letter_ready",
  "render_failed",
  "deadline_reminder",
  "letter_overdue",
  "task_assigned",
  "audit_export_ready",
  "daily_digest",
  "ops_alert",
] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

export type NotifyVars = { orgName?: string; link?: string; code?: string; days?: number; counts?: { tasks: number; overdue: number; uploads: number }; detail?: string };

export type NotifyMessage = {
  /** Dedupe key: redelivery of the same id is a no-op (R22.2). */
  id: string;
  orgId: string;
  recipient: { kind: "staff" | "client"; id: string } | { kind: "ops" } | { kind: "email"; email: string };
  event: NotifyEvent;
  vars?: NotifyVars;
  /** Channels; defaults to email + in_app (in_app skipped for raw email recipients). SMS only if the client opted in. */
  channels?: ("email" | "sms" | "in_app")[];
};

type Rendered = { subject: string; text: string; inApp: string };
const portal = (v: NotifyVars) => (v.link ? `\n\nOpen the portal: ${v.link}` : "");

export const TEMPLATES: Record<NotifyEvent, (v: NotifyVars) => Rendered> = {
  invite: (v) => ({ subject: `You're invited to the ${v.orgName ?? "secure"} client portal`, text: `You have been invited to a secure client portal. This link expires in ${v.days ?? 7} days.${portal(v)}`, inApp: "Invitation sent" }),
  password_reset: (v) => ({ subject: "Reset your password", text: `Use this single-use link to reset your password. It expires in 1 hour. If you did not ask for this, ignore this email.${portal(v)}`, inApp: "Password reset requested" }),
  mfa_code: (v) => ({ subject: "Your sign-in code", text: `Your sign-in code is ${v.code}. It expires in 10 minutes.`, inApp: "Sign-in code sent" }),
  report_ready: (v) => ({ subject: "You have an update", text: `A new credit report is ready to review.${portal(v)}`, inApp: "Credit report ready" }),
  import_failed: (v) => ({ subject: "Report import failed", text: `A credit report import did not complete. A task has been created.${portal(v)}`, inApp: "Report import failed" }),
  document_available: (v) => ({ subject: "New document uploaded", text: `A client uploaded a document and it passed the virus scan.${portal(v)}`, inApp: "New document available" }),
  document_rejected: (v) => ({ subject: "Upload rejected", text: `An uploaded file failed the virus scan and was deleted.${portal(v)}`, inApp: "Upload rejected by virus scan" }),
  authorization_signed: (v) => ({ subject: "Authorization signed", text: `A client signed their authorization documents.${portal(v)}`, inApp: "Authorization signed" }),
  authorization_declined: (v) => ({ subject: "Authorization not completed", text: `A client's authorization request was declined or expired. A task has been created.${portal(v)}`, inApp: "Authorization declined or expired" }),
  letter_rejected: (v) => ({ subject: "Letter returned to draft", text: `A letter you wrote was returned for changes.${portal(v)}`, inApp: "Letter returned for changes" }),
  letter_pending_approval: (v) => ({ subject: "Letter waiting for approval", text: `A dispute letter is waiting for your approval.${portal(v)}`, inApp: "Letter awaiting approval" }),
  letter_ready: (v) => ({ subject: "Letter ready to mail", text: `An approved letter is ready to mail.${portal(v)}`, inApp: "Letter ready to mail" }),
  render_failed: (v) => ({ subject: "Letter PDF failed", text: `A letter PDF could not be generated. Retry from the letter page.${portal(v)}`, inApp: "Letter PDF failed" }),
  deadline_reminder: (v) => ({ subject: "Response deadline approaching", text: `A dispute response is due in ${v.days} days.${portal(v)}`, inApp: `Response due in ${v.days} days` }),
  letter_overdue: (v) => ({ subject: "You have an update", text: `A dispute response deadline has passed.${portal(v)}`, inApp: "Dispute response overdue" }),
  task_assigned: (v) => ({ subject: "New task assigned", text: `You have a new task.${portal(v)}`, inApp: "New task assigned" }),
  audit_export_ready: (v) => ({ subject: "Audit export ready", text: `Your audit export is ready to download.${portal(v)}`, inApp: "Audit export ready" }),
  daily_digest: (v) => ({
    subject: "Your daily summary",
    text: `Open tasks: ${v.counts?.tasks ?? 0}\nOverdue letters: ${v.counts?.overdue ?? 0}\nNew client uploads: ${v.counts?.uploads ?? 0}${portal(v)}`,
    inApp: "Daily summary",
  }),
  ops_alert: (v) => ({ subject: "[Dispute Alpha] Operations alert", text: v.detail ?? "An operations alert was raised.", inApp: "Operations alert" }),
};
