import type { KeyboardEvent } from "react";
import { type ThemePref, useTheme } from "../lib/theme";
import { Icon, type IconName } from "./icons";
import { cx } from "./ui";

const OPTIONS: { id: ThemePref; label: string; icon: IconName }[] = [
  { id: "light", label: "Light", icon: "sun" },
  { id: "dark", label: "Dark", icon: "moon" },
  { id: "system", label: "Auto", icon: "display" },
];

/**
 * Light / Dark / Auto segmented control (radio-group semantics, arrow keys move the choice).
 * `compact` shows icons only, for toolbars; the full version shows labels.
 */
export function ThemeSwitcher({ compact = false, className }: { compact?: boolean; className?: string }) {
  const { pref, setTheme } = useTheme();
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = OPTIONS.findIndex((o) => o.id === pref);
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = OPTIONS[(i + step + OPTIONS.length) % OPTIONS.length];
    setTheme(next.id);
    (e.currentTarget.querySelector(`[data-theme-option="${next.id}"]`) as HTMLElement | null)?.focus();
  };
  return (
    <div role="radiogroup" aria-label="Appearance" onKeyDown={onKey} className={cx("inline-flex shrink-0 gap-0.5 rounded-full bg-fill p-[3px]", className)}>
      {OPTIONS.map((o) => {
        const on = o.id === pref;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={compact ? `${o.label} appearance` : undefined}
            title={compact ? (o.id === "system" ? "Auto (match system)" : o.label) : undefined}
            data-theme-option={o.id}
            tabIndex={on ? 0 : -1}
            onClick={() => setTheme(o.id)}
            className={cx(
              "inline-flex items-center justify-center gap-1.5 rounded-full text-[13px] font-medium transition-all duration-150",
              compact ? "size-7" : "h-8 px-3.5",
              on ? "bg-surface text-ink shadow-[0_1px_3px_rgba(0,0,0,.12),0_0_0_.5px_var(--line)]" : "text-ink-3 hover:text-ink",
            )}
          >
            <Icon name={o.icon} className={compact ? "size-[15px]" : "size-4"} />
            {!compact && o.label}
          </button>
        );
      })}
    </div>
  );
}
