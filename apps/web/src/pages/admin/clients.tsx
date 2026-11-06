/** Clients list, create, and detail tabs. */
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import {
  CLIENT_STATUS,
  CLIENT_TRANSITIONS,
  type ClientDetail,
  type ClientPii,
  type ClientSummary,
  type DuplicateWarning,
  type LetterSummary,
  type NoteDto,
  type Page,
  type TimelineEntry,
  clientCreate,
  noteCreate,
} from "@da/shared";
import { type ReactNode, useState } from "react";
import type { z } from "zod";
import { DocumentsTable, UploadForm } from "../../components/Documents";
import { Alert, Button, Card, Checkbox, Chip, Empty, ErrorText, Input, PageHeader, Q, Select, Spinner, StatusChip, TabPanel, Table, Tabs, Textarea } from "../../components/ui";
import { ApiError, api, patch, post, qs, staffDownload } from "../../lib/api";
import { fmtDate, fmtDateTime, formatSsnInput, humanize, issuesToMap } from "../../lib/format";
import { useCan, useStaffMe, useUsers } from "../../lib/session";
import { NewRoundDialog } from "./letters";
import { useClientDocuments, useClientReports, useReportItems } from "./queries";
import { ReportsTab } from "./reports";
import { AuditList, LetterTable } from "./shell";

// ---------- list ----------
export function ClientsPage() {
  const can = useCan();
  const me = useStaffMe();
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [mine, setMine] = useState(false);
  const list = useInfiniteQuery({
    queryKey: ["clients", status, q, mine],
    queryFn: ({ pageParam }) => api<Page<ClientSummary>>(`/clients${qs({ status, q, assignedTo: mine ? me.data?.id : undefined, cursor: pageParam })}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <PageHeader
        title="Clients"
        actions={
          can("client:write") && (
            <Link to="/admin/clients/new" className="rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white hover:bg-accent-hover">
              New client
            </Link>
          )
        }
      />
      <form
        role="search"
        className="mb-4 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setQ(String(new FormData(e.currentTarget).get("q") ?? "").trim());
        }}
      >
        <div className="w-64">
          <Input label="Search" name="q" placeholder="Name or email" maxLength={100} />
        </div>
        <div className="w-40">
          <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)} options={CLIENT_STATUS} placeholder="All" />
        </div>
        <Checkbox label="Assigned to me" checked={mine} onChange={(e) => setMine(e.target.checked)} className="mb-2" />
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </form>
      {list.isPending ? (
        <Spinner />
      ) : list.isError ? (
        <ErrorText error={list.error} />
      ) : !rows.length ? (
        <Empty>No clients match.</Empty>
      ) : (
        <Table caption="Clients">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Status</th>
              <th>Authorization</th>
              <th>SSN</th>
              <th>Assigned to</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id}>
                <td>
                  <Link to="/admin/clients/$clientId" params={{ clientId: c.id }} className="font-medium link">
                    {c.lastName}, {c.firstName}
                  </Link>
                </td>
                <td>{c.email}</td>
                <td>
                  <StatusChip status={c.status} />
                </td>
                <td>
                  <StatusChip status={c.authStatus} />
                </td>
                <td className="font-mono text-xs">•••-••-{c.ssnLast4}</td>
                <td>{c.assignedStaffName ?? "—"}</td>
                <td className="whitespace-nowrap">{fmtDate(c.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {list.hasNextPage && (
        <Button variant="secondary" className="mt-3" busy={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>
          Load more
        </Button>
      )}
    </>
  );
}

// ---------- create ----------
type ClientInput = z.output<typeof clientCreate>;

export function ClientCreatePage() {
  const can = useCan();
  const users = useUsers();
  const navigate = useNavigate();
  const [ssn, setSsn] = useState("");
  const [showSsn, setShowSsn] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<ClientInput | null>(null);
  const create = useMutation({
    mutationFn: (b: ClientInput) => post<ClientDetail>("/clients", b),
    onSuccess: (c) => navigate({ to: "/admin/clients/$clientId", params: { clientId: c.id } }),
    onError: (e) => e instanceof ApiError && e.code === "validation_failed" && setErrors(issuesToMap(e.details)),
  });
  const dupes = create.error instanceof ApiError && create.error.code === "possible_duplicate" ? (create.error.details as DuplicateWarning).duplicateOf : null;

  return (
    <>
      <PageHeader title="New client" />
      <form
        noValidate
        autoComplete="off"
        className="max-w-3xl space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
          const r = clientCreate.safeParse({
            firstName: f.firstName,
            lastName: f.lastName,
            email: f.email,
            phone: f.phone || undefined,
            dob: f.dob,
            ssn,
            address: { line1: f.line1, line2: f.line2 || undefined, city: f.city, state: f.state, zip: f.zip },
            assignedStaffId: f.assignedStaffId || undefined,
          });
          setErrors(r.success ? {} : issuesToMap(r.error.issues));
          if (r.success) {
            setPending(r.data);
            create.mutate(r.data);
          }
        }}
      >
        <Card title="Identity">
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="First name" name="firstName" error={errors.firstName} />
            <Input label="Last name" name="lastName" error={errors.lastName} />
            <Input label="Email" name="email" type="email" error={errors.email} />
            <Input label="Mobile phone (optional)" name="phone" type="tel" error={errors.phone} />
            <Input label="Date of birth" name="dob" type="date" error={errors.dob} />
            <div className="space-y-1">
              <Input
                label="Social Security number"
                type={showSsn ? "text" : "password"}
                inputMode="numeric"
                autoComplete="off"
                placeholder="123-45-6789"
                value={ssn}
                onChange={(e) => setSsn(formatSsnInput(e.target.value))}
                error={errors.ssn}
                hint="Stored encrypted. Only the last 4 digits are shown afterwards."
              />
              <Checkbox label="Show SSN" checked={showSsn} onChange={(e) => setShowSsn(e.target.checked)} />
            </div>
          </div>
        </Card>
        <Card title="Address">
          <div className="grid gap-3 sm:grid-cols-6">
            <div className="sm:col-span-6"><Input label="Street address" name="line1" autoComplete="address-line1" error={errors["address.line1"]} /></div>
            <div className="sm:col-span-6"><Input label="Apartment, suite (optional)" name="line2" autoComplete="address-line2" error={errors["address.line2"]} /></div>
            <div className="sm:col-span-3"><Input label="City" name="city" error={errors["address.city"]} /></div>
            <div className="sm:col-span-1"><Input label="State" name="state" maxLength={2} placeholder="CA" error={errors["address.state"]} /></div>
            <div className="sm:col-span-2"><Input label="ZIP" name="zip" inputMode="numeric" error={errors["address.zip"]} /></div>
          </div>
        </Card>
        {can("client:assign") && (
          <Card title="Assignment">
            <div className="max-w-xs">
              <Select label="Assigned specialist" name="assignedStaffId" placeholder="Me" options={(users.data ?? []).filter((u) => u.status === "active").map((u) => ({ value: u.id, label: u.displayName }))} />
            </div>
          </Card>
        )}
        {dupes ? (
          <Alert tone="amber" title="Possible duplicate">
            <p>A client with this SSN already exists:</p>
            <ul className="my-2 list-disc pl-5">
              {dupes.map((d) => (
                <li key={d.id}>
                  <Link to="/admin/clients/$clientId" params={{ clientId: d.id }} className="underline">
                    {d.name}
                  </Link>
                </li>
              ))}
            </ul>
            <Button variant="danger" busy={create.isPending} onClick={() => pending && create.mutate({ ...pending, confirmDuplicate: true })}>
              Create anyway
            </Button>
          </Alert>
        ) : (
          create.error && !(create.error instanceof ApiError && create.error.code === "validation_failed") && <ErrorText error={create.error} />
        )}
        <Button type="submit" busy={create.isPending && !dupes}>
          Create client
        </Button>
      </form>
    </>
  );
}

// ---------- detail ----------
const TABS = [
  { id: "overview", label: "Overview" },
  { id: "timeline", label: "Timeline" },
  { id: "notes", label: "Notes" },
  { id: "documents", label: "Documents" },
  { id: "reports", label: "Reports" },
  { id: "letters", label: "Letters" },
  { id: "audit", label: "Audit" },
] as const;
type Tab = (typeof TABS)[number]["id"];

export const useClient = (id: string) => useQuery({ queryKey: ["client", id], queryFn: () => api<ClientDetail>(`/clients/${id}`) });

export function ClientDetailPage() {
  const { clientId } = useParams({ from: "/admin/clients/$clientId" });
  const search = useSearch({ from: "/admin/clients/$clientId" });
  const navigate = useNavigate({ from: "/admin/clients/$clientId" });
  const can = useCan();
  const client = useClient(clientId);
  const tab: Tab = TABS.some((t) => t.id === search.tab) ? (search.tab as Tab) : "overview";
  const tabs = TABS.filter((t) => t.id !== "audit" || can("audit:read"));
  return (
    <Q q={client}>
      {(c) => (
        <>
          <PageHeader
            title={`${c.firstName} ${c.lastName}`}
            subtitle={
              <span className="flex flex-wrap items-center gap-2">
                <StatusChip status={c.status} />
                <span>Authorization: <StatusChip status={c.authStatus} /></span>
                <span>Assigned to {c.assignedStaffName ?? "nobody"}</span>
              </span>
            }
          />
          <Tabs label="Client sections" tabs={tabs} value={tab} onChange={(t) => navigate({ search: { tab: t }, replace: true })} />
          <TabPanel id={tab}>
            {tab === "overview" && <OverviewTab c={c} />}
            {tab === "timeline" && <TimelineTab clientId={c.id} />}
            {tab === "notes" && <NotesTab clientId={c.id} />}
            {tab === "documents" && <DocumentsTab clientId={c.id} />}
            {tab === "reports" && <ReportsTab clientId={c.id} />}
            {tab === "letters" && <LettersTab clientId={c.id} />}
            {tab === "audit" && <AuditList filters={{ entityType: "client", entityId: c.id }} />}
          </TabPanel>
        </>
      )}
    </Q>
  );
}

const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="grid grid-cols-[9rem_1fr] gap-2 py-1.5 text-sm">
    <dt className="text-ink-3">{label}</dt>
    <dd className="text-ink">{children}</dd>
  </div>
);

function OverviewTab({ c }: { c: ClientDetail }) {
  const can = useCan();
  const qc = useQueryClient();
  const users = useUsers();
  const refresh = () => qc.invalidateQueries({ queryKey: ["client", c.id] });
  const [pii, setPii] = useState<ClientPii | null>(null);
  const [nextStatus, setNextStatus] = useState("");
  const [assignee, setAssignee] = useState(c.assignedStaffId ?? "");
  const reveal = useMutation({ mutationFn: () => api<ClientPii>(`/clients/${c.id}/pii`), onSuccess: setPii });
  const status = useMutation({ mutationFn: () => post(`/clients/${c.id}/status`, { status: nextStatus }), onSuccess: () => { setNextStatus(""); refresh(); qc.invalidateQueries({ queryKey: ["clients"] }); } });
  const assign = useMutation({ mutationFn: () => post(`/clients/${c.id}/assign`, { staffId: assignee }), onSuccess: refresh });
  const invite = useMutation({ mutationFn: () => post<{ expiresAt: number }>(`/clients/${c.id}/invite`) });
  const unlock = useMutation({ mutationFn: () => post(`/clients/${c.id}/unlock`), onSuccess: refresh });
  const authSend = useMutation({ mutationFn: () => post(`/clients/${c.id}/authorization/send`), onSuccess: refresh });
  const transitions = CLIENT_TRANSITIONS[c.status];

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card
        title="Details"
        actions={
          can("client:read_pii") &&
          (pii ? (
            <Button small variant="secondary" onClick={() => setPii(null)}>
              Hide SSN/DOB
            </Button>
          ) : (
            <Button small variant="secondary" busy={reveal.isPending} onClick={() => reveal.mutate()}>
              Reveal SSN/DOB
            </Button>
          ))
        }
      >
        <dl className="divide-y divide-line">
          <Row label="Email">{c.email}</Row>
          <Row label="Phone">{c.phone ?? "—"}</Row>
          <Row label="Address">
            {c.address.line1}
            {c.address.line2 && <>, {c.address.line2}</>}
            <br />
            {c.address.city}, {c.address.state} {c.address.zip}
          </Row>
          <Row label="SSN">
            <span className="font-mono">{pii ? formatSsnInput(pii.ssn) : `•••-••-${c.ssnLast4}`}</span>
          </Row>
          <Row label="Date of birth">
            <span className="font-mono">{pii ? pii.dob : c.dobMasked}</span>
          </Row>
          <Row label="Created">{fmtDate(c.createdAt)}</Row>
        </dl>
        <div aria-live="polite">
          {pii && <p className="mt-2 text-xs text-ink-3">This view was recorded in the audit log.</p>}
          <ErrorText error={reveal.error} />
        </div>
      </Card>

      <div className="space-y-4">
        {can("client:write") && (
          <Card title="Status">
            {transitions.length === 0 ? (
              <p className="text-sm text-ink-2">Closed clients cannot change status.</p>
            ) : (
              <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (nextStatus) status.mutate(); }}>
                <div className="w-48">
                  <Select label="Move to" value={nextStatus} onChange={(e) => setNextStatus(e.target.value)} options={transitions} placeholder="Choose…" />
                </div>
                <Button type="submit" variant="secondary" disabled={!nextStatus} busy={status.isPending}>
                  Change status
                </Button>
              </form>
            )}
            <ErrorText error={status.error} />
          </Card>
        )}
        {can("client:assign") && (
          <Card title="Assignment">
            <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); assign.mutate(); }}>
              <div className="w-56">
                <Select label="Specialist" value={assignee} onChange={(e) => setAssignee(e.target.value)} placeholder="Unassigned" options={(users.data ?? []).filter((u) => u.status === "active").map((u) => ({ value: u.id, label: u.displayName }))} />
              </div>
              <Button type="submit" variant="secondary" disabled={!assignee || assignee === c.assignedStaffId} busy={assign.isPending}>
                Assign
              </Button>
            </form>
            <ErrorText error={assign.error} />
          </Card>
        )}
        <Card title="Portal access">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            {c.hasPortalAccount ? (c.portalLocked ? <Chip tone="red">Locked</Chip> : <Chip tone="green">Active</Chip>) : <Chip>No account</Chip>}
            {can("client:write") && c.hasPortalAccount && c.portalLocked && (
              <Button small variant="secondary" busy={unlock.isPending} onClick={() => unlock.mutate()}>
                Unlock account
              </Button>
            )}
            {can("client:write") && !c.hasPortalAccount && (
              <Button small variant="secondary" busy={invite.isPending} onClick={() => invite.mutate()}>
                {invite.isSuccess ? "Resend invite" : "Send portal invite"}
              </Button>
            )}
          </div>
          <div aria-live="polite" className="mt-2 space-y-2">
            {invite.data && <Alert tone="green">Invite emailed. It expires {fmtDate(invite.data.expiresAt)}.</Alert>}
            <ErrorText error={invite.error ?? unlock.error} />
          </div>
        </Card>
        <Card title="Authorization">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <StatusChip status={c.authStatus} />
            {can("client:write") && c.authStatus !== "signed" && (
              <Button small variant="secondary" busy={authSend.isPending} onClick={() => authSend.mutate()}>
                {c.authStatus === "none" ? "Send authorization packet" : "Resend authorization packet"}
              </Button>
            )}
          </div>
          <p className="mt-2 text-xs text-ink-3">Letters cannot be approved until the authorization is signed.</p>
          <ErrorText error={authSend.error} />
        </Card>
      </div>
    </div>
  );
}

function TimelineTab({ clientId }: { clientId: string }) {
  const q = useQuery({ queryKey: ["timeline", clientId], queryFn: () => api<TimelineEntry[]>(`/clients/${clientId}/timeline`) });
  return (
    <Card>
      <Q q={q}>
        {(rows) =>
          !rows.length ? (
            <Empty>Nothing has happened yet.</Empty>
          ) : (
            <ol className="relative space-y-4 border-l border-line pl-5">
              {rows.map((r) => (
                <li key={`${r.kind}-${r.id}-${r.at}`} className="text-sm">
                  <span aria-hidden className="absolute -left-1.5 mt-1.5 size-3 rounded-full border-2 border-white bg-accent" />
                  <div className="flex flex-wrap items-center gap-2">
                    <Chip>{humanize(r.kind)}</Chip>
                    <span className="font-medium">{r.title}</span>
                    <span className="text-xs text-ink-3">{fmtDateTime(r.at)}</span>
                  </div>
                  {r.detail && <p className="mt-0.5 text-ink-2">{r.detail}</p>}
                </li>
              ))}
            </ol>
          )
        }
      </Q>
    </Card>
  );
}

function NotesTab({ clientId }: { clientId: string }) {
  const can = useCan();
  const qc = useQueryClient();
  const notes = useQuery({ queryKey: ["notes", clientId], queryFn: () => api<NoteDto[]>(`/clients/${clientId}/notes`) });
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [err, setErr] = useState<string>();
  const refresh = () => qc.invalidateQueries({ queryKey: ["notes", clientId] });
  const add = useMutation({ mutationFn: (body: string) => post(`/clients/${clientId}/notes`, { body }), onSuccess: () => { setDraft(""); refresh(); } });
  const save = useMutation({ mutationFn: (n: { id: string; body: string }) => patch(`/clients/${clientId}/notes/${n.id}`, { body: n.body }), onSuccess: () => { setEditing(null); refresh(); } });
  const validate = (body: string) => {
    const r = noteCreate.safeParse({ body });
    setErr(r.success ? undefined : r.error.issues[0]?.message);
    return r.success ? r.data.body : null;
  };
  return (
    <div className="space-y-4">
      {can("client:write") && (
        <Card title="Add note">
          <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); const b = validate(draft); if (b) add.mutate(b); }}>
            <Textarea label="Note" srOnlyLabel value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={10_000} error={editing ? undefined : err} hint="Notes can be edited for 24 hours." />
            <ErrorText error={add.error} />
            <Button type="submit" busy={add.isPending}>
              Add note
            </Button>
          </form>
        </Card>
      )}
      <Q q={notes}>
        {(ns) =>
          !ns.length ? (
            <Empty>No notes yet.</Empty>
          ) : (
            <ul className="space-y-3">
              {ns.map((n) => (
                <li key={n.id} className="rounded-2xl bg-surface p-4 text-[14px] shadow-card">
                  <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-xs text-ink-3">
                    <span>
                      <strong className="text-ink">{n.authorName}</strong> · {fmtDateTime(n.createdAt)}
                    </span>
                    {n.editable && can("client:write") && editing?.id !== n.id && (
                      <Button small variant="ghost" onClick={() => setEditing({ id: n.id, body: n.body })}>
                        Edit
                      </Button>
                    )}
                  </div>
                  {editing?.id === n.id ? (
                    <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); const b = validate(editing.body); if (b) save.mutate({ id: n.id, body: b }); }}>
                      <Textarea label="Edit note" srOnlyLabel value={editing.body} onChange={(e) => setEditing({ id: n.id, body: e.target.value })} error={err} />
                      <ErrorText error={save.error} />
                      <div className="flex gap-2">
                        <Button type="submit" small busy={save.isPending}>Save</Button>
                        <Button small variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
                      </div>
                    </form>
                  ) : (
                    <p className="whitespace-pre-wrap">{n.body}</p>
                  )}
                </li>
              ))}
            </ul>
          )
        }
      </Q>
    </div>
  );
}

function DocumentsTab({ clientId }: { clientId: string }) {
  const can = useCan();
  const qc = useQueryClient();
  const docs = useClientDocuments(clientId);
  return (
    <div className="space-y-4">
      {can("document:write") && (
        <Card title="Upload">
          <UploadForm path={`/clients/${clientId}/documents`} onDone={() => qc.invalidateQueries({ queryKey: ["documents", clientId] })} />
        </Card>
      )}
      <Q q={docs}>{(d) => <DocumentsTable docs={d} downloadUrl={staffDownload} />}</Q>
    </div>
  );
}

function LettersTab({ clientId }: { clientId: string }) {
  const can = useCan();
  const [open, setOpen] = useState(false);
  const letters = useQuery({ queryKey: ["letters", "client", clientId], queryFn: () => api<LetterSummary[]>(`/clients/${clientId}/letters`) });
  const reports = useClientReports(clientId);
  const latest = reports.data?.find((r) => r.status === "complete");
  const items = useReportItems(latest?.id);
  const flagged = items.data?.filter((i) => i.flags.length > 0 && !i.outcome) ?? [];
  return (
    <Card
      title="Letters"
      actions={
        can("letter:write") && (
          <Button onClick={() => setOpen(true)} disabled={!latest}>
            New dispute round
          </Button>
        )
      }
    >
      {!latest && can("letter:write") && <p className="mb-3 text-sm text-ink-2">Import a credit report before starting a dispute round.</p>}
      <Q q={letters}>{(ls) => <LetterTable letters={ls} showClient={false} />}</Q>
      <NewRoundDialog open={open} onClose={() => setOpen(false)} clientId={clientId} items={flagged} />
    </Card>
  );
}
