/** Client portal. Every endpoint is scoped server-side to the signed-in client. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet } from "@tanstack/react-router";
import { BUREAUS, type DocumentDto, type PortalLetter, type ReportDto, type ReportItemDto } from "@da/shared";
import { useState } from "react";
import { DocumentsTable, UploadForm } from "../components/Documents";
import { NotificationList, NotificationsBell } from "../components/Notifications";
import { Icon, Wordmark } from "../components/icons";
import { ThemeSwitcher } from "../components/ThemeSwitcher";
import { Alert, Avatar, Button, Card, Checkbox, Chip, CopyBlock, Empty, ErrorText, Input, PageHeader, Q, Spinner, StatusChip } from "../components/ui";
import { api, patch, portalDownload, post } from "../lib/api";
import { fmtDate, fmtMoney, groupBy, humanize, portalLetterLabel, toneOf } from "../lib/format";
import { usePortalMe } from "../lib/session";

const NAV = [
  { to: "/portal", label: "Home" },
  { to: "/portal/documents", label: "Documents" },
  { to: "/portal/reports", label: "Credit report" },
  { to: "/portal/letters", label: "Letters" },
  { to: "/portal/settings", label: "Settings" },
] as const;

const logout = () => post("/auth/client/logout").finally(() => location.assign("/login"));

export function PortalShell() {
  const me = usePortalMe();
  if (me.isPending) return <Spinner label="Loading your portal" />;
  if (me.isError) return <div className="mx-auto max-w-lg p-6 pt-24"><ErrorText error={me.error} /></div>;
  return (
    <div className="min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:rounded-lg focus:bg-surface focus:p-2">
        Skip to content
      </a>
      <header className="sticky top-0 z-30 border-b border-line bg-canvas/75 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-3 px-4 sm:px-6">
          <Link to="/portal" aria-label="Portal home">
            <Wordmark size={26} />
          </Link>
          <nav aria-label="Portal" className="hidden md:block">
            <PortalNav />
          </nav>
          <div className="flex items-center gap-1">
            <ThemeSwitcher compact className="mr-1 hidden sm:inline-flex" />
            <NotificationsBell base="/portal" />
            <span className="mx-1 hidden sm:block">
              <Avatar name={me.data.firstName} size={28} />
            </span>
            <button type="button" onClick={logout} className="grid size-9 place-items-center rounded-full text-ink-2 transition-colors hover:bg-fill" aria-label="Sign out" title="Sign out">
              <Icon name="logout" />
            </button>
          </div>
        </div>
        <nav aria-label="Portal sections" className="overflow-x-auto px-3 pb-2.5 [scrollbar-width:none] md:hidden">
          <PortalNav />
        </nav>
      </header>
      <main id="main" className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:py-12">
        <Outlet />
      </main>
    </div>
  );
}

function PortalNav() {
  return (
    <ul className="flex gap-1">
      {NAV.map((n) => (
        <li key={n.to}>
          <Link
            to={n.to}
            activeOptions={{ exact: true }}
            className="block h-8 whitespace-nowrap rounded-full px-3.5 text-[14px] leading-8 text-ink-2 transition-colors hover:bg-fill hover:text-ink"
            activeProps={{ className: "bg-ink! text-canvas! font-medium", "aria-current": "page" }}
          >
            {n.label}
          </Link>
        </li>
      ))}
    </ul>
  );
}

const useReports = () => useQuery({ queryKey: ["portal", "reports"], queryFn: () => api<ReportDto[]>("/portal/reports") });
const useLetters = () => useQuery({ queryKey: ["portal", "letters"], queryFn: () => api<PortalLetter[]>("/portal/letters") });
const latestComplete = (rs: ReportDto[]) => [...rs].sort((a, b) => b.requestedAt - a.requestedAt).find((r) => r.status === "complete");

export function PortalHome() {
  const me = usePortalMe();
  const reports = useReports();
  const letters = useLetters();
  const latest = reports.data && latestComplete(reports.data);
  const inFlight = letters.data?.filter((l) => !["closed", "response_received"].includes(l.status)).length ?? 0;
  return (
    <>
      <PageHeader title={`Hi, ${me.data?.firstName ?? ""}`} subtitle="Here is where your case stands." />
      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Card title="Credit report">
          {latest ? (
            <p className="text-sm">
              Pulled {fmtDate(latest.completedAt)}. <strong>{latest.flaggedCount}</strong> of {latest.itemCount} items are under review.
            </p>
          ) : (
            <p className="text-sm text-ink-2">Your specialist has not pulled a report yet.</p>
          )}
        </Card>
        <Card title="Letters">
          <p className="text-sm">{letters.data ? `${inFlight} in progress, ${letters.data.length - inFlight} completed.` : "…"}</p>
        </Card>
        <Card title="Documents">
          <Link to="/portal/documents" className="text-sm link">
            Upload ID or proof of address
          </Link>
        </Card>
      </div>
      <Card title="Updates">
        <NotificationList base="/portal" limit={10} />
      </Card>
    </>
  );
}

export function PortalDocuments() {
  const qc = useQueryClient();
  const docs = useQuery({
    queryKey: ["portal", "documents"],
    queryFn: () => api<DocumentDto[]>("/portal/documents"),
    refetchInterval: (q) => (q.state.data?.some((d) => d.status === "scan_pending") ? 5000 : false),
  });
  return (
    <>
      <PageHeader title="Documents" subtitle="Upload documents your specialist asked for. Files are scanned before anyone can open them." />
      <Card className="mb-4">
        <UploadForm path="/portal/documents" onDone={() => qc.invalidateQueries({ queryKey: ["portal", "documents"] })} />
      </Card>
      <Q q={docs}>{(d) => <DocumentsTable docs={d} downloadUrl={portalDownload} />}</Q>
    </>
  );
}

export function PortalReports() {
  const reports = useReports();
  const latest = reports.data && latestComplete(reports.data);
  const items = useQuery({ queryKey: ["portal", "items", latest?.id], queryFn: () => api<ReportItemDto[]>(`/portal/reports/${latest?.id}/items`), enabled: !!latest });
  if (reports.isPending) return <Spinner />;
  if (reports.isError) return <ErrorText error={reports.error} />;
  return (
    <>
      <PageHeader title="Your credit report" subtitle={latest ? `Pulled ${fmtDate(latest.completedAt)}. Account numbers are masked.` : undefined} />
      {!latest ? (
        <Empty>No completed report yet.</Empty>
      ) : (
        <Q q={items}>
          {(list) => {
            const byBureau = groupBy(list, (i) => i.bureau);
            return (
              <div className="space-y-6">
                {BUREAUS.filter((b) => byBureau.has(b)).map((b) => (
                  <section key={b}>
                    <h2 className="mb-2 text-lg font-semibold">{humanize(b)}</h2>
                    <ul className="space-y-2">
                      {byBureau.get(b)?.map((i) => (
                        <li key={i.id} className="rounded-2xl bg-surface p-4 text-[14px] shadow-card">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="font-medium">{i.furnisher ?? humanize(i.itemType)}</span>
                            {i.outcome ? <StatusChip status={i.outcome} /> : i.flags.length > 0 && <Chip tone="amber">Under review</Chip>}
                          </div>
                          <p className="text-ink-2">
                            {humanize(i.itemType)}
                            {i.accountMask && ` · ${i.accountMask}`}
                            {i.balance != null && ` · Balance ${fmtMoney(i.balance)}`}
                            {i.status && ` · ${i.status}`}
                          </p>
                          {i.flags.length > 0 && (
                            <div className="mt-2 rounded-lg bg-warn-soft p-2 text-warn">
                              <p className="text-xs font-semibold">Why we are reviewing this</p>
                              <ul className="list-disc pl-5">
                                {i.flags.map((f) => (
                                  <li key={f.id}>{f.reason}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            );
          }}
        </Q>
      )}
    </>
  );
}

export function PortalLetters() {
  const letters = useLetters();
  return (
    <>
      <PageHeader title="Dispute letters" subtitle="Letters we send on your behalf. Bureaus usually respond within 30 days of mailing." />
      <Q q={letters}>
        {(ls) =>
          ls.length === 0 ? (
            <Empty>No letters yet.</Empty>
          ) : (
            <ul className="space-y-2">
              {ls.map((l) => (
                <li key={l.id} className="rounded-2xl bg-surface p-4 text-[14px] shadow-card">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{l.targetName}</span>
                    <Chip tone={toneOf(l.status)}>{portalLetterLabel(l.status)}</Chip>
                  </div>
                  <p className="text-ink-2">
                    {l.sentAt ? `Mailed ${fmtDate(l.sentAt)}` : "Not mailed yet"}
                    {l.responseDueAt && ` · Response due ${fmtDate(l.responseDueAt)}`}
                  </p>
                </li>
              ))}
            </ul>
          )
        }
      </Q>
    </>
  );
}

export function PortalSettings() {
  const qc = useQueryClient();
  const me = usePortalMe();
  const sms = useMutation({ mutationFn: (smsOptIn: boolean) => patch("/portal/preferences", { smsOptIn }), onSuccess: () => qc.invalidateQueries({ queryKey: ["portal", "me"] }) });
  const [enroll, setEnroll] = useState<{ secret: string; otpauthUrl: string; enrollmentToken: string } | null>(null);
  const [code, setCode] = useState("");
  const start = useMutation({ mutationFn: () => post<NonNullable<typeof enroll>>("/portal/mfa/totp/start"), onSuccess: setEnroll });
  const confirm = useMutation({
    mutationFn: () => post("/portal/mfa/totp/confirm", { enrollmentToken: enroll?.enrollmentToken, code }),
    onSuccess: () => {
      setEnroll(null);
      setCode("");
      qc.invalidateQueries({ queryKey: ["portal", "me"] });
    },
  });
  if (!me.data) return <Spinner />;
  return (
    <>
      <PageHeader title="Settings" />
      <div className="space-y-4">
        <Card title="Appearance">
          <p className="mb-3 text-[14px] text-ink-2">Choose light or dark, or let it follow your device.</p>
          <ThemeSwitcher />
        </Card>
        <Card title="Text messages">
          <Checkbox label="Send me text message updates (standard rates apply)" checked={me.data.smsOptIn} disabled={sms.isPending} onChange={(e) => sms.mutate(e.target.checked)} />
          <div aria-live="polite" className="mt-2">
            <ErrorText error={sms.error} />
          </div>
        </Card>
        <Card title="Sign-in verification">
          <p className="mb-3 text-sm text-ink-2">Current method: {me.data.mfaType === "totp" ? "Authenticator app" : "Email code"}</p>
          <div aria-live="polite">{confirm.isSuccess && <Alert tone="green">Your authenticator app is set up.</Alert>}</div>
          {!enroll ? (
            <Button variant="secondary" busy={start.isPending} onClick={() => start.mutate()}>
              {me.data.mfaType === "totp" ? "Set up a new authenticator" : "Switch to an authenticator app"}
            </Button>
          ) : (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                confirm.mutate();
              }}
            >
              <p className="text-sm">Add this key to your authenticator app, then enter the code it shows.</p>
              <CopyBlock value={enroll.secret} label="Authenticator setup key" />
              <a href={enroll.otpauthUrl} className="inline-block text-sm link">
                Open in authenticator app
              </a>
              <Input label="6-digit code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
              <ErrorText error={confirm.error} />
              <div className="flex gap-2">
                <Button type="submit" busy={confirm.isPending} disabled={code.length !== 6}>
                  Confirm
                </Button>
                <Button variant="secondary" onClick={() => setEnroll(null)}>
                  Cancel
                </Button>
              </div>
            </form>
          )}
          <ErrorText error={start.error} />
        </Card>
      </div>
    </>
  );
}
