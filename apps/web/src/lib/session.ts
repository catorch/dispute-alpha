import { useQuery } from "@tanstack/react-query";
import type { LockState, Me, Permission, UserDto } from "@da/shared";
import { useEffect, useState } from "react";
import { ApiError, api } from "./api";

export type StaffMe = Extract<Me, { kind: "staff" }>;
export type ClientMe = Extract<Me, { kind: "client" }>;

export const useStaffMe = () => useQuery({ queryKey: ["me"], queryFn: () => api<StaffMe>("/me"), staleTime: Number.POSITIVE_INFINITY });
export const usePortalMe = () => useQuery({ queryKey: ["portal", "me"], queryFn: () => api<ClientMe>("/portal/me"), staleTime: 60_000 });

/** UI-only permission check; the server enforces every permission again. */
export function useCan() {
  const { data } = useStaffMe();
  return (p: Permission) => !!data?.permissions.includes(p);
}

const LOCK_RENEW_MS = 2 * 60_000;
export type ClientLockState = { status: "acquiring" | "held" | "conflict" | "error"; holder?: { id: string; name: string } };

/**
 * Edit lease on a client (R14.9): acquire on mount, renew every 2 minutes, release on unmount.
 * While someone else holds it, the renew tick keeps retrying, so the editor unlocks when they leave.
 */
export function useClientLock(clientId: string, enabled = true): ClientLockState {
  const [state, setState] = useState<ClientLockState>({ status: "acquiring" });
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const acquire = () =>
      api<LockState>(`/clients/${clientId}/lock`, { method: "POST" })
        .then(() => alive && setState({ status: "held" }))
        .catch((e) => {
          if (!alive) return;
          const body = e instanceof ApiError ? (e.body as LockState | undefined) : undefined;
          setState(e instanceof ApiError && e.status === 409 && body && !body.ok ? { status: "conflict", holder: body.holder } : { status: "error" });
        });
    acquire();
    const t = setInterval(acquire, LOCK_RENEW_MS);
    return () => {
      alive = false;
      clearInterval(t);
      api(`/clients/${clientId}/lock`, { method: "DELETE", keepalive: true }).catch(() => {});
    };
  }, [clientId, enabled]);
  return state;
}

export const useUsers = () => useQuery({ queryKey: ["users"], queryFn: () => api<UserDto[]>("/users"), staleTime: 60_000 });
