/** Org admin pages: staff users, org settings, templates, flag rules, audit log + export. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  ITEM_TYPES,
  MERGE_FIELDS,
  ITEM_MERGE_FIELDS,
  ROLES,
  type FlagRuleDto,
  type OrgSettingsDto,
  type TemplateDto,
  type UserDto,
  auditExportRequest,
  flagRuleInput,
  orgSettingsUpdate,
  userCreate,
  validateTemplate,
} from "@da/shared";
import { Suspense, lazy, useRef, useState } from "react";
import { Alert, Button, Card, Checkbox, Dialog, Empty, ErrorText, Input, PageHeader, Q, Select, Spinner, StatusChip, Table, Textarea } from "../../components/ui";
import { ApiError, api, patch, post, staffDownload } from "../../lib/api";
import { fmtDate, humanize, issuesToMap, todayIso } from "../../lib/format";
import { useCan, useStaffMe, useUsers } from "../../lib/session";
import { AuditList } from "./shell";

const Editor = lazy(() => import("../../components/Editor"));

const NoAccess = () => <Alert>You do not have permission to view this page.</Alert>;
const values = (form: HTMLFormElement) => Object.fromEntries(new FormData(form)) as Record<string, string>;

// ---------- staff users ----------
export function UsersPage() {
  const can = useCan();
  const me = useStaffMe();
  const qc = useQueryClient();
  const users = useUsers();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const refresh = () => qc.invalidateQueries({ queryKey: ["users"] });
  const add = useMutation({ mutationFn: (b: unknown) => post<UserDto>("/users", b), onSuccess: refresh });
  const update = useMutation({ mutationFn: ({ id, ...b }: { id: string; role?: string; status?: string }) => patch<UserDto>(`/users/${id}`, b), onSuccess: refresh });
  if (!can("user:write")) return <NoAccess />;
  return (
    <>
      <PageHeader title="Staff users" subtitle="Staff sign in through Cloudflare Access with their work email." />
      <Card title="Add staff member" className="mb-4">
        <form
          noValidate
          className="grid gap-3 md:grid-cols-[1fr_1fr_10rem_auto] md:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const r = userCreate.safeParse(values(form));
            setErrors(r.success ? {} : issuesToMap(r.error.issues));
            if (r.success) add.mutate(r.data, { onSuccess: () => form.reset() });
          }}
        >
          <Input label="Email" name="email" type="email" error={errors.email} />
          <Input label="Display name" name="displayName" error={errors.displayName} />
          <Select label="Role" name="role" options={ROLES} defaultValue="staff" />
          <Button type="submit" busy={add.isPending}>Add user</Button>
          <div className="md:col-span-4"><ErrorText error={add.error} /></div>
        </form>
      </Card>
      <ErrorText error={update.error} />
      <Q q={users}>
        {(us) => (
          <Table caption="Staff users">
            <thead>
              <tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Added</th><th><span className="sr-only">Actions</span></th></tr>
            </thead>
            <tbody>
              {us.map((u) => {
                const self = u.id === me.data?.id;
                return (
                  <tr key={u.id}>
                    <td className="font-medium">{u.displayName}{self && <span className="text-ink-3"> (you)</span>}</td>
                    <td>{u.email}</td>
                    <td className="w-44">
                      <Select label={`Role for ${u.displayName}`} srOnlyLabel value={u.role} disabled={self || u.status !== "active"} options={ROLES} onChange={(e) => update.mutate({ id: u.id, role: e.target.value })} />
                    </td>
                    <td><StatusChip status={u.status === "active" ? "active" : "closed"} label={humanize(u.status)} /></td>
                    <td className="whitespace-nowrap">{fmtDate(u.createdAt)}</td>
                    <td>
                      {!self && (
                        <Button small variant={u.status === "active" ? "danger" : "secondary"} busy={update.isPending && update.variables?.id === u.id && !!update.variables.status} onClick={() => update.mutate({ id: u.id, status: u.status === "active" ? "inactive" : "active" })}>
                          {u.status === "active" ? "Deactivate" : "Reactivate"}
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Q>
    </>
  );
}

// ---------- org settings ----------
export function OrgSettingsPage() {
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["org-settings"], queryFn: () => api<OrgSettingsDto>("/org/settings") });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation({ mutationFn: (b: unknown) => patch("/org/settings", b), onSuccess: () => qc.invalidateQueries({ queryKey: ["org-settings"] }) });
  if (!can("org:write")) return <NoAccess />;
  return (
    <Q q={q}>
      {(s) => (
        <>
          <PageHeader title="Organization settings" subtitle={s.orgName} />
          <form
            key={JSON.stringify(s)}
            noValidate
            className="max-w-2xl space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              const f = values(e.currentTarget);
              const fd = new FormData(e.currentTarget);
              const r = orgSettingsUpdate.safeParse({
                deadlineDays: Number(f.deadlineDays),
                reminderOffsetsDays: f.reminderOffsetsDays.split(",").map((x) => x.trim()).filter(Boolean).map(Number),
                selfApproval: fd.has("selfApproval"),
                smsEnabled: fd.has("smsEnabled"),
                inviteExpiryDays: Number(f.inviteExpiryDays),
                senderBlock: { name: f.senderName, addressLines: f.senderAddress.split("\n").map((x) => x.trim()).filter(Boolean) },
              });
              setErrors(r.success ? {} : issuesToMap(r.error.issues));
              if (r.success) save.mutate(r.data);
            }}
          >
            <Card title="Deadlines">
              <div className="grid gap-3 sm:grid-cols-3">
                <Input label="Response deadline (days)" name="deadlineDays" type="number" min={1} max={120} defaultValue={s.deadlineDays} error={errors.deadlineDays} />
                <Input label="Reminders (days before)" name="reminderOffsetsDays" defaultValue={s.reminderOffsetsDays.join(", ")} hint="Comma separated, e.g. 7, 3" error={errors.reminderOffsetsDays ?? Object.entries(errors).find(([k]) => k.startsWith("reminderOffsetsDays."))?.[1]} />
                <Input label="Invite expiry (days)" name="inviteExpiryDays" type="number" min={1} max={30} defaultValue={s.inviteExpiryDays} error={errors.inviteExpiryDays} />
              </div>
            </Card>
            <Card title="Letters">
              <div className="space-y-3">
                <Input label="Sender name" name="senderName" defaultValue={s.senderBlock.name} error={errors["senderBlock.name"]} />
                <Textarea label="Sender address" name="senderAddress" rows={4} defaultValue={s.senderBlock.addressLines.join("\n")} hint="One line per row, up to 6" error={errors["senderBlock.addressLines"]} />
                <Checkbox label="Allow staff to approve letters they wrote" name="selfApproval" defaultChecked={s.selfApproval} />
              </div>
            </Card>
            <Card title="Notifications">
              <Checkbox label="Enable SMS notifications (clients must still opt in)" name="smsEnabled" defaultChecked={s.smsEnabled} />
            </Card>
            <div aria-live="polite">
              <ErrorText error={save.error} />
              {save.isSuccess && <Alert tone="green">Settings saved.</Alert>}
            </div>
            <Button type="submit" busy={save.isPending}>Save settings</Button>
          </form>
        </>
      )}
    </Q>
  );
}

// ---------- templates ----------
export function TemplatesPage() {
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["templates"], queryFn: () => api<TemplateDto[]>("/templates") });
  const toggle = useMutation({ mutationFn: (t: TemplateDto) => patch(`/templates/${t.id}`, { active: !t.active }), onSuccess: () => qc.invalidateQueries({ queryKey: ["templates"] }) });
  if (!can("template:write")) return <NoAccess />;
  return (
    <>
      <PageHeader
        title="Letter templates"
        actions={<Link to="/admin/templates/$templateId" params={{ templateId: "new" }} className="rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white hover:bg-accent-hover">New template</Link>}
      />
      <ErrorText error={toggle.error} />
      <Q q={q}>
        {(ts) =>
          !ts.length ? (
            <Empty>No templates yet.</Empty>
          ) : (
            <Table caption="Templates (latest versions)">
              <thead><tr><th>Name</th><th>Version</th><th>Status</th><th>Saved</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {ts.map((t) => (
                  <tr key={t.id}>
                    <td><Link to="/admin/templates/$templateId" params={{ templateId: t.id }} className="font-medium link">{t.name}</Link></td>
                    <td>v{t.version}</td>
                    <td><StatusChip status={t.active ? "active" : "closed"} label={t.active ? "Active" : "Inactive"} /></td>
                    <td>{fmtDate(t.createdAt)}</td>
                    <td>
                      <Button small variant="secondary" busy={toggle.isPending && toggle.variables?.id === t.id} onClick={() => toggle.mutate(t)}>
                        {t.active ? "Deactivate" : "Activate"}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )
        }
      </Q>
    </>
  );
}

export function TemplateEditPage() {
  const { templateId } = useParams({ from: "/admin/templates/$templateId" });
  const isNew = templateId === "new";
  const q = useQuery({ queryKey: ["template", templateId], queryFn: () => api<TemplateDto>(`/templates/${templateId}`), enabled: !isNew });
  const can = useCan();
  if (!can("template:write")) return <NoAccess />;
  if (isNew) return <TemplateForm key="new" />;
  return <Q q={q}>{(t) => <TemplateForm key={t.id} t={t} />}</Q>;
}

function TemplateForm({ t }: { t?: TemplateDto }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [name, setName] = useState(t?.name ?? "");
  const [html, setHtml] = useState(t?.bodyHtml ?? "<p></p>");
  const [mode, setMode] = useState<"visual" | "html">("visual");
  const [lossy, setLossy] = useState(false);
  const [unknown, setUnknown] = useState<string[]>([]);
  const area = useRef<HTMLTextAreaElement>(null);
  const save = useMutation({
    mutationFn: () => (t ? post<TemplateDto>(`/templates/${t.id}/versions`, { bodyHtml: html }) : post<TemplateDto>("/templates", { name, bodyHtml: html })),
    onSuccess: (n) => {
      qc.invalidateQueries({ queryKey: ["templates"] });
      navigate({ to: "/admin/templates/$templateId", params: { templateId: n.id } });
    },
    onError: (e) => e instanceof ApiError && e.code === "template_invalid" && setUnknown((e.details as { unknown?: string[] })?.unknown ?? []),
  });
  const insertAtCursor = (token: string) => {
    const el = area.current;
    if (!el) return;
    const at = el.selectionStart ?? html.length;
    setHtml(html.slice(0, at) + token + html.slice(el.selectionEnd ?? at));
  };
  return (
    <>
      <PageHeader title={t ? `${t.name}` : "New template"} subtitle={t ? `Editing v${t.version}. Saving creates v${t.version + 1}; letters keep the version they were drafted from.` : undefined} />
      <form
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          const bad = validateTemplate(html);
          setUnknown(bad);
          if (!bad.length && (t || name.trim())) save.mutate();
        }}
      >
        {!t && <div className="max-w-md"><Input label="Template name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} error={save.isIdle || name.trim() ? undefined : "Enter a name"} /></div>}
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Editor mode">
          <Button small variant={mode === "visual" ? "primary" : "secondary"} aria-pressed={mode === "visual"} onClick={() => { setLossy(false); setMode("visual"); }}>Visual</Button>
          <Button small variant={mode === "html" ? "primary" : "secondary"} aria-pressed={mode === "html"} onClick={() => setMode("html")}>HTML</Button>
        </div>
        {lossy && <Alert tone="amber">This template has an items loop the visual editor cannot represent (for example inside a list), so it opened in HTML mode to keep it intact.</Alert>}
        {mode === "visual" ? (
          <Suspense fallback={<Spinner label="Loading editor" />}>
            <Editor value={html} onChange={setHtml} label="Template body" mergeFields onLossyLoad={() => { setLossy(true); setMode("html"); }} />
          </Suspense>
        ) : (
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm text-ink-2">
              <span>Insert field</span>
              <select className="rounded border border-line-strong px-2 py-1 text-sm" value="" onChange={(e) => e.target.value && insertAtCursor(e.target.value)}>
                <option value="">Choose…</option>
                {[...MERGE_FIELDS, ...ITEM_MERGE_FIELDS].map((f) => <option key={f.key} value={`{{${f.key}}}`}>{f.label}</option>)}
                <option value="{{#each items}}{{/each}}">Items loop</option>
              </select>
            </label>
            <Textarea ref={area} label="Template HTML" srOnlyLabel value={html} onChange={(e) => setHtml(e.target.value)} rows={18} className="font-mono text-xs" />
          </div>
        )}
        <div aria-live="polite" className="space-y-2">
          {unknown.length > 0 && <Alert title="Unknown merge fields">{unknown.map((u) => `{{${u}}}`).join(", ")}. Use the Insert field menu for valid fields.</Alert>}
          {!(save.error instanceof ApiError && save.error.code === "template_invalid") && <ErrorText error={save.error} />}
        </div>
        <div className="flex gap-2">
          <Button type="submit" busy={save.isPending}>{t ? "Save as new version" : "Create template"}</Button>
          <Link to="/admin/templates" className="rounded-lg px-3.5 py-2 text-sm link">Back to templates</Link>
        </div>
      </form>
    </>
  );
}

// ---------- flag rules ----------
export function FlagRulesPage() {
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["flag-rules"], queryFn: () => api<FlagRuleDto[]>("/flag-rules") });
  const [editing, setEditing] = useState<FlagRuleDto | "new" | null>(null);
  const toggle = useMutation({ mutationFn: (r: FlagRuleDto) => patch(`/flag-rules/${r.id}`, { active: !r.active }), onSuccess: () => qc.invalidateQueries({ queryKey: ["flag-rules"] }) });
  if (!can("rule:write")) return <NoAccess />;
  return (
    <>
      <PageHeader title="Flag rules" subtitle="Rules run on every imported report and flag items for dispute." actions={<Button onClick={() => setEditing("new")}>New rule</Button>} />
      <ErrorText error={toggle.error} />
      <Q q={q}>
        {(rules) =>
          !rules.length ? (
            <Empty>No rules yet.</Empty>
          ) : (
            <Table caption="Flag rules">
              <thead><tr><th>Name</th><th>Kind</th><th>Item types</th><th>Reason</th><th>Active</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {rules.map((r) => (
                  <tr key={r.id}>
                    <td className="font-medium">{r.name}</td>
                    <td>{humanize(r.kind)}</td>
                    <td className="text-xs">{r.itemTypes.map(humanize).join(", ")}</td>
                    <td className="max-w-xs text-xs">{r.reasonTemplate}</td>
                    <td><Checkbox label={<span className="sr-only">Active: {r.name}</span>} checked={r.active} disabled={toggle.isPending} onChange={() => toggle.mutate(r)} /></td>
                    <td><Button small variant="ghost" onClick={() => setEditing(r)}>Edit</Button></td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )
        }
      </Q>
      {editing && <RuleDialog rule={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

const EXAMPLE_CONDITION = '{\n  "all": [\n    { "field": "status", "op": "contains", "value": "collection" },\n    { "field": "openedAt", "op": "older_than_years", "value": 7 }\n  ]\n}';

function RuleDialog({ rule, onClose }: { rule: FlagRuleDto | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: (b: unknown) => (rule ? patch(`/flag-rules/${rule.id}`, b) : post("/flag-rules", b)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["flag-rules"] });
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title={rule ? `Edit rule: ${rule.name}` : "New flag rule"} wide>
      <form
        noValidate
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          const f = values(e.currentTarget);
          let condition: unknown;
          if (f.condition.trim()) {
            try {
              condition = JSON.parse(f.condition);
            } catch (err) {
              return setErrors({ condition: `Invalid JSON: ${(err as Error).message}` });
            }
          }
          const r = flagRuleInput.safeParse({ name: f.name, kind: f.kind, itemTypes: fd.getAll("itemTypes"), condition, reasonTemplate: f.reasonTemplate, active: fd.has("active") });
          const errs = r.success ? {} : issuesToMap(r.error.issues);
          const condErr = Object.entries(errs).find(([k]) => k.startsWith("condition"));
          if (condErr) errs.condition = condErr[0] === "condition" ? condErr[1] : `${condErr[0]}: ${condErr[1]}`;
          if (r.success && r.data.kind === "condition" && !r.data.condition) errs.condition = "A condition rule needs a condition";
          setErrors(errs);
          if (r.success && !Object.keys(errs).length) save.mutate(r.data);
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Name" name="name" defaultValue={rule?.name} maxLength={120} error={errors.name} />
          <Select label="Kind" name="kind" defaultValue={rule?.kind ?? "condition"} options={["condition", "cross_bureau_mismatch"]} />
        </div>
        <fieldset>
          <legend className="mb-1 text-sm font-medium text-ink-2">Applies to</legend>
          <div className="flex flex-wrap gap-4">
            {ITEM_TYPES.map((t) => <Checkbox key={t} label={humanize(t)} name="itemTypes" value={t} defaultChecked={rule?.itemTypes.includes(t)} />)}
          </div>
          {errors.itemTypes && <p className="mt-1 text-xs font-medium text-neg">Choose at least one item type</p>}
        </fieldset>
        <Textarea
          label="Condition (JSON)"
          name="condition"
          rows={8}
          className="font-mono text-xs"
          defaultValue={rule?.condition ? JSON.stringify(rule.condition, null, 2) : rule ? "" : EXAMPLE_CONDITION}
          hint="Use all / any groups of { field, op, value }. Leave empty for cross-bureau mismatch rules."
          error={errors.condition}
        />
        <Input label="Reason shown on flags and letters" name="reasonTemplate" defaultValue={rule?.reasonTemplate} maxLength={500} error={errors.reasonTemplate} />
        <Checkbox label="Active" name="active" defaultChecked={rule?.active ?? true} />
        <ErrorText error={save.error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" busy={save.isPending}>{rule ? "Save rule" : "Create rule"}</Button>
        </div>
      </form>
    </Dialog>
  );
}

// ---------- audit ----------
type ExportState = { exportId: string; status: string; documentId: string | null };

export function AuditPage() {
  const can = useCan();
  const [filters, setFilters] = useState<{ entityType?: string; entityId?: string; from?: string; to?: string }>({});
  if (!can("audit:read")) return <NoAccess />;
  return (
    <>
      <PageHeader title="Audit log" />
      {can("audit:export") && <ExportCard />}
      <Card title="Filter" className="mb-4">
        <form
          className="grid gap-3 sm:grid-cols-5 sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            const f = values(e.currentTarget);
            setFilters({ entityType: f.entityType || undefined, entityId: f.entityId || undefined, from: f.from || undefined, to: f.to || undefined });
          }}
        >
          <Input label="Entity type" name="entityType" placeholder="client, letter…" maxLength={40} />
          <Input label="Entity ID" name="entityId" maxLength={64} />
          <Input label="From" name="from" type="date" />
          <Input label="To" name="to" type="date" />
          <Button type="submit" variant="secondary">Apply</Button>
        </form>
      </Card>
      <AuditList filters={filters} />
    </>
  );
}

function ExportCard() {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [exportId, setExportId] = useState<string | null>(null);
  const start = useMutation({ mutationFn: (b: unknown) => post<{ exportId: string }>("/audit/export", b), onSuccess: (r) => setExportId(r.exportId) });
  const status = useQuery({
    queryKey: ["audit-export", exportId],
    queryFn: () => api<ExportState>(`/audit/export/${exportId}`),
    enabled: !!exportId,
    refetchInterval: (q) => (q.state.data && ["ready", "failed"].includes(q.state.data.status) ? false : 2000),
  });
  const s = status.data;
  return (
    <Card title="Export CSV" className="mb-4">
      <form
        noValidate
        className="grid gap-3 sm:grid-cols-4 sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          const f = values(e.currentTarget);
          const r = auditExportRequest.safeParse({ from: f.from, to: f.to, entityType: f.entityType || undefined });
          setErrors(r.success ? {} : issuesToMap(r.error.issues));
          if (r.success) start.mutate(r.data);
        }}
      >
        <Input label="From" name="from" type="date" error={errors.from} />
        <Input label="To" name="to" type="date" defaultValue={todayIso()} error={errors.to} />
        <Input label="Entity type (optional)" name="entityType" maxLength={40} />
        <Button type="submit" busy={start.isPending || (!!exportId && !s) || s?.status === "queued" || s?.status === "running"}>Export CSV</Button>
      </form>
      <div aria-live="polite" className="mt-3 space-y-2">
        <ErrorText error={start.error ?? status.error} />
        {s && s.status !== "ready" && s.status !== "failed" && <p className="text-sm text-ink-2">Preparing export ({humanize(s.status)})…</p>}
        {s?.status === "failed" && <Alert>The export failed. Try again or narrow the date range.</Alert>}
        {s?.status === "ready" && s.documentId && (
          <Alert tone="green">
            Export ready. <a href={staffDownload(s.documentId)} download className="font-medium underline">Download CSV</a>
          </Alert>
        )}
      </div>
    </Card>
  );
}
