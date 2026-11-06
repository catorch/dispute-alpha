/** Typed fetch client for /api/v1. Errors come back as `{ error: { code, message, details? } }`. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
    /** Raw response body, for endpoints like the edit lock that answer 409 with a non-error payload. */
    public body?: unknown,
  ) {
    super(message);
  }
}

type Opts = { method?: string; body?: unknown; form?: FormData; keepalive?: boolean };

/** Where to send someone whose session is gone. Auth endpoints report their own 401s inline. */
export function unauthorizedTarget(path: string, code: string): string | null {
  if (path.startsWith("/auth/")) return null;
  if (path.startsWith("/portal")) return "/login";
  return code === "session_expired" || code === "unauthenticated" ? "/cdn-cgi/access/logout" : null;
}

export async function api<T>(path: string, opts: Opts = {}): Promise<T> {
  const hasJson = opts.body !== undefined;
  const res = await fetch(`/api/v1${path}`, {
    method: opts.method ?? (hasJson || opts.form ? "POST" : "GET"),
    credentials: "same-origin",
    keepalive: opts.keepalive,
    headers: { accept: "application/json", ...(hasJson && { "content-type": "application/json" }) },
    body: opts.form ?? (hasJson ? JSON.stringify(opts.body) : undefined),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = data?.error;
    const err = new ApiError(res.status, e?.code ?? "http_error", e?.message ?? `Request failed (${res.status})`, e?.details, data);
    if (res.status === 401) {
      const to = unauthorizedTarget(path, err.code);
      if (to && location.pathname !== to) location.assign(to);
    }
    throw err;
  }
  return data as T;
}

export const post = <T>(path: string, body: unknown = {}) => api<T>(path, { body });
export const patch = <T>(path: string, body: unknown) => api<T>(path, { method: "PATCH", body });
export const del = <T>(path: string, body?: unknown) => api<T>(path, { method: "DELETE", body });
export const upload = <T>(path: string, file: File, type: string) => {
  const form = new FormData();
  form.set("file", file);
  form.set("type", type);
  return api<T>(path, { form });
};

/** Builds `?a=1&b=2`, skipping empty values. */
export function qs(params: Record<string, string | undefined | null>): string {
  const s = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1])).toString();
  return s ? `?${s}` : "";
}

export const staffDownload = (documentId: string) => `/api/v1/documents/${documentId}/download`;
export const portalDownload = (documentId: string) => `/api/v1/portal/documents/${documentId}/download`;

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong");
