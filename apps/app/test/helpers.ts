import { env as baseEnv } from "cloudflare:workers";
import { SignJWT, importJWK } from "jose";
import { getDb, orgs } from "@da/db";
import { hmacSha256Hex } from "@da/crypto";
import type { NotifyMessage, Role } from "@da/shared";
import type { Env } from "../src/env";
import { app } from "../src/index";
import { TEST_TURNSTILE_TOKEN } from "../src/lib/turnstile";
import { totpAt } from "../src/lib/totp";

export const TURNSTILE = TEST_TURNSTILE_TOKEN;
export const db = () => getDb(baseEnv.DB);

/** Recording fakes for bindings the test runtime cannot host (cross-script Workflows) or that we assert on. */
export function makeEnv(over: Partial<Env> = {}) {
  const sent: Record<string, unknown[]> = { notify: [], scan: [], audit: [] };
  const wf = (name: string) => {
    const created: { id: string; params: unknown }[] = [];
    const events: { id: string; event: unknown }[] = [];
    const terminated: string[] = [];
    return {
      created,
      events,
      terminated,
      binding: {
        create: async (o: { id?: string; params: unknown }) => {
          const id = o.id ?? `${name}-${created.length}`;
          created.push({ id, params: o.params });
          return { id };
        },
        get: async (id: string) => ({
          id,
          terminate: async () => {
            terminated.push(id);
          },
          sendEvent: async (event: unknown) => {
            events.push({ id, event });
          },
        }),
      } as unknown as Workflow,
    };
  };
  const queue = (key: string) =>
    ({
      send: async (b: unknown) => {
        sent[key].push(b);
      },
      sendBatch: async (bs: { body: unknown }[]) => {
        for (const b of bs) sent[key].push(b.body);
      },
    }) as unknown as Queue;
  const wfs = { import: wf("import"), letter: wf("letter"), deadline: wf("deadline") };
  const limiter = { limit: async () => ({ success: true }) } as RateLimit;
  const env = {
    ...(baseEnv as unknown as Env),
    Q_NOTIFY: queue("notify"),
    Q_SCAN: queue("scan"),
    Q_AUDIT_EXPORT: queue("audit"),
    WF_IMPORT: wfs.import.binding,
    WF_LETTER: wfs.letter.binding,
    WF_DEADLINE: wfs.deadline.binding,
    AUTH_LIMIT: limiter,
    IMPORT_LIMIT: limiter,
    ...over,
  } as Env;
  return { env, sent, wfs, notifications: () => sent.notify as NotifyMessage[] };
}
export type TestEnv = ReturnType<typeof makeEnv>;

export async function accessJwt(email: string, iatOffsetSec = 0) {
  const key = await importJWK(JSON.parse(baseEnv.TEST_ACCESS_PRIVATE_JWK), "RS256");
  const now = Math.floor(Date.now() / 1000) + iatOffsetSec;
  return new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer("https://team.cloudflareaccess.com")
    .setAudience("test-aud")
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);
}

/** A tiny cookie-keeping HTTP client over app.request(). */
export class Client {
  cookies = new Map<string, string>();
  headers: Record<string, string> = {};
  constructor(public t: TestEnv) {}
  async req(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
    const h: Record<string, string> = { ...this.headers, ...extra };
    if (this.cookies.size) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      payload = JSON.stringify(body);
      h["content-type"] = "application/json";
    }
    const res = await app.request(path, { method, headers: h, body: payload }, this.t.env);
    for (const sc of res.headers.getSetCookie()) {
      const [pair, ...attrs] = sc.split(";");
      const [k, v] = pair.split("=");
      if (attrs.some((a) => /max-age=0/i.test(a)) || v === "") this.cookies.delete(k.trim());
      else this.cookies.set(k.trim(), v);
    }
    return res;
  }
  get = (p: string, h?: Record<string, string>) => this.req("GET", p, undefined, h);
  post = (p: string, b?: unknown, h?: Record<string, string>) => this.req("POST", p, b ?? {}, h);
  patch = (p: string, b?: unknown) => this.req("PATCH", p, b ?? {});
  del = (p: string, b?: unknown) => this.req("DELETE", p, b);
  async json<T = any>(method: string, path: string, body?: unknown, expect = 200): Promise<T> {
    const res = await this.req(method, path, body);
    const text = await res.text();
    if (res.status !== expect) throw new Error(`${method} ${path} → ${res.status} (expected ${expect}): ${text}`);
    return text ? JSON.parse(text) : (undefined as T);
  }
}

export async function staffClient(t: TestEnv, email: string) {
  const c = new Client(t);
  c.headers["cf-access-jwt-assertion"] = await accessJwt(email);
  return c;
}

let seq = 0;
/** Creates an org with an admin, plus optional staff and approver users. */
export async function seedOrg(t: TestEnv, name = "Acme Credit") {
  const n = ++seq;
  const admin = `admin${n}@acme.test`;
  const { orgId, adminId } = await orgs.createOrg(db(), name, { email: admin, displayName: `Admin ${n}` });
  const mk = async (role: Role, label: string) => {
    const u = await orgs.createUser(db(), orgId, { email: `${label}${n}@acme.test`, displayName: `${label} ${n}`, role });
    return { ...u, client: await staffClient(t, u.email) };
  };
  return {
    orgId,
    admin: { id: adminId, email: admin, client: await staffClient(t, admin) },
    staff: await mk("staff", "staff"),
    approver: await mk("approver", "approver"),
  };
}

export const clientInput = (over: Record<string, unknown> = {}) => ({
  firstName: "Ana",
  lastName: "Ruiz",
  email: `ana${++seq}@example.test`,
  phone: "+15125550100",
  dob: "1985-03-14",
  ssn: `123-45-${String(1000 + seq).slice(-4)}`,
  address: { line1: "1 Main St", city: "Austin", state: "TX", zip: "78701" },
  ...over,
});

/** Full invite → TOTP enrollment → portal session. Returns a logged-in portal client. */
export async function enrollClient(t: TestEnv, staff: Client, clientId: string, password = "correct horse battery staple") {
  await staff.json("POST", `/api/v1/clients/${clientId}/invite`, {}, 201);
  const msg = t.notifications().filter((m) => m.event === "invite").at(-1);
  const token = String(msg?.vars?.link).split("/invite/")[1];
  const portal = new Client(t);
  const start = await portal.json("POST", `/api/v1/auth/client/invite/${token}/start`, { turnstileToken: TURNSTILE, mfaType: "totp" });
  const code = await totpAt(start.secret, Math.floor(Date.now() / 30_000));
  await portal.json("POST", `/api/v1/auth/client/invite/${token}/complete`, { password, code });
  return { portal, secret: start.secret as string, token, password };
}

export const fakeSig = (secret: string, body: string) => hmacSha256Hex(secret, body);

export function pdfFile(name = "id.pdf", extra = "") {
  return new File([`%PDF-1.4\n% test ${extra}\n%%EOF\n`], name, { type: "application/pdf" });
}
export function form(file: File, type: string) {
  const f = new FormData();
  f.set("file", file);
  f.set("type", type);
  return f;
}
