import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { NotificationDto } from "@da/shared";
import { useEffect, useId, useRef, useState } from "react";
import { api, post } from "../lib/api";
import { fmtDateTime, inAppPath } from "../lib/format";
import { Icon } from "./icons";
import { Button, Empty, Q } from "./ui";

/** `base` is "" for staff and "/portal" for clients; both expose the same notification endpoints. */
export function useNotifications(base: "" | "/portal") {
  const qc = useQueryClient();
  const queryKey = ["notifications", base];
  const q = useQuery({ queryKey, queryFn: () => api<NotificationDto[]>(`${base}/notifications`), refetchInterval: 60_000 });
  const markRead = useMutation({ mutationFn: (ids: string[] | "all") => post(`${base}/notifications/read`, { ids }), onSuccess: () => qc.invalidateQueries({ queryKey }) });
  return { q, markRead };
}

export function NotificationList({ base, limit, onNavigate }: { base: "" | "/portal"; limit?: number; onNavigate?: () => void }) {
  const { q, markRead } = useNotifications(base);
  const router = useRouter();
  const open = (n: NotificationDto) => {
    if (!n.readAt) markRead.mutate([n.id]);
    const path = n.link && inAppPath(n.link, location.origin);
    if (path) {
      router.history.push(path);
      onNavigate?.();
    }
  };
  return (
    <Q q={q}>
      {(items) =>
        items.length === 0 ? (
          <Empty icon="bell">No notifications yet.</Empty>
        ) : (
          <ul className="-mx-2 space-y-0.5">
            {items.slice(0, limit).map((n) => (
              <li key={n.id}>
                <button type="button" onClick={() => open(n)} className="flex w-full items-start gap-3 rounded-xl px-2.5 py-2.5 text-left text-[14px] transition-colors hover:bg-fill">
                  <span aria-hidden className={`mt-[7px] size-2 shrink-0 rounded-full ${n.readAt ? "bg-transparent" : "bg-accent"}`} />
                  <span className="min-w-0 flex-1">
                    <span className={n.readAt ? "text-ink-2" : "font-medium text-ink"}>{n.title}</span>
                    {!n.readAt && <span className="sr-only"> (unread)</span>}
                    <span className="mt-0.5 block text-[12px] text-ink-3">{fmtDateTime(n.createdAt)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )
      }
    </Q>
  );
}

export function NotificationsBell({ base }: { base: "" | "/portal" }) {
  const { q, markRead } = useNotifications(base);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const unread = q.data?.filter((n) => !n.readAt).length ?? 0;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className="relative grid size-9 place-items-center rounded-full text-ink-2 transition-colors hover:bg-fill"
        aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}
      >
        <Icon name="bell" className="size-[19px]" />
        {unread > 0 && <span className="absolute top-1 right-1 grid h-[17px] min-w-[17px] place-items-center rounded-full bg-neg-strong px-1 text-[10px] font-semibold text-white ring-2 ring-canvas">{unread > 99 ? "99+" : unread}</span>}
      </button>
      {open && (
        <div id={panelId} className="animate-in absolute right-0 z-40 mt-2 w-[min(24rem,calc(100vw-2rem))] rounded-2xl bg-elevated p-3 shadow-pop">
          <div className="mb-2 flex items-center justify-between pl-1">
            <h2 className="text-[15px] font-semibold">Notifications</h2>
            <Button variant="ghost" small disabled={!unread} busy={markRead.isPending} onClick={() => markRead.mutate("all")}>
              Mark all read
            </Button>
          </div>
          <div className="max-h-96 overflow-y-auto">
            <NotificationList base={base} onNavigate={() => setOpen(false)} />
          </div>
        </div>
      )}
    </div>
  );
}
