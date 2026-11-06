import { Hono } from "hono";
import { clients, documents, orgs, reports, tasks, webhooks } from "@da/db";
import { readSecret, sha256Hex } from "@da/crypto";
import { STOP_WORDS, verifyTwilioSignature } from "@da/providers";
import { AppError, uuidv7 } from "@da/shared";
import { type AppEnv, audit } from "../lib/context";
import { log } from "../lib/log";
import { creditProvider, esignProvider, link, notify } from "../lib/services";

/**
 * Provider webhooks. Excluded from Access, so every request is authenticated by the provider's
 * signature (R3.6) and deduplicated by provider event id (R11.5). The WAF adds an IP allowlist.
 */
export const webhookRoutes = new Hono<AppEnv>()
  .post("/esign", async (c) => {
    const provider = await esignProvider(c.env);
    const raw = await c.req.raw.clone().text();
    const ev = await provider.verifyWebhook(c.req.raw);
    if (!ev) throw new AppError("bad_signature", 401, "Invalid signature");
    const db = c.get("db");
    if (!(await webhooks.claimWebhookEvent(db, provider.name, ev.eventId, await sha256Hex(raw)))) return c.text(provider.webhookAck);
    try {
      const req = await webhooks.findEsignRequest(db, ev.providerRequestId);
      if (!req || ev.type === "other") {
        await webhooks.markWebhookProcessed(db, provider.name, ev.eventId);
        return c.text(provider.webhookAck);
      }
      const client = await clients.getClientRow(db, req.orgId, req.clientId);
      const staffId = client?.assignedStaffId;
      if (ev.type === "signed") {
        const pdf = await provider.downloadSigned(ev.providerRequestId);
        const docId = uuidv7();
        const key = documents.docKey(req.orgId, req.clientId, docId);
        await c.env.DOCS.put(key, pdf, { httpMetadata: { contentType: "application/pdf" } });
        await documents.insertDocument(db, {
          id: docId,
          orgId: req.orgId,
          clientId: req.clientId,
          type: "authorization",
          status: "available",
          bucket: "documents",
          objectKey: key,
          filename: "signed-authorization.pdf",
          mime: "application/pdf",
          size: pdf.length,
          encrypted: false,
          uploadedByKind: "system",
          uploadedById: null,
        });
        await webhooks.updateEsignRequest(db, req.id, { status: "signed", signedDocumentId: docId });
        await clients.setAuthStatus(db, req.orgId, req.clientId, "signed");
        if (staffId) await notify(c.env, { id: `esign:${ev.eventId}`, orgId: req.orgId, recipient: { kind: "staff", id: staffId }, event: "authorization_signed", vars: { link: link(c.env, `/admin/clients/${req.clientId}`) } });
      } else {
        await webhooks.updateEsignRequest(db, req.id, { status: ev.type });
        await clients.setAuthStatus(db, req.orgId, req.clientId, ev.type);
        const assignee = staffId ?? (await orgs.orgAdmins(db, req.orgId))[0]?.id;
        if (assignee) {
          await tasks.createTask(db, req.orgId, {
            title: `Authorization ${ev.type}: follow up with client`,
            assigneeId: assignee,
            entityType: "client",
            entityId: req.clientId,
            createdByKind: "system",
            dedupeKey: `esign:${ev.eventId}`,
          });
          await notify(c.env, { id: `esign:${ev.eventId}`, orgId: req.orgId, recipient: { kind: "staff", id: assignee }, event: "authorization_declined", vars: { link: link(c.env, `/admin/clients/${req.clientId}`) } });
        }
      }
      await webhooks.markWebhookProcessed(db, provider.name, ev.eventId);
      audit(c, { orgId: req.orgId, actorKind: "webhook", actorId: provider.name, action: `authorization.${ev.type}`, entityType: "client", entityId: req.clientId, diff: { eventId: ev.eventId } });
      return c.text(provider.webhookAck);
    } catch (e) {
      // Let the provider retry: release the claim so the next delivery is processed.
      await webhooks.releaseWebhookEvent(db, provider.name, ev.eventId);
      throw e;
    }
  })

  .post("/credit", async (c) => {
    const provider = await creditProvider(c.env);
    const raw = await c.req.raw.clone().text();
    const ev = await provider.verifyWebhook(c.req.raw);
    if (!ev) throw new AppError("bad_signature", 401, "Invalid signature");
    const db = c.get("db");
    if (!(await webhooks.claimWebhookEvent(db, provider.name, ev.eventId, await sha256Hex(raw)))) return c.json({ ok: true });
    const rep = await reports.findReportByProviderRef(db, ev.providerRef);
    if (rep?.workflowId) {
      try {
        await (await c.env.WF_IMPORT.get(rep.workflowId)).sendEvent({ type: "report-ready", payload: { providerRef: ev.providerRef, status: ev.type } });
      } catch (e) {
        log.warn("credit_webhook_send_event_failed", { reportId: rep.id, err: String(e) });
      }
    }
    await webhooks.markWebhookProcessed(db, provider.name, ev.eventId);
    audit(c, { orgId: rep?.orgId ?? null, actorKind: "webhook", actorId: provider.name, action: "report.provider_event", entityType: "report", entityId: rep?.id ?? null, diff: { type: ev.type } });
    return c.json({ ok: true });
  })

  // R18.5: STOP handling. Twilio also enforces STOP itself; this keeps our opt-in flag in sync.
  .post("/twilio", async (c) => {
    if (!c.env.TWILIO_AUTH_TOKEN) throw new AppError("not_configured", 404, "Not found");
    const form = await c.req.formData();
    const params: Record<string, string> = {};
    for (const [k, v] of form.entries()) if (typeof v === "string") params[k] = v;
    const url = `${c.env.PUBLIC_URL.replace(/\/$/, "")}${new URL(c.req.url).pathname}`;
    const ok = await verifyTwilioSignature(await readSecret(c.env.TWILIO_AUTH_TOKEN), url, params, c.req.header("x-twilio-signature") ?? "");
    if (!ok) throw new AppError("bad_signature", 401, "Invalid signature");
    if (STOP_WORDS.includes((params.Body ?? "").trim().toLowerCase()) && params.From) {
      await clients.optOutSmsByPhone(c.get("db"), params.From);
      audit(c, { orgId: null, actorKind: "webhook", actorId: "twilio", action: "sms.stop", entityType: "client", diff: { from: "[phone]" } });
    }
    return c.body("<Response/>", 200, { "Content-Type": "text/xml" });
  });
