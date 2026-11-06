/** Letters queue, letter detail (editor, approvals, mailing, responses), and the new-round dialog. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { LETTER_STATUS, type LetterDetail, OUTCOMES, type Outcome, type ReportItemDto, type TemplateDto, disputeRoundCreate, letterResponse, letterSent } from "@da/shared";
import { Suspense, lazy, useEffect, useState } from "react";
import { Alert, Button, Card, Checkbox, Dialog, Empty, ErrorText, Input, PageHeader, Q, ReasonDialog, Select, Spinner, StatusChip, Table, Textarea } from "../../components/ui";
import { ApiError, api, patch, post, staffDownload } from "../../lib/api";
import { LETTER_PATH, fmtDate, fmtDateTime, humanize, issuesToMap, letterActions, letterPathIndex, renderLetterHtml, todayIso } from "../../lib/format";
import { useClientLock, useStaffMe } from "../../lib/session";
import { useClientDocuments } from "./queries";
import { LetterTable, useLetters } from "./shell";

const Editor = lazy(() => import("../../components/Editor"));

// ---------- queue ----------
const QUICK = ["pending_approval", "ready_to_mail", "render_failed", "overdue"] as const;

export function LettersQueuePage() {
  const { status } = useSearch({ from: "/admin/letters" });
  const navigate = useNavigate({ from: "/admin/letters" });
  const letters = useLetters(status);
  const setStatus = (s?: string) => navigate({ search: { status: s || undefined } });
  return (
    <>
      <PageHeader title="Letters" />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="w-56">
          <Select label="Status" value={status ?? ""} onChange={(e) => setStatus(e.target.value)} options={LETTER_STATUS} placeholder="All statuses" />
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Quick filters">
          {QUICK.map((s) => (
            <Button key={s} small variant={status === s ? "primary" : "secondary"} aria-pressed={status === s} onClick={() => setStatus(status === s ? undefined : s)}>
              {humanize(s)}
            </Button>
          ))}
        </div>
      </div>
      <Q q={letters}>{(ls) => <LetterTable letters={ls} />}</Q>
    </>
  );
}

// ---------- new round ----------
export function NewRoundDialog({ open, onClose, clientId, items, title = "New dispute round" }: { open: boolean; onClose: () => void; clientId: string; items: ReportItemDto[]; title?: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const templates = useQuery({ queryKey: ["templates"], queryFn: () => api<TemplateDto[]>("/templates"), enabled: open });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [targetKind, setTargetKind] = useState<"bureau" | "furnisher">("bureau");
  const [templateId, setTemplateId] = useState("");
  const activeTemplates = (templates.data ?? []).filter((t) => t.active);
  // One active template (the usual case) is preselected.
  const chosenTemplate = templateId || (activeTemplates.length === 1 ? activeTemplates[0].id : "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const idsKey = items.map((i) => i.id).join();
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset selection when the dialog opens or the item set changes
  useEffect(() => {
    if (open) setSelected(new Set(items.map((i) => i.id)));
  }, [open, idsKey]);
  const create = useMutation({
    mutationFn: (b: unknown) => post<{ roundId: string; number: number; letterIds: string[] }>(`/clients/${clientId}/dispute-rounds`, b),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["letters"] });
      onClose();
      if (r.letterIds[0]) navigate({ to: "/admin/letters/$letterId", params: { letterId: r.letterIds[0] } });
    },
  });
  const chosen = items.filter((i) => selected.has(i.id));
  const letterCount = new Set(chosen.map((i) => (targetKind === "bureau" ? i.bureau : (i.furnisher ?? "Unknown furnisher")))).size;
  const toggle = (id: string) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  return (
    <Dialog open={open} onClose={onClose} title={title} wide>
      <form
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          const r = disputeRoundCreate.safeParse({ itemIds: [...selected], targetKind, templateId: chosenTemplate });
          setErrors(r.success ? {} : issuesToMap(r.error.issues));
          if (r.success) create.mutate(r.data);
        }}
      >
        <fieldset>
          <legend className="mb-1 text-[13px] font-medium text-ink-2">
            Items to dispute <span className="text-ink-3">· {selected.size} of {items.length} selected</span>
          </legend>
          <div className="mb-2 -ml-3 flex gap-1">
            <Button small variant="ghost" onClick={() => setSelected(new Set(items.map((i) => i.id)))}>Select all</Button>
            <Button small variant="ghost" onClick={() => setSelected(new Set())}>Select none</Button>
          </div>
          {items.length === 0 ? (
            <Empty>No open flagged items. Flag items on the Reports tab first.</Empty>
          ) : (
            <ul className="max-h-80 divide-y divide-line overflow-y-auto rounded-xl ring-1 ring-line">
              {items.map((i) => (
                <li key={i.id}>
                  <Checkbox
                    className="flex! w-full items-start! gap-3! px-3.5 py-3 transition-colors hover:bg-fill [&>input]:mt-0.5"
                    checked={selected.has(i.id)}
                    onChange={() => toggle(i.id)}
                    label={
                      <span className="min-w-0">
                        <span className="text-ink">
                          <span className="font-medium">{i.furnisher ?? humanize(i.itemType)}</span>
                          <span className="text-ink-3"> · {humanize(i.bureau)}</span>
                          {i.accountMask && <span className="ml-1.5 font-mono text-[12px] text-ink-3">{i.accountMask}</span>}
                        </span>
                        <span className="mt-0.5 block text-[13px] text-ink-3">{i.flags.map((f) => f.reason).join("; ")}</span>
                      </span>
                    }
                  />
                </li>
              ))}
            </ul>
          )}
          {errors.itemIds && <p className="mt-1 text-xs font-medium text-neg">Select at least one item</p>}
        </fieldset>
        <fieldset>
          <legend className="mb-1.5 text-[13px] font-medium text-ink-2">Send letters to</legend>
          <div className="inline-flex gap-0.5 rounded-[11px] bg-fill p-[3px]">
            {(["bureau", "furnisher"] as const).map((k) => (
              <label key={k} className="cursor-pointer rounded-[8px] px-3.5 py-1.5 text-[13px] font-medium text-ink-2 transition-all has-[:checked]:bg-surface has-[:checked]:text-ink has-[:checked]:shadow-[0_1px_3px_rgba(0,0,0,.1),0_0_0_.5px_var(--line)] has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-[var(--accent-ring)]">
                <input type="radio" name="targetKind" checked={targetKind === k} onChange={() => setTargetKind(k)} className="sr-only" />
                {k === "bureau" ? "Credit bureaus" : "Furnishers"}
              </label>
            ))}
          </div>
        </fieldset>
        <Select
          label="Template"
          value={chosenTemplate}
          onChange={(e) => setTemplateId(e.target.value)}
          placeholder={templates.isPending ? "Loading…" : "Choose a template"}
          error={errors.templateId && "Choose a template"}
          options={activeTemplates.map((t) => ({ value: t.id, label: `${t.name} (v${t.version})` }))}
        />
        <p className="text-sm text-ink-2" aria-live="polite">
          This creates {letterCount} draft letter{letterCount === 1 ? "" : "s"}.
        </p>
        <ErrorText error={create.error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" busy={create.isPending} disabled={!selected.size}>Create drafts</Button>
        </div>
      </form>
    </Dialog>
  );
}

// ---------- detail ----------
type FollowUp = { allClosed: boolean; clientId: string; unresolvedItemIds: string[]; items: ReportItemDto[] };
const POLL: readonly string[] = ["approved", "rendering"];

export function LetterDetailPage() {
  const { letterId } = useParams({ from: "/admin/letters/$letterId" });
  const q = useQuery({
    queryKey: ["letter", letterId],
    queryFn: () => api<LetterDetail>(`/letters/${letterId}`),
    refetchInterval: (s) => (s.state.data && POLL.includes(s.state.data.status) ? 4000 : false),
  });
  return <Q q={q}>{(l) => <LetterView l={l} />}</Q>;
}

function LetterView({ l }: { l: LetterDetail }) {
  const me = useStaffMe();
  const qc = useQueryClient();
  const actions = letterActions(l.status, me.data?.permissions ?? []);
  const editing = actions.includes("edit");
  const [html, setHtml] = useState(l.bodyHtml);
  const [saved, setSaved] = useState(l.bodyHtml);
  const dirty = editing && html !== saved;
  const [dialog, setDialog] = useState<"reject" | "sent" | "response" | null>(null);
  const [followUp, setFollowUp] = useState<ReportItemDto[] | null>(null);
  const [notice, setNotice] = useState<string>();

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["letter", l.id] });
    qc.invalidateQueries({ queryKey: ["letters"] });
  };
  const save = useMutation({
    mutationFn: () => patch<LetterDetail>(`/letters/${l.id}`, { bodyHtml: html }),
    onSuccess: (d) => {
      setSaved(html);
      qc.setQueryData(["letter", l.id], d);
    },
  });
  const act = useMutation({
    mutationFn: async ({ path, body }: { path: string; body?: unknown }) => {
      if (path === "submit" && dirty) {
        await patch(`/letters/${l.id}`, { bodyHtml: html });
        setSaved(html);
      }
      return post(`/letters/${l.id}/${path}`, body);
    },
    onSuccess: () => {
      setDialog(null);
      refresh();
    },
  });
  const fu = useMutation({
    mutationFn: async () => {
      const r = await api<FollowUp>(`/dispute-rounds/${l.disputeRoundId}/follow-up`);
      if (!r.allClosed) return "Close every letter in this round before starting a follow-up.";
      if (!r.unresolvedItemIds.length) return "Every item in this round was deleted or updated. No follow-up is needed.";
      return r.items;
    },
    onSuccess: (r) => (typeof r === "string" ? setNotice(r) : setFollowUp(r)),
  });
  const busy = (p: string) => act.isPending && act.variables?.path === p;
  const openDialog = (d: typeof dialog) => {
    act.reset();
    setDialog(d);
  };

  return (
    <>
      <PageHeader
        title={`Letter to ${l.targetName}`}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <StatusChip status={l.status} />
            <Link to="/admin/clients/$clientId" params={{ clientId: l.clientId }} search={{ tab: "letters" }} className="font-medium text-accent-ink hover:underline">
              {l.clientName}
            </Link>
            <span aria-hidden className="text-ink-3">·</span>
            <span>Round {l.roundNumber}</span>
            <span aria-hidden className="text-ink-3">·</span>
            <span>Template v{l.templateVersion}</span>
          </span>
        }
      />
      {l.status === "draft" && l.rejectionReason && (
        <div className="mb-4">
          <Alert tone="amber" title="Returned by the approver">{l.rejectionReason}</Alert>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <div className="min-w-0 space-y-4">
          <Card title="Letter">
            {editing ? (
              <DraftEditor clientId={l.clientId} initial={l.bodyHtml} onChange={setHtml} dirty={dirty} onSave={() => save.mutate()} saving={save.isPending} saveError={save.error} />
            ) : (
              <div className="overflow-hidden rounded-2xl ring-1 ring-line">
                <div className="paper-desk">
                  {/* biome-ignore lint/security/noDangerouslySetInnerHtml: bodies are sanitized server-side on every write (lib/sanitize) and the CSP forbids inline script */}
                  <div className="paper letter-body" dangerouslySetInnerHTML={{ __html: renderLetterHtml(l.bodyHtml) }} />
                </div>
              </div>
            )}
          </Card>
          <Card title={`Disputed items (${l.items.length})`}>
            <Table caption="Disputed items">
              <thead>
                <tr>
                  <th>Bureau</th>
                  <th>Furnisher</th>
                  <th>Account</th>
                  <th>Reason</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {l.items.map((i) => (
                  <tr key={i.id}>
                    <td>{humanize(i.bureau)}</td>
                    <td>{i.furnisher ?? humanize(i.itemType)}</td>
                    <td className="font-mono text-xs">{i.accountMask ?? "—"}</td>
                    <td>{i.disputeReason ?? (i.flags.map((f) => f.reason).join("; ") || "—")}</td>
                    <td>{i.outcome ? <StatusChip status={i.outcome} /> : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="Actions">
            <div className="flex flex-col gap-2">
              {actions.includes("submit") && <Button busy={busy("submit")} onClick={() => act.mutate({ path: "submit" })}>{dirty ? "Save and submit for approval" : "Submit for approval"}</Button>}
              {actions.includes("approve") && l.clientAuthStatus !== "signed" && (
                <p role="status" className="rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">The client's authorization is not signed yet, so this letter cannot be approved.</p>
              )}
              {actions.includes("approve") && <Button busy={busy("approve")} disabled={l.clientAuthStatus !== "signed"} onClick={() => act.mutate({ path: "approve" })}>Approve</Button>}
              {actions.includes("reject") && <Button variant="danger" onClick={() => openDialog("reject")}>Reject…</Button>}
              {actions.includes("retry") && <Button busy={busy("retry-render")} onClick={() => act.mutate({ path: "retry-render" })}>Retry render</Button>}
              {l.pdfDocumentId && (
                <a href={staffDownload(l.pdfDocumentId)} download className="rounded-lg border border-line-strong bg-surface px-3.5 py-2 text-center text-sm font-medium text-ink hover:bg-fill">
                  Download PDF
                </a>
              )}
              {actions.includes("markSent") && <Button onClick={() => openDialog("sent")}>Mark sent…</Button>}
              {actions.includes("logResponse") && <Button onClick={() => openDialog("response")}>Log response…</Button>}
              {actions.includes("close") && <Button variant="secondary" busy={busy("close")} onClick={() => act.mutate({ path: "close" })}>Close letter</Button>}
              {actions.includes("followUp") && <Button variant="secondary" busy={fu.isPending} onClick={() => fu.mutate()}>Start follow-up round</Button>}
              {!actions.length && !l.pdfDocumentId && <p className="text-sm text-ink-3">{POLL.includes(l.status) ? "Rendering the PDF…" : "No actions available."}</p>}
            </div>
            <div className="mt-3 space-y-2" aria-live="polite">
              {!dialog && <ErrorText error={act.error} />}
              <ErrorText error={fu.error} />
              {notice && <Alert tone="blue">{notice}</Alert>}
            </div>
          </Card>
          <StatusTimeline l={l} />
          <AttachmentsCard l={l} editable={editing} />
        </div>
      </div>

      <ReasonDialog
        open={dialog === "reject"}
        title="Reject letter"
        label="What needs to change?"
        submitLabel="Reject"
        danger
        busy={busy("reject")}
        error={act.error}
        onClose={() => setDialog(null)}
        onSubmit={(reason) => act.mutate({ path: "reject", body: { reason } })}
      />
      <SentDialog open={dialog === "sent"} onClose={() => setDialog(null)} busy={busy("sent")} error={act.error} onSubmit={(b) => act.mutate({ path: "sent", body: b })} />
      <ResponseDialog open={dialog === "response"} l={l} onClose={() => setDialog(null)} busy={busy("response")} error={act.error} onSubmit={(b) => act.mutate({ path: "response", body: b })} />
      {followUp && <NewRoundDialog open onClose={() => setFollowUp(null)} clientId={l.clientId} items={followUp} title={`Follow-up to round ${l.roundNumber}`} />}
    </>
  );
}

function DraftEditor({ clientId, initial, onChange, dirty, onSave, saving, saveError }: { clientId: string; initial: string; onChange: (h: string) => void; dirty: boolean; onSave: () => void; saving: boolean; saveError: unknown }) {
  const lock = useClientLock(clientId);
  const lockLost = saveError instanceof ApiError && saveError.code === "lock_conflict";
  const readOnly = lock.status !== "held" || lockLost;
  return (
    <div className="space-y-3">
      <div aria-live="polite">
        {lock.status === "conflict" && <Alert tone="amber" title={`Being edited by ${lock.holder?.name ?? "someone else"}`}>The editor is read-only until they finish.</Alert>}
        {lock.status === "acquiring" && <p className="text-xs text-ink-3">Checking the edit lock…</p>}
        {lock.status === "error" && <Alert>Could not get the edit lock. Reload to try again.</Alert>}
      </div>
      <Suspense fallback={<Spinner label="Loading editor" />}>
        <Editor value={initial} onChange={onChange} editable={!readOnly} label="Letter body" />
      </Suspense>
      <p className="text-xs text-ink-3">
        <span className="dob-chip">{"{{client.dob}}"}</span> stays as a token and is filled in only on the printed PDF.
      </p>
      <ErrorText error={saveError} />
      <Button variant="secondary" disabled={!dirty || readOnly} busy={saving} onClick={onSave}>
        {dirty ? "Save draft" : "Saved"}
      </Button>
    </div>
  );
}

function StatusTimeline({ l }: { l: LetterDetail }) {
  const idx = letterPathIndex(l.status);
  const when: Partial<Record<string, number | null>> = { draft: l.createdAt, approved: l.approvedAt, sent: l.sentAt };
  return (
    <Card title="Status">
      <ol className="space-y-2 text-sm">
        {LETTER_PATH.map((s, i) => {
          const side = i === idx && (l.status === "render_failed" || l.status === "overdue") ? l.status : null;
          const state = i < idx || (i === idx && l.status === "closed") ? "done" : i === idx ? "current" : "todo";
          return (
            <li key={s} className="flex items-center gap-2" aria-current={state === "current" ? "step" : undefined}>
              <span aria-hidden className={`size-2.5 rounded-full ${side ? "bg-neg-strong" : state === "done" ? "bg-pos" : state === "current" ? "bg-accent ring-4 ring-accent-soft" : "bg-line-strong"}`} />
              <span className={state === "current" ? "font-semibold" : state === "todo" ? "text-ink-3" : ""}>{humanize(side ?? s)}</span>
              {when[s] ? <span className="ml-auto text-xs text-ink-3">{fmtDate(when[s])}</span> : null}
            </li>
          );
        })}
      </ol>
      <dl className="mt-3 space-y-1 border-t border-line pt-3 text-xs text-ink-2">
        {l.responseDueAt && <div>Response due <strong>{fmtDate(l.responseDueAt)}</strong></div>}
        {l.trackingNumber && <div>Tracking <span className="font-mono">{l.trackingNumber}</span></div>}
        {l.createdByName && <div>Written by {l.createdByName}</div>}
        {l.approvedAt && <div>Approved {fmtDateTime(l.approvedAt)}{l.approvedByName ? ` by ${l.approvedByName}` : ""}</div>}
      </dl>
    </Card>
  );
}

function AttachmentsCard({ l, editable }: { l: LetterDetail; editable: boolean }) {
  const qc = useQueryClient();
  const docs = useClientDocuments(l.clientId);
  const [sel, setSel] = useState<Set<string>>(() => new Set(l.attachments.map((a) => a.id)));
  const save = useMutation({ mutationFn: () => patch<LetterDetail>(`/letters/${l.id}`, { attachmentDocumentIds: [...sel] }), onSuccess: (d) => qc.setQueryData(["letter", l.id], d) });
  if (!editable)
    return (
      <Card title="Enclosures">
        {l.attachments.length ? (
          <ul className="space-y-1 text-sm">
            {l.attachments.map((a) => (
              <li key={a.id}>{a.filename} <span className="text-xs text-ink-3">({humanize(a.type)})</span></li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-3">No enclosures.</p>
        )}
      </Card>
    );
  const available = docs.data?.filter((d) => d.status === "available" && d.type !== "letter" && d.type !== "audit_export") ?? [];
  const changed = [...sel].sort().join() !== l.attachments.map((a) => a.id).sort().join();
  return (
    <Card title="Enclosures">
      {docs.isPending ? (
        <Spinner />
      ) : !available.length ? (
        <p className="text-sm text-ink-3">No available documents. Upload ID or proof of address on the client's Documents tab.</p>
      ) : (
        <fieldset className="space-y-1">
          <legend className="sr-only">Documents to enclose</legend>
          {available.map((d) => (
            <Checkbox
              key={d.id}
              className="flex"
              checked={sel.has(d.id)}
              onChange={(e) => setSel((s) => { const n = new Set(s); if (e.target.checked) n.add(d.id); else n.delete(d.id); return n; })}
              label={<span>{d.filename} <span className="text-xs text-ink-3">({humanize(d.type)})</span></span>}
            />
          ))}
        </fieldset>
      )}
      <ErrorText error={save.error} />
      {available.length > 0 && (
        <Button small variant="secondary" className="mt-3" disabled={!changed} busy={save.isPending} onClick={() => save.mutate()}>
          Save enclosures
        </Button>
      )}
    </Card>
  );
}

function SentDialog({ open, onClose, busy, error, onSubmit }: { open: boolean; onClose: () => void; busy: boolean; error: unknown; onSubmit: (b: unknown) => void }) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  return (
    <Dialog open={open} onClose={onClose} title="Mark letter as sent">
      <form
        noValidate
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
          const r = letterSent.safeParse({ sentAt: f.sentAt, trackingNumber: f.trackingNumber || undefined });
          setErrors(r.success ? {} : issuesToMap(r.error.issues));
          if (r.success) onSubmit(r.data);
        }}
      >
        <Input label="Date mailed" name="sentAt" type="date" defaultValue={todayIso()} max={todayIso()} error={errors.sentAt} />
        <Input label="Tracking number (optional)" name="trackingNumber" maxLength={64} error={errors.trackingNumber} />
        <p className="text-xs text-ink-3">The response deadline is calculated from the mailing date.</p>
        <ErrorText error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" busy={busy}>Mark sent</Button>
        </div>
      </form>
    </Dialog>
  );
}

function ResponseDialog({ open, l, onClose, busy, error, onSubmit }: { open: boolean; l: LetterDetail; onClose: () => void; busy: boolean; error: unknown; onSubmit: (b: unknown) => void }) {
  const docs = useClientDocuments(l.clientId);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome | "">>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  return (
    <Dialog open={open} onClose={onClose} title="Log bureau response" wide>
      <form
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
          const list = Object.entries(outcomes).filter(([, o]) => o).map(([reportItemId, outcome]) => ({ reportItemId, outcome }));
          const r = letterResponse.safeParse({ receivedAt: f.receivedAt, outcomes: list, documentId: f.documentId || undefined, notes: f.notes || undefined });
          setErrors(r.success ? {} : issuesToMap(r.error.issues));
          if (r.success) onSubmit(r.data);
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Date received" name="receivedAt" type="date" defaultValue={todayIso()} max={todayIso()} error={errors.receivedAt} />
          <Select
            label="Response document (optional)"
            name="documentId"
            placeholder="None"
            options={(docs.data ?? []).filter((d) => d.status === "available").map((d) => ({ value: d.id, label: `${d.filename} (${humanize(d.type)})` }))}
          />
        </div>
        <fieldset>
          <legend className="mb-2 text-sm font-medium text-ink-2">Outcome per item</legend>
          <ul className="space-y-2">
            {l.items.map((i) => (
              <li key={i.id} className="grid items-center gap-2 sm:grid-cols-[1fr_12rem]">
                <span className="text-sm">
                  {humanize(i.bureau)} · {i.furnisher ?? humanize(i.itemType)} <span className="font-mono text-xs">{i.accountMask}</span>
                </span>
                <Select
                  label={`Outcome for ${i.furnisher ?? "item"} ${i.accountMask ?? ""}`}
                  srOnlyLabel
                  value={outcomes[i.id] ?? ""}
                  onChange={(e) => setOutcomes((o) => ({ ...o, [i.id]: e.target.value as Outcome | "" }))}
                  placeholder="Not recorded"
                  options={OUTCOMES}
                />
              </li>
            ))}
          </ul>
          {errors.outcomes && <p className="mt-1 text-xs font-medium text-neg">Record an outcome for at least one item</p>}
        </fieldset>
        <Textarea label="Notes (optional)" name="notes" rows={3} maxLength={5000} />
        <ErrorText error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" busy={busy}>Log response</Button>
        </div>
      </form>
    </Dialog>
  );
}
