/** Staff shell (Access-authenticated), dashboard, and tasks. */
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet } from "@tanstack/react-router";
import { type AuditEntryDto, type LetterSummary, type Page, type Permission, type TaskDto, taskCreate } from "@da/shared";
import { useState } from "react";
import { NotificationList, NotificationsBell } from "../../components/Notifications";
import { Icon, type IconName, Wordmark } from "../../components/icons";
import { ThemeSwitcher } from "../../components/ThemeSwitcher";
import { Alert, Avatar, Button, Card, Empty, ErrorText, Input, PageHeader, Q, Select, Spinner, Stat, StatusChip, Table, Tabs } from "../../components/ui";
import { ApiError, api, patch, post, qs } from "../../lib/api";
import { fmtDate, fmtDateTime, humanize, issuesToMap, todayIso } from "../../lib/format";
import { useCan, useStaffMe, useUsers } from "../../lib/session";

type NavItem = { to: "/admin" | "/admin/clients" | "/admin/letters" | "/admin/tasks" | "/admin/users" | "/admin/org" | "/admin/templates" | "/admin/rules" | "/admin/audit"; label: string; icon: IconName; perm?: Permission };
const MAIN_NAV: NavItem[] = [
  { to: "/admin", label: "Dashboard", icon: "home" },
  { to: "/admin/clients", label: "Clients", icon: "people", perm: "client:read" },
  { to: "/admin/letters", label: "Letters", icon: "letter", perm: "letter:read" },
  { to: "/admin/tasks", label: "Tasks", icon: "check", perm: "task:read" },
];
const ADMIN_NAV: NavItem[] = [
  { to: "/admin/users", label: "Staff", icon: "person", perm: "user:write" },
  { to: "/admin/org", label: "Organization", icon: "building", perm: "org:write" },
  { to: "/admin/templates", label: "Templates", icon: "template", perm: "template:write" },
  { to: "/admin/rules", label: "Flag rules", icon: "flag", perm: "rule:write" },
  { to: "/admin/audit", label: "Audit log", icon: "shield", perm: "audit:read" },
];

function NavList({ items, label }: { items: NavItem[]; label: string }) {
  const can = useCan();
  const visible = items.filter((i) => !i.perm || can(i.perm));
  if (!visible.length) return null;
  return (
    <div>
      <p className="mb-1 hidden px-2.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3 md:block">{label}</p>
      <ul className="flex gap-0.5 md:flex-col">
        {visible.map((i) => (
          <li key={i.to}>
            <Link
              to={i.to}
              activeOptions={{ exact: i.to === "/admin" }}
              className="group flex h-8 items-center gap-2.5 whitespace-nowrap rounded-lg px-2.5 text-[14px] text-ink transition-colors hover:bg-fill"
              activeProps={{ className: "bg-fill-strong! font-medium [&_svg]:text-accent!" }}
            >
              <Icon name={i.icon} className="size-[18px] text-ink-3 transition-colors" />
              {i.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AdminShell() {
  const me = useStaffMe();
  if (me.isPending) return <Spinner label="Checking your access" />;
  if (me.isError)
    return (
      <div className="mx-auto max-w-lg p-6 pt-24">
        <Alert title="No access">{me.error instanceof ApiError && me.error.status === 403 ? "Your account does not have access to Dispute Alpha. Ask an administrator to add you." : me.error.message}</Alert>
      </div>
    );
  return (
    <div className="min-h-screen md:grid md:grid-cols-[15rem_1fr]">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:rounded-lg focus:bg-surface focus:p-2">
        Skip to content
      </a>
      <aside className="border-b border-line bg-[var(--sidebar)] px-3 pt-3 pb-2 backdrop-blur-xl md:sticky md:top-0 md:h-screen md:border-r md:border-b-0 md:pt-5">
        <div className="mb-4 px-2.5 md:mb-7">
          <Wordmark size={26} />
        </div>
        <nav aria-label="Main" className="flex gap-4 overflow-x-auto [scrollbar-width:none] md:flex-col md:gap-6">
          <NavList items={MAIN_NAV} label="Workspace" />
          <NavList items={ADMIN_NAV} label="Administration" />
        </nav>
      </aside>
      <div className="min-w-0">
        <header className="sticky top-0 z-30 flex h-14 items-center justify-end gap-2 border-b border-line bg-canvas/75 px-4 backdrop-blur-xl sm:px-8">
          <ThemeSwitcher compact className="mr-1" />
          <NotificationsBell base="" />
          <div className="ml-1 flex items-center gap-2.5 rounded-full py-1 pr-1 pl-1">
            <Avatar name={me.data.displayName} size={30} />
            <span className="hidden leading-tight sm:block">
              <span className="block text-[13px] font-medium text-ink">{me.data.displayName}</span>
              <span className="block text-[12px] text-ink-3">{humanize(me.data.role)}</span>
            </span>
          </div>
          <a href="/cdn-cgi/access/logout" className="ml-1 grid size-9 place-items-center rounded-full text-ink-2 transition-colors hover:bg-fill" aria-label="Sign out" title="Sign out">
            <Icon name="logout" />
          </a>
        </header>
        <main id="main" className="mx-auto max-w-6xl px-4 py-8 sm:px-8 lg:px-10 lg:py-10">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export function EntityLink({ type, id, children }: { type: string | null; id: string | null; children?: React.ReactNode }) {
  if (!id) return null;
  if (type === "client") return <Link to="/admin/clients/$clientId" params={{ clientId: id }} className="link">{children ?? "Open client"}</Link>;
  if (type === "letter") return <Link to="/admin/letters/$letterId" params={{ letterId: id }} className="link">{children ?? "Open letter"}</Link>;
  return <span className="text-ink-3">{humanize(type ?? "")}</span>;
}

export function LetterTable({ letters, showClient = true }: { letters: LetterSummary[]; showClient?: boolean }) {
  if (!letters.length) return <div className="rounded-2xl bg-surface shadow-card"><Empty icon="letter">No letters here.</Empty></div>;
  return (
    <Table caption="Letters">
      <thead>
        <tr>
          {showClient && <th>Client</th>}
          <th>Recipient</th>
          <th>Round</th>
          <th>Status</th>
          <th>Created</th>
          <th>Response due</th>
        </tr>
      </thead>
      <tbody>
        {letters.map((l) => (
          <tr key={l.id}>
            {showClient && (
              <td>
                <Link to="/admin/clients/$clientId" params={{ clientId: l.clientId }} className="hover:underline">
                  {l.clientName}
                </Link>
              </td>
            )}
            <td>
              <Link to="/admin/letters/$letterId" params={{ letterId: l.id }} className="font-medium text-ink hover:text-accent-ink">
                {l.targetName}
              </Link>
            </td>
            <td>{l.roundNumber}</td>
            <td>
              <StatusChip status={l.status} />
            </td>
            <td className="whitespace-nowrap">{fmtDate(l.createdAt)}</td>
            <td className="whitespace-nowrap">{fmtDate(l.responseDueAt)}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export const useLetters = (status?: string) => useQuery({ queryKey: ["letters", status ?? ""], queryFn: () => api<LetterSummary[]>(`/letters${qs({ status })}`) });
const useTasks = (assignee?: string, status?: string) => useQuery({ queryKey: ["tasks", assignee ?? "", status ?? ""], queryFn: () => api<TaskDto[]>(`/tasks${qs({ assignee, status })}`) });

export function Dashboard() {
  const can = useCan();
  const me = useStaffMe();
  const tasks = useTasks("me", "open");
  const pending = useLetters("pending_approval");
  const overdue = useLetters("overdue");
  const ready = useLetters("ready_to_mail");
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const first = me.data?.displayName.split(" ")[0] ?? "";
  const count = (q: { data?: unknown[] }) => (q.data ? q.data.length : "–");
  return (
    <>
      <PageHeader eyebrow={new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })} title={`${greeting}, ${first}`} />
      <div className="mb-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="My open tasks" value={count(tasks)} icon="check" tone="blue" />
        <Stat label="Awaiting approval" value={count(pending)} icon="clock" tone="indigo" />
        <Stat label="Ready to mail" value={count(ready)} icon="letter" tone="green" />
        <Stat label="Overdue responses" value={count(overdue)} icon="alert" tone={overdue.data?.length ? "red" : "gray"} />
      </div>
      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <Card title="My open tasks" actions={<Link to="/admin/tasks" className="text-[14px] font-medium text-accent-ink hover:underline">See all</Link>}>
          <Q q={tasks}>{(ts) => <TaskList tasks={ts.slice(0, 8)} />}</Q>
        </Card>
        <Card title="Recent activity">
          <NotificationList base="" limit={8} />
        </Card>
      </div>
      {can("letter:approve") && (
        <section className="mt-8">
          <h2 className="mb-3 text-[20px] font-semibold tracking-[-0.02em]">Awaiting your approval</h2>
          <Q q={pending}>{(ls) => <LetterTable letters={ls} />}</Q>
        </section>
      )}
      <section className="mt-8">
        <h2 className="mb-3 text-[20px] font-semibold tracking-[-0.02em]">Overdue responses</h2>
        <Q q={overdue}>{(ls) => <LetterTable letters={ls} />}</Q>
      </section>
    </>
  );
}

function TaskList({ tasks }: { tasks: TaskDto[] }) {
  const qc = useQueryClient();
  const can = useCan();
  const toggle = useMutation({
    mutationFn: (t: TaskDto) => patch(`/tasks/${t.id}`, { status: t.status === "open" ? "done" : "open" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });
  if (!tasks.length) return <Empty icon="check">You are all caught up.</Empty>;
  return (
    <ul className="divide-y divide-line">
      {tasks.map((t) => (
        <li key={t.id} className="flex flex-wrap items-center gap-3 py-3 text-[14px] first:pt-0 last:pb-0">
          <div className="min-w-0 flex-1">
            <p className={t.status === "done" ? "text-ink-3 line-through" : "font-medium text-ink"}>{t.title}</p>
            <p className="mt-0.5 text-[13px] text-ink-3">
              {t.assigneeName}
              {t.dueAt && ` · due ${fmtDate(t.dueAt)}`} <EntityLink type={t.entityType} id={t.entityId} />
            </p>
          </div>
          {t.dueAt && t.status === "open" && t.dueAt < Date.now() && <StatusChip status="overdue" />}
          {can("task:write") && (
            <Button small variant="secondary" busy={toggle.isPending && toggle.variables?.id === t.id} onClick={() => toggle.mutate(t)}>
              {t.status === "open" ? "Mark done" : "Reopen"}
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

export function TasksPage() {
  const can = useCan();
  const me = useStaffMe();
  const users = useUsers();
  const qc = useQueryClient();
  const [scope, setScope] = useState<"me" | "all">("me");
  const [status, setStatus] = useState<"open" | "done">("open");
  const tasks = useTasks(scope === "me" ? "me" : undefined, status);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const create = useMutation({ mutationFn: (b: unknown) => post<TaskDto>("/tasks", b), onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }) });
  return (
    <>
      <PageHeader title="Tasks" />
      {can("task:write") && (
        <Card title="New task" className="mb-4">
          <form
            noValidate
            className="grid gap-3 md:grid-cols-[1fr_14rem_10rem_auto] md:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
              const r = taskCreate.safeParse({ title: f.title, assigneeId: f.assigneeId, dueAt: f.dueAt || undefined });
              setErrors(r.success ? {} : issuesToMap(r.error.issues));
              if (r.success) create.mutate(r.data, { onSuccess: () => (e.target as HTMLFormElement).reset() });
            }}
          >
            <Input label="Title" name="title" error={errors.title} />
            <Select key={users.data?.length ?? 0} label="Assignee" name="assigneeId" defaultValue={me.data?.id} error={errors.assigneeId} options={(users.data ?? []).filter((u) => u.status === "active").map((u) => ({ value: u.id, label: u.displayName }))} />
            <Input label="Due" name="dueAt" type="date" min={todayIso()} error={errors.dueAt} />
            <Button type="submit" busy={create.isPending}>
              Add task
            </Button>
            <div className="md:col-span-4">
              <ErrorText error={create.error} />
            </div>
          </form>
        </Card>
      )}
      <div className="flex flex-wrap items-end gap-4">
        <Tabs label="Whose tasks" tabs={[{ id: "me", label: "Mine" }, { id: "all", label: "Everyone" }]} value={scope} onChange={setScope} />
        <div className="mb-4 w-40">
          <Select label="Status" srOnlyLabel value={status} onChange={(e) => setStatus(e.target.value as "open" | "done")} options={["open", "done"]} />
        </div>
      </div>
      <div role="tabpanel" id={`panel-${scope}`} aria-labelledby={`tab-${scope}`}>
        <Card>
          <Q q={tasks}>{(ts) => <TaskList tasks={ts} />}</Q>
        </Card>
      </div>
    </>
  );
}

/** Audit entries with cursor paging; used on client detail and the admin audit page. */
export function AuditList({ filters }: { filters: { entityType?: string; entityId?: string; from?: string; to?: string } }) {
  const q = useInfiniteQuery({
    queryKey: ["audit", filters],
    queryFn: ({ pageParam }) => api<Page<AuditEntryDto>>(`/audit${qs({ ...filters, cursor: pageParam })}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <ErrorText error={q.error} />;
  const rows = q.data.pages.flatMap((p) => p.items);
  if (!rows.length) return <Empty>No audit entries.</Empty>;
  return (
    <div className="space-y-3">
      <Table caption="Audit entries">
        <thead>
          <tr>
            <th>When</th>
            <th>Actor</th>
            <th>Action</th>
            <th>Entity</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="whitespace-nowrap">{fmtDateTime(r.createdAt)}</td>
              <td>{r.actorName ?? humanize(r.actorKind)}</td>
              <td className="font-mono text-xs">{r.action}</td>
              <td className="text-xs">
                {r.entityType}
                {r.entityId && <span className="block font-mono text-ink-3">{r.entityId}</span>}
              </td>
              <td>
                {r.diff != null && (
                  <details>
                    <summary className="cursor-pointer text-xs text-accent-ink">View</summary>
                    <pre className="mt-1 max-w-md overflow-x-auto rounded bg-fill p-2 text-xs">{JSON.stringify(r.diff, null, 2)}</pre>
                  </details>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      {q.hasNextPage && (
        <Button variant="secondary" busy={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
          Load more
        </Button>
      )}
    </div>
  );
}
