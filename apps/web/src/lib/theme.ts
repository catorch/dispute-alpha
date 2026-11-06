/** Appearance preference: Light (default), Dark, or System. Applied as <html data-theme>; see public/theme.js. */
import { useSyncExternalStore } from "react";

export type ThemePref = "light" | "dark" | "system";
const KEY = "da-theme";
const listeners = new Set<() => void>();
const dark = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;

export const readTheme = (): ThemePref => {
  const t = typeof document !== "undefined" ? document.documentElement.dataset.theme : "light";
  return t === "dark" || t === "system" ? t : "light";
};

export function setTheme(t: ThemePref) {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem(KEY, t);
  } catch {
    // Private mode or blocked storage: the choice still applies for this page view.
  }
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  dark?.addEventListener("change", l);
  return () => {
    listeners.delete(l);
    dark?.removeEventListener("change", l);
  };
};

/** The saved preference and what is actually shown ("system" resolved against the OS setting). */
export function useTheme() {
  const pref = useSyncExternalStore(subscribe, readTheme, () => "light" as ThemePref);
  const osDark = useSyncExternalStore(subscribe, () => !!dark?.matches, () => false);
  const resolved: "light" | "dark" = pref === "system" ? (osDark ? "dark" : "light") : pref;
  return { pref, resolved, setTheme };
}

/** Resolved theme right now, for third-party widgets that take a fixed light/dark value. */
export const resolvedTheme = (): "light" | "dark" => {
  const t = readTheme();
  return t === "system" ? (dark?.matches ? "dark" : "light") : t;
};
