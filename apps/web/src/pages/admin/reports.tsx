/** Client detail > Reports: import, status stepper, items by bureau, cross-bureau compare, flags, history. */
import { Icon } from "../../components/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BUREAUS, REPORT_ACTIVE, type ReportDto, type ReportItemDto } from "@da/shared";
import { useClientReports, useReportItems } from "./queries";
import { useState } from "react";
import { Alert, Button, Card, Chip, Dialog, Empty, ErrorText, Q, ReasonDialog, Select, StatusChip, Table, Tabs } from "../../components/ui";
import { api, del, post } from "../../lib/api";
import { REPORT_STEPS, compareKey, fmtDate, fmtDateTime, fmtMoney, groupBy, humanize, reportStepIndex } from "../../lib/format";
import { useCan } from "../../lib/session";

function Stepper({ report }: { report: ReportDto }) {
  const current = reportStepIndex(report.status);
  return (
    <div>
      <ol className="flex flex-wrap items-center gap-2 text-xs" aria-label="Import progress">
        {REPORT_STEPS.map((s, i) => {
          const done = current > i || report.status === "complete";
          const active = current === i && report.status !== "complete";
          return (
            <li key={s} className="flex items-center gap-2" aria-current={active ? "step" : undefined}>
              <span className={`flex size-6 items-center justify-center rounded-full font-semibold ${done ? "bg-pos text-white" : active ? "bg-accent text-white" : "bg-fill-strong text-ink-2"}`}>{done ? "✓" : i + 1}</span>
              <span className={active ? "font-semibold text-accent-ink" : "text-ink-2"}>{humanize(s)}</span>
              {i < REPORT_STEPS.length - 1 && <span aria-hidden className="h-px w-6 bg-line-strong" />}
            </li>
          );
        })}
      </ol>
      <p className="sr-only" aria-live="polite">
        Report status: {humanize(report.status)}
      </p>
      {report.status === "failed" && <div className="mt-3"><Alert title="Import failed">{report.error ?? "The provider returned an error."}</Alert></div>}
    </div>
  );
}

export function ReportsTab({ clientId }: { clientId: string }) {
  const can = useCan();
  const qc = useQueryClient();
  const reports = useClientReports(clientId);
  const [selected, setSelected] = useState<string>();
  const report = reports.data?.find((r) => r.id === selected) ?? reports.data?.[0];
  const importM = useMutation({
    mutationFn: () => post<{ reportId: string }>(`/clients/${clientId}/reports/import`),
    onSuccess: (r) => {
      setSelected(r.reportId);
      qc.invalidateQueries({ queryKey: ["reports", clientId] });
    },
  });
  return (
    <div className="space-y-4">
      <Card
        title="Credit reports"
        actions={
          can("report:import") && (
            <Button busy={importM.isPending} disabled={reports.data?.some((r) => REPORT_ACTIVE.includes(r.status))} onClick={() => importM.mutate()}>
              Import report
            </Button>
          )
        }
      >
        <ErrorText error={importM.error} />
        <Q q={reports}>
          {(rs) =>
            !report ? (
              <Empty>No reports yet.</Empty>
            ) : (
              <div className="space-y-4">
                {rs.length > 1 && (
                  <div className="max-w-sm">
                    <Select label="Report" value={report.id} onChange={(e) => setSelected(e.target.value)} options={rs.map((r) => ({ value: r.id, label: `${fmtDateTime(r.requestedAt)} · ${humanize(r.status)}` }))} />
                  </div>
                )}
                <p className="text-sm text-ink-2">
                  Requested {fmtDateTime(report.requestedAt)} · {report.provider === "fake" ? "sample data" : humanize(report.provider)}
                  {report.status === "complete" && ` · ${report.itemCount} items, ${report.flaggedCount} flagged`}
                </p>
                <Stepper report={report} />
              </div>
            )
          }
        </Q>
      </Card>
      {report?.status === "complete" && <ReportItems reportId={report.id} clientId={clientId} />}
    </div>
  );
}

type FlagAction = { kind: "add"; item: ReportItemDto } | { kind: "remove"; item: ReportItemDto; flagId: string };

function ReportItems({ reportId, clientId }: { reportId: string; clientId: string }) {
  const can = useCan();
  const qc = useQueryClient();
  const items = useReportItems(reportId);
  const [view, setView] = useState<"bureau" | "compare">("bureau");
  const [action, setAction] = useState<FlagAction | null>(null);
  const [history, setHistory] = useState<ReportItemDto | null>(null);
  const flagM = useMutation({
    mutationFn: ({ a, reason }: { a: FlagAction; reason: string }) => (a.kind === "add" ? post(`/report-items/${a.item.id}/flags`, { reason }) : del(`/report-items/${a.item.id}/flags/${a.flagId}`, { reason })),
    onSuccess: () => {
      setAction(null);
      qc.invalidateQueries({ queryKey: ["items", reportId] });
      qc.invalidateQueries({ queryKey: ["reports", clientId] });
    },
  });
  const flagWrite = can("flag:write");

  const flagChips = (i: ReportItemDto) =>
    i.flags.map((f) => (
      <Chip key={f.id} wrap tone={f.source === "manual" ? "indigo" : "amber"} className="mr-1 mb-1 max-w-full">
        <span title={f.source === "manual" ? "Manual flag" : "Rule flag"}>{f.reason}</span>
        {flagWrite && (
          <button type="button" className="-mr-1 ml-0.5 grid size-4 shrink-0 place-items-center rounded-full transition-colors hover:bg-(--hover-on-tint)" aria-label={`Remove flag: ${f.reason}`} onClick={() => setAction({ kind: "remove", item: i, flagId: f.id })}>
            <Icon name="x" className="size-2.5" />
          </button>
        )}
      </Chip>
    ));

  return (
    <Card title="Report items">
      <Tabs label="Item view" tabs={[{ id: "bureau", label: "By bureau" }, { id: "compare", label: "Compare bureaus" }]} value={view} onChange={setView} />
      <div role="tabpanel" id={`panel-${view}`} aria-labelledby={`tab-${view}`}>
        <Q q={items}>
          {(list) => {
            if (!list.length) return <Empty>This report has no items.</Empty>;
            if (view === "compare") return <CompareTable items={list} />;
            const byBureau = groupBy(list, (i) => i.bureau);
            return (
              <div className="space-y-6">
                {BUREAUS.filter((b) => byBureau.has(b)).map((b) => (
                  <section key={b}>
                    <h3 className="mb-1 flex items-baseline gap-2 text-[15px] font-semibold">
                      {humanize(b)} <span className="text-[13px] font-normal text-ink-3">{byBureau.get(b)?.length} items</span>
                    </h3>
                    <Table caption={`${humanize(b)} items`}>
                      <thead>
                        <tr>
                          <th>Furnisher</th>
                          <th>Account</th>
                          <th>Balance</th>
                          <th>Status</th>
                          <th>Opened</th>
                          <th>Flags</th>
                          <th>
                            <span className="sr-only">Actions</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {byBureau.get(b)?.map((i) => (
                          <tr key={i.id}>
                            <td className="min-w-[11rem]">
                              <div className="flex items-start gap-2">
                                <span aria-hidden className={`mt-[7px] size-1.5 shrink-0 rounded-full ${i.flags.length ? "bg-warn" : "bg-transparent"}`} />
                                <div>
                                  <div className="font-medium text-ink">{i.furnisher ?? "—"}</div>
                                  <div className="text-[13px] text-ink-3">
                                    {humanize(i.itemType)}
                                    {i.flags.length > 0 && <span className="sr-only">, flagged</span>}
                                  </div>
                                </div>
                              </div>
                            </td>
                            <td className="font-mono text-[13px] text-ink-2">{i.accountMask ?? "—"}</td>
                            <td className="tabular-nums">{fmtMoney(i.balance)}</td>
                            <td>
                              {i.status ?? "—"}
                              {i.outcome && <div><StatusChip status={i.outcome} /></div>}
                            </td>
                            <td className="whitespace-nowrap">{i.openedAt ?? "—"}</td>
                            <td className="min-w-[15rem] max-w-sm">{i.flags.length ? flagChips(i) : <span className="text-ink-3">—</span>}</td>
                            <td className="whitespace-nowrap text-right">
                              <span className="inline-flex gap-1">
                                {flagWrite && (
                                  <button type="button" onClick={() => setAction({ kind: "add", item: i })} className="grid size-8 place-items-center rounded-full text-ink-3 transition-colors hover:bg-fill hover:text-accent-ink" aria-label={`Add flag to ${i.furnisher ?? "item"}`} title="Add flag">
                                    <Icon name="flag" className="size-4" />
                                  </button>
                                )}
                                <button type="button" onClick={() => setHistory(i)} className="grid size-8 place-items-center rounded-full text-ink-3 transition-colors hover:bg-fill hover:text-accent-ink" aria-label={`History for ${i.furnisher ?? "item"}`} title="History across imports">
                                  <Icon name="clock" className="size-4" />
                                </button>
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                  </section>
                ))}
              </div>
            );
          }}
        </Q>
      </div>
      <ReasonDialog
        open={!!action}
        title={action?.kind === "remove" ? "Remove flag" : `Flag ${action?.item.furnisher ?? "item"}`}
        label={action?.kind === "remove" ? "Why remove this flag?" : "Reason (shown on the dispute letter)"}
        submitLabel={action?.kind === "remove" ? "Remove flag" : "Add flag"}
        danger={action?.kind === "remove"}
        busy={flagM.isPending}
        error={flagM.error}
        onClose={() => {
          setAction(null);
          flagM.reset();
        }}
        onSubmit={(reason) => action && flagM.mutate({ a: action, reason })}
      />
      <HistoryDialog item={history} onClose={() => setHistory(null)} />
    </Card>
  );
}

/** Same account side by side across bureaus; cells that disagree are highlighted. */
function CompareTable({ items }: { items: ReportItemDto[] }) {
  const groups = [...groupBy(items, compareKey).values()].sort((a, b) => b.length - a.length || (a[0].furnisher ?? "").localeCompare(b[0].furnisher ?? ""));
  const cell = (g: ReportItemDto[], b: string) => g.find((i) => i.bureau === b);
  const differs = (g: ReportItemDto[], f: (i: ReportItemDto) => unknown) => new Set(g.map(f)).size > 1;
  return (
    <Table caption="Cross-bureau comparison">
      <thead>
        <tr>
          <th>Account</th>
          {BUREAUS.map((b) => (
            <th key={b}>{humanize(b)}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {groups.map((g) => {
          const balDiff = differs(g, (i) => i.balance);
          const statusDiff = differs(g, (i) => i.status);
          return (
            <tr key={compareKey(g[0])}>
              <td>
                <span className="font-medium">{g[0].furnisher ?? humanize(g[0].itemType)}</span>
                <span className="block font-mono text-xs text-ink-3">{g[0].accountMask ?? "—"}</span>
                {g.length < BUREAUS.length && <Chip tone="amber">Missing on {BUREAUS.length - g.length}</Chip>}
              </td>
              {BUREAUS.map((b) => {
                const i = cell(g, b);
                if (!i) return <td key={b} className="text-ink-3">Not reported</td>;
                return (
                  <td key={b} className="text-xs">
                    <span className={balDiff ? "rounded-md bg-warn-soft px-1.5 text-warn" : undefined}>{fmtMoney(i.balance)}</span>
                    <span className={`block w-fit ${statusDiff ? "rounded-md bg-warn-soft px-1.5 text-warn" : ""}`}>{i.status ?? "—"}</span>
                    {i.flags.length > 0 && <Chip tone="amber">{i.flags.length} flag{i.flags.length > 1 ? "s" : ""}</Chip>}
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

function HistoryDialog({ item, onClose }: { item: ReportItemDto | null; onClose: () => void }) {
  const q = useQuery({ queryKey: ["item-history", item?.id], queryFn: () => api<ReportItemDto[]>(`/report-items/${item?.id}/history`), enabled: !!item });
  return (
    <Dialog open={!!item} onClose={onClose} title={`History: ${item?.furnisher ?? ""} ${item?.accountMask ?? ""}`} wide>
      <Q q={q}>
        {(rows) => (
          <Table caption="Item history across imports">
            <thead>
              <tr>
                <th>Reported</th>
                <th>Bureau</th>
                <th>Balance</th>
                <th>Status</th>
                <th>Flags</th>
                <th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={r.id === item?.id ? "bg-accent-soft" : undefined}>
                  <td>{r.reportedAt ? fmtDate(Date.parse(r.reportedAt)) : "—"}</td>
                  <td>{humanize(r.bureau)}</td>
                  <td>{fmtMoney(r.balance)}</td>
                  <td>{r.status ?? "—"}</td>
                  <td>{r.flags.map((f) => f.reason).join("; ") || "—"}</td>
                  <td>{r.outcome ? <StatusChip status={r.outcome} /> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Q>
    </Dialog>
  );
}
