/**
 * Design-system primitives. Semantic tokens only (see index.css), so light and dark mode come for free.
 * Native elements first: <dialog>, <select>, <input type="date">.
 */
import type { UseQueryResult } from "@tanstack/react-query";
import { type ButtonHTMLAttributes, type ComponentProps, type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { errorMessage } from "../lib/api";
import { type Tone, humanize, toneOf } from "../lib/format";
import { Icon, type IconName } from "./icons";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

const BTN = {
  primary: "bg-accent text-white shadow-[inset_0_1px_0_rgba(255,255,255,.12)] hover:bg-accent-hover active:brightness-95 disabled:opacity-40",
  secondary: "bg-fill text-ink hover:bg-fill-strong active:brightness-95 disabled:text-ink-3 disabled:opacity-70",
  danger: "bg-neg-soft text-neg hover:bg-[color-mix(in_oklab,var(--neg-soft),var(--neg)_8%)] active:brightness-95 disabled:opacity-40",
  ghost: "text-accent-ink hover:bg-accent-soft disabled:text-ink-3 disabled:hover:bg-transparent",
};
export function Button({
  variant = "primary",
  busy,
  small,
  icon,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof BTN; busy?: boolean; small?: boolean; icon?: IconName }) {
  return (
    <button
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx(
        "inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-full font-medium transition-[background-color,filter,opacity] duration-150 disabled:cursor-not-allowed",
        small ? "h-7 px-3 text-[13px]" : "h-9 px-[18px] text-[14px]",
        BTN[variant],
        className,
      )}
      {...rest}
    >
      {busy ? <span className="size-3.5 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" aria-hidden /> : icon && <Icon name={icon} className={small ? "size-3.5" : "size-4"} />}
      {children}
    </button>
  );
}

type FieldProps = { label: ReactNode; error?: string; hint?: ReactNode; srOnlyLabel?: boolean };
const control = (err?: string) =>
  cx(
    "block w-full rounded-[10px] border bg-surface px-3 text-[15px] text-ink transition-[border-color,box-shadow] duration-150 placeholder:text-ink-3 focus:outline-none focus-visible:outline-none disabled:bg-fill disabled:text-ink-3",
    err ? "border-neg focus:shadow-[0_0_0_4px_var(--neg-soft)]" : "border-line-strong hover:border-ink-3/50 focus:border-accent focus:shadow-[0_0_0_4px_var(--accent-ring)]",
  );

function Field({ id, label, error, hint, srOnlyLabel, children }: FieldProps & { id: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className={cx("block text-[13px] font-medium text-ink-2", srOnlyLabel && "sr-only")}>
        {label}
      </label>
      {children}
      {hint && !error && (
        <p id={`${id}-hint`} className="text-[12px] text-ink-3">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-err`} className="flex items-center gap-1 text-[12px] font-medium text-neg">
          <Icon name="alert" className="size-3.5 shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}
const described = (id: string, error?: string, hint?: ReactNode) => ({
  "aria-invalid": error ? true : undefined,
  "aria-describedby": error ? `${id}-err` : hint ? `${id}-hint` : undefined,
});

export function Input({ label, error, hint, srOnlyLabel, className, ...rest }: FieldProps & ComponentProps<"input">) {
  const id = useId();
  const file = rest.type === "file";
  return (
    <Field id={id} label={label} error={error} hint={hint} srOnlyLabel={srOnlyLabel}>
      <input
        id={id}
        className={cx(
          control(error),
          file
            ? "py-1.5 file:mr-3 file:rounded-full file:border-0 file:bg-fill file:px-3 file:py-1 file:text-[13px] file:font-medium file:text-ink hover:file:bg-fill-strong"
            : "h-10",
          className,
        )}
        {...described(id, error, hint)}
        {...rest}
      />
    </Field>
  );
}
export function Textarea({ label, error, hint, srOnlyLabel, className, ...rest }: FieldProps & ComponentProps<"textarea">) {
  const id = useId();
  return (
    <Field id={id} label={label} error={error} hint={hint} srOnlyLabel={srOnlyLabel}>
      <textarea id={id} rows={4} className={cx(control(error), "py-2.5 leading-relaxed", className)} {...described(id, error, hint)} {...rest} />
    </Field>
  );
}
export function Select({ label, error, hint, srOnlyLabel, className, options, placeholder, ...rest }: FieldProps & ComponentProps<"select"> & { options: readonly (string | { value: string; label: string })[]; placeholder?: string }) {
  const id = useId();
  return (
    <Field id={id} label={label} error={error} hint={hint} srOnlyLabel={srOnlyLabel}>
      <select id={id} className={cx(control(error), "select-chevron h-10", className)} {...described(id, error, hint)} {...rest}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => {
          const v = typeof o === "string" ? { value: o, label: humanize(o) } : o;
          return (
            <option key={v.value} value={v.value}>
              {v.label}
            </option>
          );
        })}
      </select>
    </Field>
  );
}
export function Checkbox({ label, className, ...rest }: { label: ReactNode } & ComponentProps<"input">) {
  return (
    <label className={cx("inline-flex cursor-pointer items-center gap-2 text-[14px] text-ink", className)}>
      <input type="checkbox" className="size-4 rounded" {...rest} />
      {label}
    </label>
  );
}

const CHIP: Record<Tone, string> = {
  gray: "bg-fill text-ink-2",
  blue: "bg-info-soft text-info",
  green: "bg-pos-soft text-pos",
  amber: "bg-warn-soft text-warn",
  red: "bg-neg-soft text-neg",
  indigo: "bg-violet-soft text-violet",
};
export const Chip = ({ tone = "gray", children, className, wrap }: { tone?: Tone; children: ReactNode; className?: string; wrap?: boolean }) => (
  <span
    className={cx(
      "inline-flex items-center gap-1 rounded-full px-2.5 text-[12px] font-medium tracking-[-0.003em]",
      wrap ? "min-h-[22px] py-[3px] leading-snug" : "h-[22px] whitespace-nowrap",
      CHIP[tone],
      className,
    )}
  >
    {children}
  </span>
);
export const StatusChip = ({ status, label }: { status: string; label?: string }) => <Chip tone={toneOf(status)}>{label ?? humanize(status)}</Chip>;

export const Card = ({ title, actions, children, className, padded = true }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; padded?: boolean }) => (
  <section data-card className={cx("rounded-2xl bg-surface shadow-card [--card-pad:1.25rem] sm:[--card-pad:1.5rem]", padded && "p-(--card-pad)", className)}>
    {(title || actions) && (
      <div className={cx("mb-4 flex flex-wrap items-center justify-between gap-2", !padded && "px-(--card-pad) pt-(--card-pad)")}>
        {title && <h2 className="text-[17px] font-semibold text-ink">{title}</h2>}
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    )}
    {children}
  </section>
);

export const PageHeader = ({ title, subtitle, actions, eyebrow }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) => (
  <div className="animate-in mb-8 flex flex-wrap items-end justify-between gap-4">
    <div className="min-w-0">
      {eyebrow && <div className="mb-1 text-[13px] font-medium text-ink-3">{eyebrow}</div>}
      <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.025em] text-ink sm:text-[32px]">{title}</h1>
      {subtitle && <div className="mt-2 text-[15px] text-ink-2">{subtitle}</div>}
    </div>
    {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
  </div>
);

/** Large-number summary tile for dashboards. */
export const Stat = ({ label, value, icon, tone = "gray", footer }: { label: string; value: ReactNode; icon?: IconName; tone?: Tone; footer?: ReactNode }) => (
  <div className="rounded-2xl bg-surface p-5 shadow-card">
    <div className="flex items-center justify-between">
      <span className="text-[13px] font-medium text-ink-2">{label}</span>
      {icon && (
        <span className={cx("grid size-8 place-items-center rounded-full", CHIP[tone])}>
          <Icon name={icon} className="size-4" />
        </span>
      )}
    </div>
    <div className="mt-3 text-[34px] font-semibold leading-none tracking-[-0.03em] text-ink tabular-nums">{value}</div>
    {footer && <div className="mt-2 text-[13px] text-ink-3">{footer}</div>}
  </div>
);

const ALERT = {
  red: { cls: "bg-neg-soft text-neg", icon: "alert" },
  amber: { cls: "bg-warn-soft text-warn", icon: "alert" },
  green: { cls: "bg-pos-soft text-pos", icon: "check" },
  blue: { cls: "bg-info-soft text-info", icon: "info" },
} as const;
export function Alert({ tone = "red", title, children }: { tone?: keyof typeof ALERT; title?: ReactNode; children?: ReactNode }) {
  const a = ALERT[tone];
  return (
    <div role={tone === "red" ? "alert" : "status"} className={cx("flex gap-2.5 rounded-xl px-3.5 py-3 text-[14px] leading-snug", a.cls)}>
      <Icon name={a.icon} className="mt-px size-[18px] shrink-0" />
      <div className="min-w-0">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={title ? "mt-0.5 opacity-90" : undefined}>{children}</div>}
      </div>
    </div>
  );
}
export const ErrorText = ({ error }: { error: unknown }) => (error ? <Alert>{errorMessage(error)}</Alert> : null);

export const Spinner = ({ label = "Loading" }: { label?: string }) => (
  <p role="status" className="flex items-center justify-center gap-2.5 py-10 text-[14px] text-ink-3">
    <span className="size-4 animate-spin rounded-full border-2 border-ink-3/30 border-t-ink-3" aria-hidden />
    {label}…
  </p>
);
export const Empty = ({ children, icon = "inbox" }: { children: ReactNode; icon?: IconName }) => (
  <div className="flex flex-col items-center justify-center gap-2 py-10 text-center text-[14px] text-ink-3">
    <span className="grid size-10 place-items-center rounded-full bg-fill text-ink-3">
      <Icon name={icon} className="size-5" />
    </span>
    <p>{children}</p>
  </div>
);

/** Renders loading and error states for a query, then the data. */
export function Q<T>({ q, children }: { q: UseQueryResult<T>; children: (data: T) => ReactNode }) {
  if (q.isPending) return <Spinner />;
  if (q.isError) return <ErrorText error={q.error} />;
  return <>{children(q.data)}</>;
}

/** Native modal dialog: focus trap, Escape and inert background come from the platform. */
export function Dialog({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      className={cx("m-auto max-h-[calc(100vh-3rem)] w-[calc(100%-2rem)] rounded-[22px] bg-elevated p-0 text-ink shadow-pop", wide ? "max-w-4xl" : "max-w-lg")}
    >
      {open && (
        <div className="p-6">
          <div className="mb-5 flex items-start justify-between gap-4">
            <h2 id={titleId} className="text-[19px] font-semibold tracking-[-0.02em]">
              {title}
            </h2>
            <button type="button" onClick={onClose} className="grid size-7 shrink-0 place-items-center rounded-full bg-fill text-ink-2 transition-colors hover:bg-fill-strong" aria-label="Close dialog">
              <Icon name="x" className="size-3.5" />
            </button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}

/** Segmented control with ARIA tab semantics and arrow-key navigation; caller renders the panel in <TabPanel>. */
export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: readonly { id: T; label: string }[]; value: T; onChange: (id: T) => void; label: string }) {
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((t) => t.id === value);
    const next = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const t = tabs[(next + tabs.length) % tabs.length];
    onChange(t.id);
    document.getElementById(`tab-${t.id}`)?.focus();
  };
  return (
    <div className="mb-6 max-w-full overflow-x-auto [scrollbar-width:none]">
      <div role="tablist" aria-label={label} onKeyDown={onKey} className="inline-flex gap-0.5 rounded-[11px] bg-fill p-[3px]">
        {tabs.map((t) => (
          <button
            key={t.id}
            id={`tab-${t.id}`}
            type="button"
            role="tab"
            aria-selected={t.id === value}
            aria-controls={`panel-${t.id}`}
            tabIndex={t.id === value ? 0 : -1}
            onClick={() => onChange(t.id)}
            className={cx(
              "h-8 whitespace-nowrap rounded-[8px] px-3.5 text-[13px] font-medium transition-all duration-150",
              t.id === value ? "bg-surface text-ink shadow-[0_1px_3px_rgba(0,0,0,.1),0_0_0_.5px_var(--line)]" : "text-ink-2 hover:text-ink",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}
export const TabPanel = ({ id, children }: { id: string; children: ReactNode }) => (
  <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} tabIndex={0} className="animate-in rounded-2xl focus-visible:outline-offset-4">
    {children}
  </div>
);

export const Table = ({ children, caption }: { children: ReactNode; caption?: string }) => (
  <div className="da-table overflow-x-auto rounded-2xl bg-surface shadow-card">
    <table className="min-w-full text-left text-[14px] [&_tbody_tr]:border-t [&_tbody_tr]:border-line [&_tbody_tr]:transition-colors [&_tbody_tr:hover]:bg-fill/50 [&_td]:px-4 [&_td]:py-3 [&_td]:align-middle [&_th]:whitespace-nowrap [&_th]:px-4 [&_th]:pt-3.5 [&_th]:pb-2.5 [&_th]:text-[12px] [&_th]:font-medium [&_th]:text-ink-3">
      {caption && <caption className="sr-only">{caption}</caption>}
      {children}
    </table>
  </div>
);

/** Copyable monospace block (TOTP secrets). */
export function CopyBlock({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div role="group" aria-label={label} className="flex items-center gap-2 rounded-xl bg-fill p-1.5 pl-3.5">
      <code className="flex-1 break-all font-mono text-[14px] tracking-[0.08em] text-ink">{value}</code>
      <Button variant="secondary" small className="bg-surface shadow-card" onClick={() => navigator.clipboard?.writeText(value).then(() => setCopied(true))}>
        <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
      </Button>
    </div>
  );
}

/** Dialog asking for a required reason (flag add/remove, letter rejection). */
export function ReasonDialog({ open, title, label, submitLabel, danger, busy, error, onClose, onSubmit }: { open: boolean; title: string; label: string; submitLabel: string; danger?: boolean; busy?: boolean; error?: unknown; onClose: () => void; onSubmit: (reason: string) => void }) {
  const [local, setLocal] = useState<string>();
  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <form
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          const reason = String(new FormData(e.currentTarget).get("reason") ?? "").trim();
          if (reason.length < 3) return setLocal("Enter at least 3 characters");
          setLocal(undefined);
          onSubmit(reason);
        }}
      >
        <Textarea label={label} name="reason" rows={3} maxLength={1000} error={local} autoFocus />
        <ErrorText error={error} />
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant={danger ? "danger" : "primary"} busy={busy}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Initials avatar. */
export const Avatar = ({ name, size = 32 }: { name: string; size?: number }) => {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
  return (
    <span aria-hidden style={{ width: size, height: size, fontSize: size * 0.38 }} className="grid shrink-0 place-items-center rounded-full bg-gradient-to-br from-[#8e8e93] to-[#636366] font-semibold text-white">
      {initials || "?"}
    </span>
  );
};
