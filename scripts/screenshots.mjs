// Regenerates the README screenshots in docs/screenshots.
// Boots nothing itself: start an isolated stack first, then run this against it:
//   E2E_PORT=8788 E2E_STATE=/tmp/da-shots E2E_LOG=/tmp/da-shots.log bash scripts/e2e-server.sh &
//   node scripts/screenshots.mjs docs/screenshots /tmp/da-shots.log /tmp/da-shots
// It builds a demo organization ("Summit Credit Partners") through the real API. A few letter states
// that need Cloudflare's hosted browser (rendered PDFs) are set directly in the local database.
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";
const [OUT, LOG, STATE] = process.argv.slice(2);
const B = "http://localhost:8788";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const as = (who) => ({ "x-dev-staff-email": who, "content-type": "application/json" });
const ADMIN = "admin@local.test", MAYA = "staff@local.test", DANIEL = "approver@local.test";
async function api(method, path, body, who = MAYA) {
  const r = await fetch(`${B}/api/v1${path}`, { method, headers: as(who), body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${t}`);
  return t ? JSON.parse(t) : null;
}
const sql = (q) => execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "-c", "apps/app/wrangler.jsonc", "--persist-to", STATE, "--command", q], { stdio: "pipe" });
const totp = (secret, t = Date.now()) => { const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; let bits = ""; for (const c of secret) bits += a.indexOf(c).toString(2).padStart(5, "0"); const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2))); const m = Buffer.alloc(8); m.writeBigUInt64BE(BigInt(Math.floor(t / 30000))); const h = createHmac("sha1", key).update(m).digest(); return String((h.readUInt32BE(h[h.length - 1] & 15) & 0x7fffffff) % 1e6).padStart(6, "0"); };
const DAY = 864e5;

// ---------- organization and people ----------
await fetch(`${B}/api/v1/dev/seed`, { method: "POST" });
const users = await api("GET", "/users", undefined, ADMIN);
const id = (email) => users.find((u) => u.email === email).id;
await api("PATCH", `/users/${id(ADMIN)}`, { displayName: "Priya Raman" }, ADMIN);
await api("PATCH", `/users/${id(MAYA)}`, { displayName: "Maya Chen" }, ADMIN);
await api("PATCH", `/users/${id(DANIEL)}`, { displayName: "Daniel Ortiz" }, ADMIN);
await api("PATCH", "/org/settings", { senderBlock: { name: "Summit Credit Partners", addressLines: ["500 Congress Ave, Suite 1200", "Austin, TX 78701"] } }, ADMIN);
sql("UPDATE organization SET name = 'Summit Credit Partners'");
// The local seed's placeholder client becomes a realistic record.
sql("UPDATE client SET first_name = 'Nina', last_name = 'Patel', email = 'nina.patel@example.com', ssn_last4 = '3852' WHERE email = 'client@local.test'");
sql("UPDATE client_account SET email = 'nina.patel@example.com' WHERE email = 'client@local.test'");

// ---------- clients ----------
const people = [
  ["Jordan", "Avery", "220 Lavaca St", "1988-07-21"],
  ["Elena", "Morales", "1401 S Congress Ave", "1979-02-11"],
  ["Aisha", "Khan", "3001 Guadalupe St", "1992-10-03"],
  ["Marcus", "Bell", "8800 Burnet Rd", "1984-05-30"],
  ["Sofia", "Lindqvist", "601 W 6th St", "1995-12-17"],
  ["Thomas", "Reed", "4500 Duval St", "1971-08-08"],
];
const C = {};
for (const [i, [first, last, line1, dob]] of people.entries()) {
  const c = await api("POST", "/clients", { firstName: first, lastName: last, email: `${first.toLowerCase()}.${last.toLowerCase()}@example.com`, phone: `+1512555014${i}`, dob, ssn: `52${i}-4${i}-${String(3810 + i * 7)}`, address: { line1, city: "Austin", state: "TX", zip: "78701" } });
  C[first] = c.id;
  await sleep(30);
}
for (const n of ["Jordan", "Elena", "Aisha", "Sofia"]) await api("POST", `/clients/${C[n]}/status`, { status: "active" });
await api("POST", `/clients/${C.Thomas}/status`, { status: "active" });
await api("POST", `/clients/${C.Thomas}/status`, { status: "paused" });
await api("POST", `/clients/${C.Marcus}/assign`, { staffId: id(DANIEL) }, ADMIN);

// Signed authorizations via the e-sign webhook (fake provider locally).
for (const n of ["Jordan", "Elena", "Aisha"]) {
  const s = await api("POST", `/clients/${C[n]}/authorization/send`, {});
  const body = JSON.stringify({ eventId: `evt-${n}-${Date.now()}`, providerRequestId: s.providerRequestId, type: "signed" });
  const r = await fetch(`${B}/api/v1/webhooks/esign`, { method: "POST", headers: { "content-type": "application/json", "x-fake-signature": createHmac("sha256", "fake-esign-secret").update(body).digest("hex") }, body });
  if (!r.ok) throw new Error("esign " + r.status);
}
await api("POST", `/clients/${C.Sofia}/authorization/send`, {});

// Credit report imports (real workflows).
for (const n of ["Jordan", "Elena", "Aisha"]) await api("POST", `/clients/${C[n]}/reports/import`, {});
const reportOf = {};
for (const n of ["Jordan", "Elena", "Aisha"]) {
  for (let i = 0; i < 60; i++) { const r = (await api("GET", `/clients/${C[n]}/reports`))[0]; if (r?.status === "complete") { reportOf[n] = r.id; break; } await sleep(1000); }
  if (!reportOf[n]) throw new Error("import did not complete for " + n);
}

// A scanned document.
const f = new FormData(); f.set("type", "proof_of_address"); f.set("file", new File(["%PDF-1.4\n% utility bill\n%%EOF\n"], "utility-bill-october.pdf"));
await fetch(`${B}/api/v1/clients/${C.Jordan}/documents`, { method: "POST", headers: { "x-dev-staff-email": MAYA }, body: f });
const g = new FormData(); g.set("type", "government_id"); g.set("file", new File(["%PDF-1.4\n% id\n%%EOF\n"], "drivers-license.pdf"));
await fetch(`${B}/api/v1/clients/${C.Jordan}/documents`, { method: "POST", headers: { "x-dev-staff-email": MAYA }, body: g });

// Notes and tasks.
await api("POST", `/clients/${C.Jordan}/notes`, { body: "Spoke with Jordan. Priority is the Midwest Recovery collection; he paid it in 2022 and has the receipt." });
const due = (d) => new Date(Date.now() + d * DAY).toISOString().slice(0, 10);
await api("POST", "/tasks", { title: "Request payoff receipt for Midwest Recovery", assigneeId: id(MAYA), entityType: "client", entityId: C.Jordan, dueAt: due(2) });
await api("POST", "/tasks", { title: "Collect ID and proof of address from Sofia", assigneeId: id(MAYA), entityType: "client", entityId: C.Sofia, dueAt: due(4) });
await api("POST", "/tasks", { title: "Review Experian personal-information mismatch", assigneeId: id(MAYA), entityType: "client", entityId: C.Aisha, dueAt: due(6) });

// Dispute rounds and letters in several states.
const tpl = (await api("GET", "/templates"))[0];
const round = async (n) => { const items = await api("GET", `/reports/${reportOf[n]}/items`); return api("POST", `/clients/${C[n]}/dispute-rounds`, { itemIds: items.filter((i) => i.flags.length).map((i) => i.id), targetKind: "bureau", templateId: tpl.id }); };
const jr = await round("Jordan");   // 3 letters
const er = await round("Elena");
const ar = await round("Aisha");
await api("POST", `/letters/${jr.letterIds[0]}/submit`, {});            // pending approval
await api("POST", `/letters/${ar.letterIds[0]}/submit`, {});            // pending approval
const now = Date.now();
// Letters already approved and mailed earlier (PDF rendering needs Cloudflare's hosted browser, so set directly).
sql(`UPDATE letter SET status='ready_to_mail', locked_at=${now - 3 * DAY}, approved_by='${id(DANIEL)}', approved_at=${now - 3 * DAY} WHERE id='${jr.letterIds[1]}'`);
sql(`UPDATE letter SET status='overdue', locked_at=${now - 40 * DAY}, approved_by='${id(DANIEL)}', approved_at=${now - 40 * DAY}, sent_at=${now - 36 * DAY}, response_due_at=${now - 6 * DAY}, tracking_number='9400 1118 9922 3401 7764 21' WHERE id='${er.letterIds[0]}'`);
sql(`UPDATE letter SET status='ready_to_mail', locked_at=${now - DAY}, approved_by='${id(DANIEL)}', approved_at=${now - DAY} WHERE id='${ar.letterIds[1]}'`);
await api("POST", `/letters/${jr.letterIds[1]}/sent`, { sentAt: new Date(now - 2 * DAY).toISOString().slice(0, 10), trackingNumber: "9400 1118 9922 3401 5512 08" });

// Portal account for Jordan (real invite + authenticator enrollment).
await api("POST", `/clients/${C.Jordan}/invite`, {});
let token = "";
for (let i = 0; i < 30 && !token; i++) { await sleep(800); token = readFileSync(LOG, "utf8").split("[email:local]").reverse().find((b) => b.includes("to=jordan.avery@example.com") && b.includes("/invite/"))?.match(/\/invite\/([A-Za-z0-9_-]+)/)?.[1] ?? ""; }
// A second, untouched invite for the enrollment screenshot.
await api("POST", `/clients/${C.Sofia}/invite`, {});
let sofiaToken = "";
for (let i = 0; i < 30 && !sofiaToken; i++) { await sleep(800); sofiaToken = readFileSync(LOG, "utf8").split("[email:local]").reverse().find((b) => b.includes("to=sofia.lindqvist@example.com"))?.match(/\/invite\/([A-Za-z0-9_-]+)/)?.[1] ?? ""; }
await sleep(3000); // let queued notifications land

// ---------- screenshots ----------
const browser = await chromium.launch();
const shot = async (file, path, o = {}) => {
  const ctx = await browser.newContext({ viewport: o.mobile ? { width: 390, height: 844 } : { width: 1440, height: o.h ?? 900 }, deviceScaleFactor: 2, extraHTTPHeaders: o.who ? { "x-dev-staff-email": o.who } : {}, storageState: o.state });
  if (o.dark) await ctx.addInitScript(() => localStorage.setItem("da-theme", "dark"));
  const page = await ctx.newPage();
  await page.goto(B + path, { waitUntil: "load" });
  await page.waitForTimeout(1600);
  if (o.before) await o.before(page);
  await page.screenshot({ path: `${OUT}/${file}.png`, fullPage: !!o.full });
  await ctx.close();
  console.log("shot", file);
};
await shot("01-sign-in", "/login");
await shot("02-enroll-authenticator", `/invite/${sofiaToken}`, { before: async (p) => { await p.getByRole("button", { name: "Continue" }).click(); await p.waitForTimeout(900); } });
// Jordan's portal session.
const pctx = await browser.newContext();
const start = await (await pctx.request.post(`${B}/api/v1/auth/client/invite/${token}/start`, { data: { turnstileToken: "XXXX.DUMMY.TOKEN.XXXX", mfaType: "totp" } })).json();
const done = await pctx.request.post(`${B}/api/v1/auth/client/invite/${token}/complete`, { data: { password: "summit demo password", code: totp(start.secret) } });
if (!done.ok()) throw new Error("portal enroll " + done.status());
const state = await pctx.storageState(); await pctx.close();
await shot("03-portal-home", "/portal", { state });
await shot("04-portal-credit-report", "/portal/reports", { state });
await shot("05-portal-mobile", "/portal/letters", { state, mobile: true });
await shot("06-staff-dashboard", "/admin", { who: MAYA });
await shot("07-clients", "/admin/clients", { who: MAYA });
await shot("08-client-credit-report", `/admin/clients/${C.Jordan}?tab=reports`, { who: MAYA, h: 1100 });
await shot("09-new-dispute-round", `/admin/clients/${C.Aisha}?tab=letters`, { who: MAYA, before: async (p) => { await p.getByRole("button", { name: "New dispute round" }).click(); await p.waitForTimeout(700); } });
await shot("10-letter-editor", `/admin/letters/${jr.letterIds[2]}`, { who: MAYA, h: 1100 });
await shot("11-letter-approval", `/admin/letters/${jr.letterIds[0]}`, { who: DANIEL });
await shot("12-audit-log", "/admin/audit", { who: ADMIN });
await shot("13-dark-mode", `/admin/clients/${C.Jordan}?tab=reports`, { who: MAYA, dark: true });
await browser.close();
console.log("done");
