import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { auditRepo } from "@da/db";
import { app } from "../src/index";
import { sanitizeHtml } from "../src/lib/sanitize";
import type { ClientLock } from "../src/durable/client-lock";
import { Client, accessJwt, clientInput, db, makeEnv, seedOrg, staffClient } from "./helpers";

describe("health and headers (R7.5, R7.6, R23.5)", () => {
  it("reports binding health with security headers and no-store", async () => {
    const t = makeEnv();
    const res = await app.request("/api/v1/health", {}, t.env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, checks: { d1: true, r2: true, queue: true } });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("permissions-policy")).toContain("camera=()");
    expect(res.headers.get("content-security-policy")).toContain("default-src");
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  it("returns a JSON 404 for unknown API paths", async () => {
    const t = makeEnv();
    const s = await seedOrg(t);
    const res = await s.admin.client.get("/api/v1/nope");
    expect(res.status).toBe(404);
  });
});

describe("staff authentication via Access (R3)", () => {
  it("rejects missing and forged tokens", async () => {
    const t = makeEnv();
    expect((await app.request("/api/v1/me", {}, t.env)).status).toBe(401);
    const forged = (await accessJwt("x@y.z")).replace(/\.[^.]+$/, ".AAAA");
    expect((await app.request("/api/v1/me", { headers: { "cf-access-jwt-assertion": forged } }, t.env)).status).toBe(401);
  });

  it("rejects valid Access identities with no active user, and audits it", async () => {
    const t = makeEnv();
    const c = await staffClient(t, "stranger@else.test");
    const res = await c.get("/api/v1/me");
    expect(res.status).toBe(403);
    const rows = await env.DB.prepare("SELECT action FROM audit_log WHERE action = 'auth.staff.denied'").all();
    expect(rows.results.length).toBeGreaterThan(0);
  });

  it("maps the Access email to the user and role", async () => {
    const t = makeEnv();
    const s = await seedOrg(t);
    const me = await s.staff.client.json("GET", "/api/v1/me");
    expect(me).toMatchObject({ kind: "staff", role: "staff", email: s.staff.email });
    expect(me.permissions).not.toContain("user:write");
  });

  it("expires idle sessions after 30 minutes and requires a fresh Access login (R3.4)", async () => {
    const t = makeEnv();
    const s = await seedOrg(t);
    const c = s.staff.client;
    await c.json("GET", "/api/v1/me");
    await env.DB.prepare("UPDATE session SET expires_at = ? WHERE principal_id = ?").bind(Date.now() - 1000, s.staff.id).run();
    const expired = await c.get("/api/v1/me");
    expect(expired.status).toBe(401);
    expect((await expired.json<any>()).error.code).toBe("session_expired");
    // Same (old) Access token cannot open a new session...
    expect((await c.get("/api/v1/me")).status).toBe(401);
    // ...but a token issued after the expiry (fresh Access login) can.
    c.headers["cf-access-jwt-assertion"] = await accessJwt(s.staff.email, 5);
    expect((await c.get("/api/v1/me")).status).toBe(200);
  });

  it("deactivated users lose access immediately", async () => {
    const t = makeEnv();
    const s = await seedOrg(t);
    await s.staff.client.json("GET", "/api/v1/me");
    await s.admin.client.json("PATCH", `/api/v1/users/${s.staff.id}`, { status: "inactive" });
    expect((await s.staff.client.get("/api/v1/me")).status).toBe(403);
  });
});

describe("RBAC and org isolation (R5)", () => {
  it("enforces permissions and audits denials", async () => {
    const t = makeEnv();
    const s = await seedOrg(t);
    const res = await s.staff.client.post("/api/v1/users", { email: "new@acme.test", displayName: "New", role: "staff" });
    expect(res.status).toBe(403);
    const denied = await env.DB.prepare("SELECT entity_id FROM audit_log WHERE action = 'denied' AND actor_id = ?").bind(s.staff.id).first();
    expect(denied?.entity_id).toBe("user:write");
    await s.admin.client.json("POST", "/api/v1/users", { email: "new@acme.test", displayName: "New", role: "staff" }, 201);
  });

  it("never returns another organization's clients", async () => {
    const t = makeEnv();
    const a = await seedOrg(t, "Org A");
    const b = await seedOrg(t, "Org B");
    const created = await a.staff.client.json("POST", "/api/v1/clients", clientInput(), 201);
    expect((await b.staff.client.get(`/api/v1/clients/${created.id}`)).status).toBe(404);
    expect((await b.staff.client.get(`/api/v1/clients/${created.id}/pii`)).status).toBe(404);
    const list = await b.staff.client.json("GET", "/api/v1/clients");
    expect(list.items.find((x: { id: string }) => x.id === created.id)).toBeUndefined();
  });

  it("client sessions cannot reach staff routes", async () => {
    const t = makeEnv();
    const c = new Client(t);
    c.cookies.set("da_client", "whatever");
    expect((await c.get("/api/v1/clients")).status).toBe(401);
  });
});

describe("audit log (R19)", () => {
  it("exposes no update or delete path", () => {
    expect(Object.keys(auditRepo).sort()).toEqual(["exportRange", "insert", "query"]);
  });

  it("redacts PII in diffs", async () => {
    await auditRepo.insert(db(), [{ orgId: "o", actorKind: "system", action: "x", entityType: "t", diff: { ssn: "123456789", name: "ok" } }]);
    const row = await env.DB.prepare("SELECT diff_json FROM audit_log WHERE action = 'x'").first<{ diff_json: string }>();
    expect(row?.diff_json).not.toContain("123456789");
    expect(JSON.parse(row?.diff_json ?? "{}")).toEqual({ ssn: "[REDACTED]", name: "ok" });
  });
});

describe("database indexes (R20.3)", () => {
  it("has every required hot-path index", async () => {
    const want = ["client_org_status", "client_assigned", "report_item_report", "letter_status", "letter_due", "task_assignee_status", "audit_entity", "audit_created"];
    const rows = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all<{ name: string }>();
    const names = rows.results.map((r) => r.name);
    for (const w of want) expect(names).toContain(w);
  });
});

describe("sanitizer", () => {
  it("keeps formatting, drops scripts, handlers, and links", async () => {
    const out = await sanitizeHtml(`<p onclick="x()">Hi <strong>there</strong><script>alert(1)</script><a href="javascript:x">link</a><img src=x onerror=y></p><!-- c -->{{client.dob}}`);
    expect(out).toBe("<p>Hi <strong>there</strong>link</p>{{client.dob}}");
  });
});

describe("ClientLock durable object (R14.9)", () => {
  it("grants one holder, refuses others, releases, and expires leases", async () => {
    const stub = env.CLIENT_LOCK.get(env.CLIENT_LOCK.idFromName("client-x"));
    expect(await stub.acquire({ id: "u1", name: "One" })).toMatchObject({ ok: true });
    expect(await stub.acquire({ id: "u2", name: "Two" })).toMatchObject({ ok: false, holder: { id: "u1", name: "One" } });
    expect(await stub.acquire({ id: "u1", name: "One" })).toMatchObject({ ok: true });
    await stub.release("u2"); // not the holder: no effect
    expect((await stub.state())?.id).toBe("u1");
    await runInDurableObject(stub, async (_obj: ClientLock, state) => {
      await state.storage.put("holder", { id: "u1", name: "One", expiresAt: Date.now() - 1 });
    });
    expect(await stub.state()).toBeNull();
    expect(await stub.acquire({ id: "u2", name: "Two" })).toMatchObject({ ok: true });
    await stub.release("u2");
    expect(await stub.state()).toBeNull();
  });
});
