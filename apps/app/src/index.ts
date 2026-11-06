import * as Sentry from "@sentry/cloudflare";
import { Hono } from "hono";
import type { Env } from "./env";
import type { AppEnv } from "./lib/context";
import { auditTrail, base, clientAuth, onError, staffAuth } from "./middleware";
import { adminRoutes } from "./routes/admin";
import { authRoutes } from "./routes/auth";
import { clientRoutes, documentRoutes } from "./routes/clients";
import { devRoutes } from "./routes/dev";
import { clientLetterRoutes, letterRoutes, roundRoutes } from "./routes/letters";
import { portalRoutes } from "./routes/portal";
import { clientReportRoutes, itemRoutes, reportRoutes } from "./routes/reports";
import { webhookRoutes } from "./routes/webhooks";

export { ClientLock } from "./durable/client-lock";

/**
 * Route order matters: public, webhook, and portal routes are registered before the staff
 * middleware, so a matched public route responds before staffAuth would run.
 */
export const app = new Hono<AppEnv>();
app.onError(onError);
app.use("/api/*", base, auditTrail);

// R23.5: checks D1, R2, and the queue binding.
app.get("/api/v1/health", async (c) => {
  const checks: Record<string, boolean> = {};
  checks.d1 = await c.env.DB.prepare("SELECT 1 AS ok")
    .first<{ ok: number }>()
    .then((r) => r?.ok === 1)
    .catch(() => false);
  checks.r2 = await c.env.DOCS.head("health-check")
    .then(() => true)
    .catch(() => false);
  checks.queue = typeof c.env.Q_NOTIFY?.send === "function";
  const ok = Object.values(checks).every(Boolean);
  return c.json({ ok, checks, env: c.env.APP_ENV }, ok ? 200 : 503);
});

app.route("/api/v1/dev", devRoutes);
app.route("/api/v1/auth", authRoutes);
app.route("/api/v1/webhooks", webhookRoutes);
app.use("/api/v1/portal/*", clientAuth());
app.route("/api/v1/portal", portalRoutes);

// Everything below requires a verified Cloudflare Access identity.
app.use("/api/v1/*", staffAuth);
app.route("/api/v1", adminRoutes);
app.route("/api/v1/clients/:id/reports", clientReportRoutes);
app.route("/api/v1/clients/:id", clientLetterRoutes);
app.route("/api/v1/clients", clientRoutes);
app.route("/api/v1/documents", documentRoutes);
app.route("/api/v1/reports", reportRoutes);
app.route("/api/v1/report-items", itemRoutes);
app.route("/api/v1/letters", letterRoutes);
app.route("/api/v1/dispute-rounds", roundRoutes);
app.all("/api/*", (c) => c.json({ error: { code: "not_found", message: "Not found" } }, 404));

export default Sentry.withSentry(
  (env: Env) => ({ dsn: env.SENTRY_DSN, environment: env.APP_ENV, sendDefaultPii: false, tracesSampleRate: 0 }),
  { fetch: app.fetch } satisfies ExportedHandler<Env>,
);
