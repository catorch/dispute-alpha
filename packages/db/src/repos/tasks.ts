import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { type NotificationDto, type TaskDto, uuidv7 } from "@da/shared";
import type { DB } from "../client";
import { notification, notificationDelivery, task } from "../schema";
import { userNames } from "./orgs";

export type TaskRow = typeof task.$inferSelect;

export async function createTask(
  db: DB,
  orgId: string,
  t: { title: string; assigneeId: string; dueAt?: number | null; entityType?: string | null; entityId?: string | null; createdByKind: "staff" | "system"; createdById?: string | null; dedupeKey?: string },
) {
  const row = {
    id: uuidv7(),
    orgId,
    title: t.title,
    assigneeId: t.assigneeId,
    dueAt: t.dueAt ?? null,
    entityType: t.entityType ?? null,
    entityId: t.entityId ?? null,
    createdByKind: t.createdByKind,
    createdById: t.createdById ?? null,
    dedupeKey: t.dedupeKey ?? null,
    createdAt: Date.now(),
  };
  // System tasks carry a dedupe key so a redelivered event cannot create a second task (R22.2).
  const res = await db.insert(task).values(row).onConflictDoNothing().returning({ id: task.id });
  return res.length ? row : null;
}

export async function listTasks(db: DB, orgId: string, f: { status?: "open" | "done"; assigneeId?: string; entityType?: string; entityId?: string }): Promise<TaskDto[]> {
  const conds = [eq(task.orgId, orgId)];
  if (f.status) conds.push(eq(task.status, f.status));
  if (f.assigneeId) conds.push(eq(task.assigneeId, f.assigneeId));
  if (f.entityType) conds.push(eq(task.entityType, f.entityType));
  if (f.entityId) conds.push(eq(task.entityId, f.entityId));
  const rows = await db.select().from(task).where(and(...conds)).orderBy(desc(task.createdAt)).limit(500);
  const names = await userNames(db, orgId, rows.map((r) => r.assigneeId));
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    assigneeId: r.assigneeId,
    assigneeName: names.get(r.assigneeId) ?? "Unknown",
    dueAt: r.dueAt,
    status: r.status,
    entityType: r.entityType,
    entityId: r.entityId,
    createdAt: r.createdAt,
  }));
}
export const getTask = (db: DB, orgId: string, id: string) => db.query.task.findFirst({ where: and(eq(task.orgId, orgId), eq(task.id, id)) });
export const updateTask = (db: DB, orgId: string, id: string, patch: Partial<Pick<TaskRow, "title" | "assigneeId" | "dueAt" | "status">>) =>
  db.update(task).set(patch).where(and(eq(task.orgId, orgId), eq(task.id, id)));
export async function openTaskCounts(db: DB, orgId: string) {
  return db.select({ assigneeId: task.assigneeId, n: sql<number>`count(*)` }).from(task).where(and(eq(task.orgId, orgId), eq(task.status, "open"))).groupBy(task.assigneeId);
}

// ---------- in-app notifications ----------
export async function insertNotification(db: DB, n: { id: string; orgId: string; recipientKind: "staff" | "client"; recipientId: string; kind: string; title: string; link?: string | null }) {
  await db.insert(notification).values({ ...n, link: n.link ?? null, createdAt: Date.now() }).onConflictDoNothing();
}
export async function listNotifications(db: DB, orgId: string, kind: "staff" | "client", recipientId: string): Promise<NotificationDto[]> {
  const rows = await db
    .select()
    .from(notification)
    .where(and(eq(notification.orgId, orgId), eq(notification.recipientKind, kind), eq(notification.recipientId, recipientId)))
    .orderBy(desc(notification.createdAt))
    .limit(100);
  return rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, link: r.link, readAt: r.readAt, createdAt: r.createdAt }));
}
export const markNotificationRead = (db: DB, orgId: string, kind: "staff" | "client", recipientId: string, ids: string[] | "all") =>
  db
    .update(notification)
    .set({ readAt: Date.now() })
    .where(
      and(
        eq(notification.orgId, orgId),
        eq(notification.recipientKind, kind),
        eq(notification.recipientId, recipientId),
        isNull(notification.readAt),
        ...(ids === "all" ? [] : [inArray(notification.id, ids)]),
      ),
    );

/** Delivery ledger for idempotent notification sending. Returns false if this channel was already delivered. */
export async function claimDelivery(db: DB, messageId: string, channel: string) {
  const res = await db.insert(notificationDelivery).values({ messageId, channel, deliveredAt: Date.now() }).onConflictDoNothing().returning({ m: notificationDelivery.messageId });
  return res.length > 0;
}
export const releaseDelivery = (db: DB, messageId: string, channel: string) =>
  db.delete(notificationDelivery).where(and(eq(notificationDelivery.messageId, messageId), eq(notificationDelivery.channel, channel)));

export async function wasDelivered(db: DB, messageId: string, channel: string) {
  const r = await db.query.notificationDelivery.findFirst({ where: and(eq(notificationDelivery.messageId, messageId), eq(notificationDelivery.channel, channel)) });
  return !!r;
}
