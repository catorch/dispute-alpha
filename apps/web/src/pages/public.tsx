/** Client sign-in flows: login + MFA, invite acceptance, password reset. */
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { MFA_TYPES, type MfaType, inviteComplete, loginRequest, mfaRequest, resetComplete, resetRequest } from "@da/shared";
import { type FormEvent, type ReactNode, useState } from "react";
import type { z } from "zod";
import { Turnstile } from "../components/Turnstile";
import { Logo } from "../components/icons";
import { ThemeSwitcher } from "../components/ThemeSwitcher";
import { Alert, Button, CopyBlock, ErrorText, Input, Spinner } from "../components/ui";
import { ApiError, api, post } from "../lib/api";
import { fmtDate, issuesToMap } from "../lib/format";

export function AuthLayout({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden">
      <div className="absolute top-4 right-4 z-10">
        <ThemeSwitcher compact />
      </div>
      <div aria-hidden className="pointer-events-none absolute inset-x-0 -top-40 mx-auto h-[28rem] max-w-3xl rounded-full bg-[radial-gradient(closest-side,var(--accent-soft),transparent)] blur-2xl" />
      <main className="relative flex flex-1 items-start justify-center px-4 pt-16 pb-10 sm:items-center sm:pt-10">
        <div className="animate-in w-full max-w-[400px]">
          <div className="mb-8 flex flex-col items-center text-center">
            <Logo size={52} />
            <h1 className="mt-6 text-[28px] font-semibold leading-tight tracking-[-0.025em] text-ink">{title}</h1>
            {subtitle && <p className="mt-2 text-[15px] text-ink-2">{subtitle}</p>}
          </div>
          <div className="rounded-[22px] bg-surface p-6 shadow-card sm:p-8">{children}</div>
        </div>
      </main>
      <footer className="relative pb-8 text-center text-[12px] text-ink-3">Dispute Alpha · Your information is encrypted and every access is logged.</footer>
    </div>
  );
}

const formValues = (e: FormEvent<HTMLFormElement>) => {
  e.preventDefault();
  return Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
};

/** Parses with a shared Zod schema; on failure sets field errors and returns null. */
function check<S extends z.ZodType>(schema: S, value: unknown, setErrors: (e: Record<string, string>) => void): z.output<S> | null {
  const r = schema.safeParse(value);
  setErrors(r.success ? {} : issuesToMap(r.error.issues));
  return r.success ? r.data : null;
}

/** Fresh Turnstile token handling: remount the widget after each failed submit (tokens are single-use). */
function useTurnstile() {
  const [token, setToken] = useState("");
  const [key, setKey] = useState(0);
  return { token, reset: () => setKey((k) => k + 1), widget: <Turnstile key={key} onToken={setToken} /> };
}

export function LoginPage() {
  const navigate = useNavigate();
  const ts = useTurnstile();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [mfaType, setMfaType] = useState<string | null>(null);
  const [resent, setResent] = useState(false);

  const login = useMutation({
    mutationFn: (b: z.output<typeof loginRequest>) => post<{ mfaRequired: boolean; mfaType: MfaType }>("/auth/client/login", b),
    onSuccess: (r) => setMfaType(r.mfaType),
    onError: ts.reset,
  });
  const mfa = useMutation({
    mutationFn: (code: string) => post("/auth/client/mfa", { code }),
    onSuccess: () => navigate({ to: "/portal" }),
    onError: (e) => {
      if (e instanceof ApiError && ["session_expired", "unauthenticated", "account_locked"].includes(e.code)) {
        setMfaType(null);
        login.reset();
      }
    },
  });
  const resend = useMutation({ mutationFn: () => post("/auth/client/mfa/resend"), onSuccess: () => setResent(true) });

  if (mfaType)
    return (
      <AuthLayout title="Enter your verification code">
        <form
          noValidate
          className="space-y-4"
          onSubmit={(e) => {
            const v = check(mfaRequest, formValues(e), setErrors);
            if (v) mfa.mutate(v.code);
          }}
        >
          <p className="text-sm text-ink-2">{mfaType === "email" ? "We emailed you a 6-digit code. It expires in 10 minutes." : "Open your authenticator app and enter the 6-digit code."}</p>
          <Input label="Verification code" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus error={errors.code} />
          <ErrorText error={mfa.error} />
          <div aria-live="polite">{resent && <Alert tone="green">A new code is on its way.</Alert>}</div>
          <Button type="submit" busy={mfa.isPending} className="w-full">
            Verify
          </Button>
          {mfaType === "email" && (
            <Button variant="ghost" className="w-full" busy={resend.isPending} onClick={() => resend.mutate()}>
              Resend code
            </Button>
          )}
        </form>
      </AuthLayout>
    );

  return (
    <AuthLayout title="Sign in to your portal">
      <form
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          const v = check(loginRequest, { ...formValues(e), turnstileToken: ts.token }, setErrors);
          if (v) login.mutate(v);
        }}
      >
        <Input label="Email" name="email" type="email" autoComplete="email" required error={errors.email} />
        <Input label="Password" name="password" type="password" autoComplete="current-password" required error={errors.password} />
        {ts.widget}
        {errors.turnstileToken && <p className="text-xs font-medium text-neg">{errors.turnstileToken}</p>}
        <ErrorText error={login.error} />
        <Button type="submit" busy={login.isPending} className="w-full">
          Continue
        </Button>
        <p className="text-center text-sm">
          <Link to="/forgot" className="link">
            Forgot your password?
          </Link>
        </p>
        <p className="text-center text-xs text-ink-3">
          Staff member?{" "}
          <Link to="/admin" className="link">
            Go to the staff app
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}

export function ForgotPage() {
  const ts = useTurnstile();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const m = useMutation({ mutationFn: (b: z.output<typeof resetRequest>) => post("/auth/client/reset/request", b), onError: ts.reset });
  return (
    <AuthLayout title="Reset your password">
      {m.isSuccess ? (
        <Alert tone="green">If an account exists for that email, we sent a reset link. It expires in one hour.</Alert>
      ) : (
        <form
          noValidate
          className="space-y-4"
          onSubmit={(e) => {
            const v = check(resetRequest, { ...formValues(e), turnstileToken: ts.token }, setErrors);
            if (v) m.mutate(v);
          }}
        >
          <Input label="Email" name="email" type="email" autoComplete="email" error={errors.email} />
          {ts.widget}
          {errors.turnstileToken && <p className="text-xs font-medium text-neg">{errors.turnstileToken}</p>}
          <ErrorText error={m.error} />
          <Button type="submit" busy={m.isPending} className="w-full">
            Send reset link
          </Button>
        </form>
      )}
      <p className="mt-4 text-center text-sm">
        <Link to="/login" className="link">
          Back to sign in
        </Link>
      </p>
    </AuthLayout>
  );
}

/** Password + confirmation fields; returns the confirmation error, if any. */
const confirmError = (v: Record<string, string>) => (v.password !== v.confirm ? { confirm: "Passwords do not match" } : null);

export function ResetPage() {
  const { token } = useParams({ from: "/reset/$token" });
  const ts = useTurnstile();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const m = useMutation({ mutationFn: (b: z.output<typeof resetComplete>) => post(`/auth/client/reset/${encodeURIComponent(token)}`, b), onError: ts.reset });
  return (
    <AuthLayout title="Choose a new password">
      {m.isSuccess ? (
        <div className="space-y-4">
          <Alert tone="green">Your password was changed. Sign in with your new password.</Alert>
          <Link to="/login" className="block text-center text-sm link">
            Go to sign in
          </Link>
        </div>
      ) : (
        <form
          noValidate
          className="space-y-4"
          onSubmit={(e) => {
            const raw = formValues(e);
            const v = check(resetComplete, { ...raw, turnstileToken: ts.token }, setErrors);
            const mismatch = confirmError(raw);
            if (mismatch) return setErrors((x) => ({ ...x, ...mismatch }));
            if (v) m.mutate(v);
          }}
        >
          <Input label="New password" name="password" type="password" autoComplete="new-password" hint="At least 12 characters" error={errors.password} />
          <Input label="Confirm new password" name="confirm" type="password" autoComplete="new-password" error={errors.confirm} />
          {ts.widget}
          {errors.turnstileToken && <p className="text-xs font-medium text-neg">{errors.turnstileToken}</p>}
          <ErrorText error={m.error} />
          <Button type="submit" busy={m.isPending} className="w-full">
            Save password
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

type InviteInfo = { email: string; firstName: string; expiresAt: number };
type Enrollment = { mfaType: "totp"; secret: string; otpauthUrl: string } | { mfaType: "email"; sent: true };

export function InvitePage() {
  const { token } = useParams({ from: "/invite/$token" });
  const navigate = useNavigate();
  const ts = useTurnstile();
  const base = `/auth/client/invite/${encodeURIComponent(token)}`;
  const [mfaType, setMfaType] = useState<MfaType>("totp");
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const info = useQuery({ queryKey: ["invite", token], queryFn: () => api<InviteInfo>(base), retry: false });
  const start = useMutation({ mutationFn: () => post<Enrollment>(`${base}/start`, { mfaType, turnstileToken: ts.token }), onSuccess: setEnrollment, onError: ts.reset });
  const complete = useMutation({ mutationFn: (b: z.output<typeof inviteComplete>) => post(`${base}/complete`, b), onSuccess: () => navigate({ to: "/portal" }) });

  if (info.isPending) return <AuthLayout title="Set up your account"><Spinner /></AuthLayout>;
  if (info.isError) return <AuthLayout title="Invitation unavailable"><ErrorText error={info.error} /></AuthLayout>;

  return (
    <AuthLayout title={`Welcome, ${info.data.firstName}`}>
      <p className="mb-4 text-sm text-ink-2">
        Set up portal access for <strong>{info.data.email}</strong>. This invitation expires {fmtDate(info.data.expiresAt)}.
      </p>
      {!enrollment ? (
        <form
          noValidate
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!ts.token) return setErrors({ turnstileToken: "Complete the verification" });
            setErrors({});
            start.mutate();
          }}
        >
          <fieldset className="space-y-2">
            <legend className="mb-1 text-sm font-medium text-ink-2">How do you want to verify sign-ins?</legend>
            {MFA_TYPES.map((t) => (
              <label key={t} className="flex items-start gap-2 rounded-lg border border-line p-3 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
                <input type="radio" name="mfaType" value={t} checked={mfaType === t} onChange={() => setMfaType(t)} className="mt-0.5" />
                <span>
                  <span className="font-medium">{t === "totp" ? "Authenticator app" : "Email code"}</span>
                  <span className="block text-ink-3">{t === "totp" ? "Recommended. Use Google Authenticator, 1Password, or similar." : "We email you a code each time you sign in."}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {ts.widget}
          {errors.turnstileToken && <p className="text-xs font-medium text-neg">{errors.turnstileToken}</p>}
          <ErrorText error={start.error} />
          <Button type="submit" busy={start.isPending} className="w-full">
            Continue
          </Button>
        </form>
      ) : (
        <form
          noValidate
          className="space-y-4"
          onSubmit={(e) => {
            const raw = formValues(e);
            const v = check(inviteComplete, raw, setErrors);
            const mismatch = confirmError(raw);
            if (mismatch) return setErrors((x) => ({ ...x, ...mismatch }));
            if (v) complete.mutate(v);
          }}
        >
          {enrollment.mfaType === "totp" ? (
            <div className="space-y-2 text-sm">
              <p>Add this key to your authenticator app, then enter the 6-digit code it shows.</p>
              <CopyBlock value={enrollment.secret} label="Authenticator setup key" />
              <a href={enrollment.otpauthUrl} className="inline-block link">
                Open in authenticator app
              </a>
            </div>
          ) : (
            <Alert tone="blue">We emailed a 6-digit code to {info.data.email}.</Alert>
          )}
          <Input label="Verification code" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} error={errors.code} />
          <Input label="Password" name="password" type="password" autoComplete="new-password" hint="At least 12 characters" error={errors.password} />
          <Input label="Confirm password" name="confirm" type="password" autoComplete="new-password" error={errors.confirm} />
          <ErrorText error={complete.error} />
          <Button type="submit" busy={complete.isPending} className="w-full">
            Create account
          </Button>
          <Button variant="ghost" className="w-full" onClick={() => { setEnrollment(null); ts.reset(); }}>
            Use a different method
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
