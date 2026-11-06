import { and, eq } from "drizzle-orm";
import { uuidv7 } from "@da/shared";
import type { DB } from "../client";
import { esignRequest, webhookEvent } from "../schema";

/** Records a webhook event; returns false if this provider event id was already seen (R11.5). */
export async function claimWebhookEvent(db: DB, provider: string, providerEventId: string, payloadHash: string) {
  const res = await db
    .insert(webhookEvent)
    .values({ id: uuidv7(), provider, providerEventId, payloadHash, receivedAt: Date.now() })
    .onConflictDoNothing()
    .returning({ id: webhookEvent.id });
  return res.length > 0;
}
export const markWebhookProcessed = (db: DB, provider: string, providerEventId: string) =>
  db.update(webhookEvent).set({ processedAt: Date.now() }).where(and(eq(webhookEvent.provider, provider), eq(webhookEvent.providerEventId, providerEventId)));
/** Lets the provider retry if processing failed after the event was claimed. */
export const releaseWebhookEvent = (db: DB, provider: string, providerEventId: string) =>
  db.delete(webhookEvent).where(and(eq(webhookEvent.provider, provider), eq(webhookEvent.providerEventId, providerEventId)));

export async function createEsignRequest(db: DB, orgId: string, clientId: string, provider: string, providerRequestId: string) {
  const row = { id: uuidv7(), orgId, clientId, provider, providerRequestId, status: "sent" as const, createdAt: Date.now() };
  await db.insert(esignRequest).values(row);
  return row;
}
export const findEsignRequest = (db: DB, providerRequestId: string) => db.query.esignRequest.findFirst({ where: eq(esignRequest.providerRequestId, providerRequestId) });
export const updateEsignRequest = (db: DB, id: string, patch: Partial<Pick<typeof esignRequest.$inferSelect, "status" | "signedDocumentId">>) =>
  db.update(esignRequest).set(patch).where(eq(esignRequest.id, id));
