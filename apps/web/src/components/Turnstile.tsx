import { resolvedTheme } from "../lib/theme";
import { useEffect, useRef } from "react";

declare global {
  interface Window {
    turnstile?: { render: (el: HTMLElement, opts: Record<string, unknown>) => string; remove: (id: string) => void };
  }
}

const SITE_KEY: string = import.meta.env.VITE_TURNSTILE_SITE_KEY || "1x00000000000000000000AA";
export const DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
/** e2e tests run against APP_ENV=test, which accepts the dummy token. */
export function turnstileBypassed(): boolean {
  if (import.meta.env.VITE_TURNSTILE_BYPASS === "1") return true;
  // Remember ?turnstile=test for the tab so it survives in-app navigation (login -> forgot, etc.).
  try {
    if (new URLSearchParams(location.search).get("turnstile") === "test") sessionStorage.setItem("da_turnstile_test", "1");
    return sessionStorage.getItem("da_turnstile_test") === "1";
  } catch {
    return new URLSearchParams(location.search).get("turnstile") === "test";
  }
}

let loader: Promise<void> | undefined;
const loadScript = () =>
  (loader ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      loader = undefined;
      reject(new Error("Verification failed to load"));
    };
    document.head.appendChild(s);
  }));

/** Cloudflare Turnstile, explicit render. Remount (change `key`) after a failed submit to get a fresh token. */
export function Turnstile({ onToken }: { onToken: (token: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onToken);
  cb.current = onToken;
  useEffect(() => {
    if (turnstileBypassed()) {
      cb.current(DUMMY_TOKEN);
      return;
    }
    let id: string | undefined;
    let alive = true;
    loadScript()
      .then(() => {
        if (!alive || !ref.current || !window.turnstile) return;
        id = window.turnstile.render(ref.current, {
          sitekey: SITE_KEY,
          // Invisible unless Cloudflare needs the user to interact; matches the chosen appearance.
          appearance: "interaction-only",
          theme: resolvedTheme(),
          size: "flexible",
          callback: (t: string) => cb.current(t),
          "expired-callback": () => cb.current(""),
          "error-callback": () => cb.current(""),
        });
      })
      .catch(() => cb.current(""));
    return () => {
      alive = false;
      if (id) window.turnstile?.remove(id);
      cb.current("");
    };
  }, []);
  if (turnstileBypassed()) return null;
  return <div ref={ref} className="empty:hidden" />;
}
