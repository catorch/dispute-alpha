/** Sentry loads only when a DSN is configured, and as its own chunk so it never weighs on the entry bundle. */
let sentry: typeof import("@sentry/react") | undefined;

export function initSentry() {
  const dsn: string | undefined = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return;
  import("@sentry/react").then((S) => {
    S.init({ dsn, sendDefaultPii: false, environment: import.meta.env.MODE, tracesSampleRate: 0 });
    sentry = S;
  });
}

export const reportError = (e: unknown) => sentry?.captureException(e);
