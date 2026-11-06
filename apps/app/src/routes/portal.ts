import { Hono } from "hono";
import { z } from "zod";
import { auth as authRepo, clients, documents, letters, reports, tasks } from "@da/db";
import { AppError, type Me, portalPreferences } from "@da/shared";
import { type AppEnv, audit, clientP } from "../lib/context";
import { acceptUpload, streamDocument } from "../lib/documents";
import { newTotpSecret, otpauthUrl, verifyTotp } from "../lib/totp";
import { body } from "../middleware";

/** Client portal: every query is scoped to the signed-in client's own org and client id (R5.2). */
export const portalRoutes = new Hono<AppEnv>()
  .get("/me", async (c) => {
    const p = clientP(c);
    const db = c.get("db");
    const [client, acct] = await Promise.all([clients.getClientRow(db, p.orgId, p.clientId), authRepo.getAccount(db, p.id)]);
    if (!client || !acct) throw new AppError("not_found", 404, "Account not found");
    const me: Me = { kind: "client", id: p.id, orgId: p.orgId, clientId: p.clientId, email: p.email, firstName: client.firstName, mfaType: acct.mfaType, smsOptIn: client.smsOptIn };
    return c.json(me);
  })

  .get("/documents", async (c) => {
    const p = clientP(c);
    return c.json(await documents.listDocuments(c.get("db"), p.orgId, p.clientId, { visibleToClient: true }));
  })
  .post("/documents", async (c) => {
    const p = clientP(c);
    return c.json(await acceptUpload(c, { orgId: p.orgId, clientId: p.clientId, kind: "client", id: p.id }), 201);
  })
  .get("/documents/:id/download", async (c) => {
    const p = clientP(c);
    const d = await documents.getDocument(c.get("db"), p.orgId, c.req.param("id"));
    const visible = d && d.clientId === p.clientId && (d.uploadedByKind === "client" || d.type === "authorization");
    if (!d || !visible) throw new AppError("not_found", 404, "Document not found");
    return streamDocument(c, d);
  })

  // R13.5: read-only, masked account numbers, plain-language flag reasons.
  .get("/reports", async (c) => {
    const p = clientP(c);
    return c.json(await reports.listReports(c.get("db"), p.orgId, p.clientId));
  })
  .get("/reports/:id/items", async (c) => {
    const p = clientP(c);
    const db = c.get("db");
    const r = await reports.getReport(db, p.orgId, c.req.param("id"));
    if (!r || r.clientId !== p.clientId) throw new AppError("not_found", 404, "Report not found");
    const items = await reports.itemDtos(db, p.orgId, await reports.itemsForReport(db, p.orgId, r.id));
    return c.json(items.map((i) => ({ ...i, flags: i.flags.map((f) => ({ ...f, ruleId: null })) })));
  })

  .get("/letters", async (c) => {
    const p = clientP(c);
    return c.json(await letters.portalLetters(c.get("db"), p.orgId, p.clientId));
  })

  .get("/notifications", async (c) => {
    const p = clientP(c);
    return c.json(await tasks.listNotifications(c.get("db"), p.orgId, "client", p.clientId));
  })
  .post("/notifications/read", async (c) => {
    const { ids } = await body(c, z.object({ ids: z.union([z.array(z.string().max(64)).max(200), z.literal("all")]) }));
    const p = clientP(c);
    await tasks.markNotificationRead(c.get("db"), p.orgId, "client", p.clientId, ids);
    return c.json({ ok: true });
  })

  // R18.5: SMS is opt-in only.
  .patch("/preferences", async (c) => {
    const { smsOptIn } = await body(c, portalPreferences);
    const p = clientP(c);
    const client = await clients.getClientRow(c.get("db"), p.orgId, p.clientId);
    if (smsOptIn && !client?.phone) throw new AppError("no_phone", 400, "Ask your specialist to add a mobile number first");
    await clients.setSmsOptIn(c.get("db"), p.orgId, p.clientId, smsOptIn);
    audit(c, { action: smsOptIn ? "sms.opt_in" : "sms.opt_out", entityType: "client", entityId: p.clientId });
    return c.json({ smsOptIn });
  })

  /**
   * Re-enroll or switch to an authenticator app. The pending secret travels as a ciphertext bound
   * to this account (AAD), so no server state is needed between the two calls.
   */
  .post("/mfa/totp/start", async (c) => {
    const p = clientP(c);
    const secret = newTotpSecret();
    const enrollmentToken = await c.get("fc").encrypt(`totp-enroll:${p.id}`, `${Date.now()}:${secret}`);
    return c.json({ secret, otpauthUrl: otpauthUrl(secret, p.email), enrollmentToken });
  })
  .post("/mfa/totp/confirm", async (c) => {
    const { enrollmentToken, code } = await body(c, z.object({ enrollmentToken: z.string().max(500), code: z.string().regex(/^\d{6}$/) }));
    const p = clientP(c);
    const fc = c.get("fc");
    let secret: string;
    try {
      const [issued, s] = (await fc.decrypt(`totp-enroll:${p.id}`, enrollmentToken)).split(":");
      if (Date.now() - Number(issued) > 15 * 60_000) throw new Error("expired");
      secret = s;
    } catch {
      throw new AppError("enrollment_invalid", 400, "Start the setup again");
    }
    const step = await verifyTotp(secret, code);
    if (step === null) throw new AppError("invalid_code", 401, "That code is not valid");
    await authRepo.setTotpSecret(c.get("db"), p.id, await fc.encrypt("client_account.totp", secret));
    await authRepo.setTotpStep(c.get("db"), p.id, step);
    audit(c, { action: "mfa.totp_enrolled", entityType: "client_account", entityId: p.id });
    return c.json({ ok: true });
  });
