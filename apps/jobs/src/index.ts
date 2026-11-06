import * as Sentry from "@sentry/cloudflare";
import type { Env } from "./env";
import { scheduledHandler } from "./cron";
import { queueHandler } from "./queues";

export { ClamAvContainer } from "./container";
export { ReportImportWorkflow } from "./workflows/report-import";
export { LetterPipelineWorkflow } from "./workflows/letter-pipeline";
export { DisputeDeadlineWorkflow } from "./workflows/dispute-deadline";

/** da-jobs: queue consumers, workflow classes, and cron triggers. No public HTTP surface. */
export default Sentry.withSentry((env: Env) => ({ dsn: env.SENTRY_DSN, environment: env.APP_ENV, sendDefaultPii: false, tracesSampleRate: 0 }), {
  async fetch() {
    return new Response("Not found", { status: 404 });
  },
  queue: (batch, env) => queueHandler(batch, env),
  scheduled: (controller, env) => scheduledHandler(controller, env),
} satisfies ExportedHandler<Env>);
