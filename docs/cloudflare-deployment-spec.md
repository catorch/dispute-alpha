# Dispute Alpha: Cloudflare Deployment Specification

**Version:** 0.1 draft · **Date:** November 5, 2026

> This document replaces the AWS hosting and stack sections of the earlier main spec; features, roles, data model, and milestones in the main spec stay the same. The main spec is not yet checked into this repository.

## 1. Approach

The goal is to run as much of the platform on Cloudflare as possible: hosting, API, database, file storage, background jobs, PDF generation, email, secrets, and edge security. Only the services Cloudflare doesn't offer stay external: the credit monitoring provider, e-signature, SMS, and error tracking.

**Main changes from the AWS version**
- NestJS on containers becomes a Hono API on Workers (NestJS isn't a good fit for the Workers runtime).
- PostgreSQL on RDS becomes D1 (SQLite). Section 6 covers the trade-off and a Postgres fallback.
- Redis/BullMQ becomes Queues, Workflows, and Cron Triggers.
- Puppeteer on a server becomes Cloudflare's hosted headless browser.
- KMS becomes Secrets Store plus application-level encryption. Section 10 notes the gap.

**Plan required:** Workers Paid, the Cloudflare plan at $5 a month plus usage. Several services below need it.

## 2. Service Map

| Need | Cloudflare service | Notes |
|---|---|---|
| Web app hosting | Workers with Static Assets | React SPA served from the same Worker as the API |
| API | Workers (Hono framework, TypeScript) | Same origin as the web app, so no CORS setup |
| Database | D1 | Drizzle ORM, SQL migrations |
| File storage | R2 | Documents, raw reports, letter PDFs, backups |
| Background jobs | Queues | Notifications, import requests, PDF jobs |
| Multi-step processes | Workflows | Report import, letter pipeline, dispute deadlines |
| Scheduled jobs | Cron Triggers | Daily overdue sweep, digest emails, backups |
| PDF generation | Browser Run (formerly Browser Rendering) | Headless Chrome with Puppeteer |
| Virus scanning | Containers | ClamAV in a container |
| Transactional email | Email Service (Email Sending) | Beta; fallback provider noted below |
| Secrets | Secrets Store | API keys and encryption keys |
| Staff login / SSO | Cloudflare Access (Zero Trust) | Protects admin and staff areas |
| Bot protection | Turnstile | Login, invite, password reset |
| Rate limiting | Rate Limiting binding and WAF rate limiting rules | Auth and import endpoints |
| Edge security | WAF managed rules, DDoS protection, TLS | Default on the zone |
| Locks / realtime | Durable Objects | Per-client edit locks, optional live notifications |
| Metrics | Workers Analytics Engine | Business and operational metrics |
| Logs | Workers Logs, Tail Workers | Audit and error streams |
| DNS / domain | Cloudflare DNS and Registrar | Client-owned |

**External services (no Cloudflare equivalent):** credit monitoring API, e-signature (Dropbox Sign or DocuSign), SMS (Twilio), error tracking (Sentry), source control and CI (GitHub).

## 3. Architecture

```
                    ┌────────────────────────────────────────┐
  Browser ─────────►│ Cloudflare edge: DNS, TLS, WAF, DDoS,  │
                    │ Turnstile, rate limiting, Access       │
                    └───────────────────┬────────────────────┘
                                        ▼
                    ┌────────────────────────────────────────┐
                    │ Worker: da-app                          │
                    │  • Static assets (React SPA)           │
                    │  • /api/* → Hono API                    │
                    │    - auth, RBAC, org scoping            │
                    │    - audit middleware                   │
                    │    - field encryption                   │
                    └──┬──────┬──────┬──────┬──────┬─────────┘
                       │      │      │      │      │
                       ▼      ▼      ▼      ▼      ▼
                      D1     R2   Queues  Workflows  Durable Objects
                                     │      │
                    ┌────────────────▼──────▼────────────────┐
                    │ Worker: da-jobs                         │
                    │  • Queue consumers                      │
                    │  • Workflow classes                     │
                    │  • Cron Triggers                        │
                    └──┬──────────┬──────────┬────────────┬──┘
                       ▼          ▼          ▼            ▼
              Credit monitoring  Browser Run  Email Service  Container:
              API (external)     (PDFs)       / Twilio       ClamAV scanner
```

**Why two Workers:** `da-app` handles user requests and stays fast. `da-jobs` handles slow or retryable work. They share D1, R2, and Secrets Store bindings, and the app triggers jobs through Queues and Workflow bindings.

## 4. Application Stack Changes

| Layer | Choice | Reason |
|---|---|---|
| Frontend | React with Vite, TanStack Router, TanStack Query, Tailwind, shadcn/ui | A logged-in dashboard doesn't need server rendering. A SPA on Static Assets is the simplest, most stable option on Workers. |
| API | Hono on Workers | Lightweight, built for Workers, middleware for auth, validation, and RBAC |
| Validation | Zod (shared between frontend and API) | One schema for forms and endpoints |
| ORM | Drizzle with the D1 driver | First-class D1 support, typed queries, SQL migrations |
| Auth (clients) | Better Auth or custom sessions on D1 | Email/password, TOTP MFA, invite links |
| Auth (staff) | Cloudflare Access with Google Workspace or Microsoft 365 SSO, plus app sessions | MFA enforced by the identity provider |
| Templates | TipTap editor, Handlebars-style merge fields | Unchanged |
| PDF | `@cloudflare/puppeteer` | Hosted browser, no servers to run |
| Testing | Vitest with the Workers test pool, Playwright for E2E | Tests run inside the Workers runtime |

**About Next.js:** If server rendering becomes important later, note that Cloudflare now recommends vinext rather than OpenNext for new Next.js apps on Workers. However, vinext's own documentation warns of compatibility gaps, particularly in newer App Router features. For a financial MVP, the plain React SPA avoids that risk.

## 5. Workers Layout

**`da-app` routes**
- `/*` → static SPA assets, with SPA fallback to `index.html`
- `/api/v1/*` → Hono API (all endpoints from the main spec)
- `/api/v1/webhooks/*` → e-sign and credit provider webhooks, verified by signature and excluded from Access
- `/admin/*` and staff API routes → behind Cloudflare Access

**`da-jobs` handlers**
- `queue()` consumers: `notifications`, `pdf-render`, `doc-scan`, `audit-export`
- Workflow classes: `ReportImportWorkflow`, `LetterPipelineWorkflow`, `DisputeDeadlineWorkflow`
- `scheduled()` cron: daily at 06:00 for the overdue sweep and digests, nightly at 03:00 for the D1 export to R2

## 6. Database (D1)

**Setup**
- One production database, `da-prod`, plus `da-staging`. Create them with a North America location hint.
- Schema from the main spec, ported to SQLite types: UUIDs as `TEXT`, timestamps as ISO `TEXT` or integer epoch, JSON columns as `TEXT` with JSON functions.
- Migrations in `/migrations`, applied with `wrangler d1 migrations apply` in CI.

**Sizing**
- D1 has a 10 GB maximum per database on Workers Paid, and Cloudflare states that limit cannot be increased.
- That's enough for this app because large files never go in the database. Raw credit reports, documents, and PDFs live in R2, and D1 holds only structured data. At 5,000 clients with about 150 report items per import and several imports each, the database should stay well under 2 GB.
- Watch growth in the monthly ops review. If needed, split `audit_log` into its own D1 database first.

**Performance rules**
- Each D1 database is single-threaded and runs queries one at a time, so every query on a hot path needs an index. Full table scans block other requests.
- Required indexes: `client(org_id, status)`, `client(assigned_staff_id)`, `report_item(report_id)`, `letter(status)`, `letter(response_due_at)`, `task(assignee_id, status)`, `audit_log(entity_type, entity_id)`, `audit_log(created_at)`.
- Large updates and deletes run in batches, as D1 rejects single queries that modify hundreds of thousands of rows at once.
- Use `db.batch()` for multi-statement writes, so related inserts commit together.

**Backups**
- Time Travel is always on and lets you restore to any minute in the last 30 days.
- Nightly cron exports D1 to the `da-backups` R2 bucket for retention beyond 30 days. Cloudflare documents this export pattern using the REST API and Workflows.
- Restores are tested into a separate database each quarter, never directly over production.

**Postgres fallback:** If the client or a future auditor requires PostgreSQL, swap D1 for an external managed Postgres (Neon, Supabase, or RDS) accessed through Hyperdrive. Drizzle supports both, so the change is mostly configuration and schema types. This is the main thing that would leave Cloudflare.

## 7. File Storage (R2)

| Bucket | Contents | Retention |
|---|---|---|
| `da-documents` | Client uploads: ID, proof of address, bureau responses | Life of client plus retention policy |
| `da-reports-raw` | Raw provider payloads, encrypted before upload | Per provider contract |
| `da-letters` | Approved letter PDFs | Life of client plus retention policy |
| `da-backups` | Nightly D1 exports | 1 year, lifecycle rule deletes older |
| `da-quarantine` | Uploads pending virus scan | 7 days |

**Rules**
- All buckets private, no public access, no `r2.dev` URLs.
- Files are downloaded through the API: `GET /api/v1/documents/:id/download` checks permission, writes an audit entry, and streams from R2. This is preferred over presigned URLs so every access is authorized and logged.
- Uploads go to `da-quarantine` first, a `doc-scan` job scans them, and clean files move to `da-documents`.
- Sensitive files (raw reports, ID images) get application-level encryption before upload, on top of R2's encryption at rest.
- Object keys use IDs, never names or SSNs: `org/{orgId}/client/{clientId}/doc/{docId}`.

## 8. Background Processing

**Queues**

| Queue | Producer | Consumer action | Retries / DLQ |
|---|---|---|---|
| `notifications` | API, workflows, cron | Send email, SMS, in-app | 5 retries, then `notifications-dlq` |
| `pdf-render` | Letter workflow | Render PDF, save to R2 | 3 retries, then DLQ and alert |
| `doc-scan` | Upload endpoint | Send file to ClamAV container | 3 retries, then quarantine stays |
| `audit-export` | Admin export request | Build CSV in R2 | 3 retries |

**Workflows**

Workflows fit this app well because they chain multiple steps, retry failed tasks automatically, and keep state for minutes, hours, or weeks.

1. **`ReportImportWorkflow`**
   `request report from provider` → `poll or wait for webhook` → `store raw payload in R2` → `parse and normalize` → `write report items to D1` → `run flagging rules` → `notify staff and client`. Each step retries on its own, so a provider timeout doesn't restart the whole import.

2. **`LetterPipelineWorkflow`**
   `wait for approval event` → `render PDF` → `attach supporting documents` → `save to R2` → `set status to Ready to Mail` → `notify staff`. Workflows can pause until an external event such as an approval arrives, which maps directly to the required approval step.

3. **`DisputeDeadlineWorkflow`** (one per sent letter)
   `sleepUntil(due date minus 7 days)` → `remind` → `sleepUntil(minus 3 days)` → `remind` → `sleepUntil(due date)` → `if no response logged, flag overdue and create a task`. If a response is logged early, the workflow is terminated. Workflows support sleeping for seconds, hours, or days with `step.sleep()` and `step.sleepUntil()`.

**Cron Triggers**
- `0 11 * * *` (06:00 Panama / US Eastern Standard) overdue sweep as a safety net, plus the staff daily digest.
- `0 8 * * *` nightly D1 export to R2.
- `0 9 * * 1` weekly cleanup: expired invites, quarantine older than 7 days.

## 9. PDF Generation and Virus Scanning

**PDFs (Browser Run)**
- The `da-jobs` Worker binds the browser, loads the letter HTML with print CSS, and calls `page.pdf()`. Cloudflare's guide shows this flow: render HTML and CSS in the hosted browser and generate the file with `page.pdf()`.
- Letter HTML is built from the approved, locked letter body. The browser loads no remote URLs, so all fonts and images are inlined.
- Letter size, 1-inch margins, page numbers in the footer.
- Browser sessions are reused within a batch to cut startup time.

**Virus scanning (Containers)**
- ClamAV runs in a Cloudflare Container that the `doc-scan` consumer calls. Containers are now generally available and can run CLI tools that need a full Linux environment.
- Signature updates on container start plus a daily refresh.
- If the scanner is down, files stay in quarantine and staff see "Scan pending". They are never released unscanned.

## 10. Authentication, Secrets, and Encryption

**Staff and admins**
- Cloudflare Access protects staff routes. Login goes through the company's identity provider (Google Workspace or Microsoft 365) with MFA required there.
- The API validates the `Cf-Access-Jwt-Assertion` header on every staff request and maps the email to a `user` record and role. Access confirms identity; the app still enforces RBAC.
- Optional: an Access policy limiting staff access to company devices or countries.

**Clients**
- Email and password with Argon2id or scrypt hashing (Workers-compatible implementation), TOTP or email-code MFA, invite-only signup.
- Sessions: secure, httpOnly, SameSite=Lax cookies; session records in D1; 30-minute idle timeout for staff, 60 for clients.
- Turnstile on login, invite acceptance, and password reset.
- Rate limits: 5 login attempts per minute per IP and per account, then lockout after 10 failures.

**Secrets (Secrets Store)**
- All API keys (credit provider, e-sign, Twilio, Sentry, email) and encryption keys live in Secrets Store. Secrets there are account-level, encrypted, and stored across Cloudflare's data centers.
- A secret can be bound into many Workers and rotated without redeploying them, which is useful since both Workers share keys.
- Developers get the Secrets Store Deployer role, not Admin, so they can bind secrets without reading them.

**Field-level encryption**
- SSN, DOB, full account numbers, and raw report payloads are encrypted with AES-256-GCM using the Web Crypto API in the Worker.
- Keys are versioned (`ENC_KEY_V1`, `ENC_KEY_V2`). Each ciphertext stores its key version, so keys can be rotated with a background re-encryption job.
- SSN last 4 digits are stored separately for display and search. A keyed HMAC of the SSN allows duplicate checks without decrypting.

**Known gap:** Cloudflare has no direct equivalent to AWS KMS with HSM-backed keys and per-use audit logs. Secrets Store plus app-level encryption is reasonable for an MVP. If a future security review requires an HSM-backed KMS, the encryption module can call an external KMS (AWS KMS or Google Cloud KMS) to unwrap a data key, cached in memory per Worker instance. The code should isolate encryption in one module so this swap is small.

## 11. Edge Security Configuration

**Zone settings**
- SSL/TLS mode: Full (strict); minimum TLS 1.2; Always Use HTTPS; HSTS with preload once stable.
- WAF: Cloudflare Managed Ruleset and OWASP Core Ruleset on, in log mode for one week, then blocking.
- Custom WAF rules: block requests to `/api/v1/webhooks/*` unless they come from provider IP ranges (where providers publish them); challenge suspicious countries on auth endpoints if traffic is US-only.
- Rate limiting rules on `/api/v1/auth/*` and `/api/v1/clients/*/reports/import`.
- Bot Fight Mode on.

**Response headers (set by the Worker)**
- `Content-Security-Policy` with `default-src 'self'`, no inline scripts, Turnstile domain allowed
- `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` locking down camera, microphone, and geolocation
- `Cache-Control: no-store` on all `/api/*` responses so sensitive data is never cached at the edge

## 12. Email, SMS, and Notifications

- **Email:** Cloudflare Email Service through a Workers binding. Note that Email Sending is still in beta, and its features and APIs may change before general availability. Wrap sending in an `EmailSender` interface with a Postmark implementation as fallback, switchable by config.
- **Domain:** send from `notify.<clientdomain>.com` with SPF, DKIM, and DMARC (start at `p=none`, move to `quarantine`).
- **Email content:** never include SSNs, account numbers, or report details. Emails say "You have an update" and link to the portal.
- **SMS:** Twilio, opt-in only, STOP handling, same no-sensitive-data rule.
- **In-app:** notifications stored in D1. Optional live updates through a per-user Durable Object with WebSockets (Phase 2).

## 13. Durable Objects

- **`ClientLock`** (one per client): prevents two staff members from editing the same dispute round or letter at the same time. It holds a short lease and shows "Being edited by…" in the UI.
- **`UserNotifications`** (optional, Phase 2): live notification push over WebSocket.

## 14. Configuration Example

```jsonc
// apps/app/wrangler.jsonc (da-app)
{
  "name": "da-app",
  "main": "src/index.ts",
  "compatibility_date": "2026-11-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "directory": "../web/dist", "not_found_handling": "single-page-application", "run_worker_first": ["/api/*"] },
  "observability": { "enabled": true },

  "d1_databases": [{ "binding": "DB", "database_name": "da-prod", "database_id": "<id>", "migrations_dir": "migrations" }],
  "r2_buckets": [
    { "binding": "DOCS", "bucket_name": "da-documents" },
    { "binding": "QUARANTINE", "bucket_name": "da-quarantine" },
    { "binding": "LETTERS", "bucket_name": "da-letters" },
    { "binding": "REPORTS_RAW", "bucket_name": "da-reports-raw" }
  ],
  "queues": { "producers": [
    { "binding": "Q_NOTIFY", "queue": "notifications" },
    { "binding": "Q_SCAN", "queue": "doc-scan" }
  ]},
  "workflows": [
    { "binding": "WF_IMPORT", "name": "report-import", "class_name": "ReportImportWorkflow", "script_name": "da-jobs" },
    { "binding": "WF_LETTER", "name": "letter-pipeline", "class_name": "LetterPipelineWorkflow", "script_name": "da-jobs" },
    { "binding": "WF_DEADLINE", "name": "dispute-deadline", "class_name": "DisputeDeadlineWorkflow", "script_name": "da-jobs" }
  ],
  "durable_objects": { "bindings": [{ "name": "CLIENT_LOCK", "class_name": "ClientLock" }] },
  "secrets_store_secrets": [
    { "binding": "ENC_KEY_V1", "store_id": "<store>", "secret_name": "enc-key-v1" },
    { "binding": "HMAC_KEY", "store_id": "<store>", "secret_name": "hmac-key" },
    { "binding": "TURNSTILE_SECRET", "store_id": "<store>", "secret_name": "turnstile-secret" }
  ],
  "ratelimits": [{ "name": "AUTH_LIMIT", "namespace_id": "1001", "simple": { "limit": 5, "period": 60 } }],
  "vars": { "APP_ENV": "production", "ACCESS_TEAM_DOMAIN": "<team>.cloudflareaccess.com", "ACCESS_AUD": "<aud-tag>" },

  "env": {
    "staging": {
      "name": "da-app-staging",
      "d1_databases": [{ "binding": "DB", "database_name": "da-staging", "database_id": "<id>" }]
      // ...staging buckets, queues, secrets
    }
  }
}
```

`da-jobs` has a similar file with queue consumers, the workflow classes, the browser binding (`"browser": { "binding": "BROWSER" }`), the container definition, email binding, cron triggers, and the external API secrets.

## 15. Repository Structure

```
dispute-alpha/
├── apps/
│   ├── web/          React SPA (Vite)
│   ├── app/          da-app Worker (Hono API + assets)
│   └── jobs/         da-jobs Worker (queues, workflows, cron)
├── containers/
│   └── clamav/       Dockerfile for the scanner
├── packages/
│   ├── db/           Drizzle schema, migrations, queries
│   ├── shared/       Zod schemas, types, permissions list
│   ├── crypto/       Field encryption, HMAC, key versioning
│   └── providers/    Credit provider, e-sign, email, SMS adapters
├── infra/
│   └── terraform/    Zone, DNS, WAF, Access apps and policies, R2 lifecycle
└── .github/workflows/
```

## 16. Environments and CI/CD

| Environment | Where | Data |
|---|---|---|
| Local | `wrangler dev` with local D1, R2, and Queues simulation | Seed data only |
| Staging | `staging.<domain>` behind Cloudflare Access for everyone | Fake data, provider sandbox |
| Production | `app.<domain>` | Real data |

Each environment has its own D1 database, R2 buckets, queues, and Secrets Store secrets. Nothing is shared between staging and production.

**GitHub Actions pipeline**
1. **Pull request:** install, lint, type check, Vitest (Workers pool), build, `wrangler deploy --dry-run`. Optional preview deploy of `da-app` against staging resources.
2. **Merge to `main`:** apply D1 migrations to staging → deploy `da-jobs` then `da-app` to staging → run Playwright smoke tests.
3. **Release (manual approval):** take a Time Travel bookmark → apply D1 migrations to production → deploy `da-jobs` → deploy `da-app` as a gradual rollout (10%, then 100%) → smoke tests.
4. **Rollback:** `wrangler rollback` to the previous Worker version. If a migration caused the problem, restore D1 to the bookmark from step 3.

**Migration rule:** migrations must be backward compatible with the previous Worker version (add columns, don't rename or drop in the same release), so a code rollback never breaks on the new schema.

**Infrastructure as code:** Terraform with the Cloudflare provider manages the zone, DNS, WAF rules, Access applications and policies, and R2 lifecycle rules. Wrangler manages Workers, D1, Queues, and Workflows.

## 17. Observability

- **Workers Logs** with structured JSON logs (request ID, user ID, route, duration). No PII in logs; a logging helper strips known sensitive fields.
- **Sentry** for frontend and Worker errors, with PII scrubbing on.
- **Analytics Engine** for business metrics: imports per day, letters approved, average days to response, overdue count.
- **Alerts:** error rate spikes (Sentry), DLQ messages (a consumer that posts to email or Slack), failed workflows, scanner down, D1 size over 5 GB.
- **Uptime:** external monitor hitting `/api/v1/health`, which checks D1, R2, and the queue binding.
- **Audit log:** stays in D1 (append-only table, no update or delete permission in code), and is exported monthly to R2 for long-term retention.

## 18. Account Ownership and Access

- The client owns the Cloudflare account, domain, Secrets Store, GitHub organization, and all external provider accounts.
- The client holds Super Administrator. The developer is invited as a member with only the roles needed (Workers, D1, R2, Access, Secrets Store Deployer), removable at any time.
- CI uses a scoped API token limited to this account and the needed permissions, stored as a GitHub Actions secret.
- At handoff: developer access is removed or reduced, API tokens are rotated, and the runbook is delivered.

## 19. Platform Limits to Design Around

| Limit | Impact | Design response |
|---|---|---|
| D1: 10 GB per database, single-threaded | Growth and slow queries | Files in R2, strict indexing, separate audit database if needed |
| D1: large writes must be batched | Bulk updates and migrations | Batch in chunks of about 1,000 rows |
| Worker CPU time per request | Report parsing can be heavy | Parsing runs in workflow steps in `da-jobs`, split per bureau |
| Email Sending in beta | API may change | Adapter with Postmark fallback |
| No HSM-backed KMS | Some auditors may expect one | Encryption isolated in one module so external KMS can be added |
| Browser Run concurrency | Big batch PDF jobs | Queue with limited concurrency, session reuse |

Exact limits and pricing change over time, so check Cloudflare's current documentation when provisioning.

## 20. Impact on Timeline

The milestones from the main spec stay the same, with these changes:
- **Milestone 1 (Foundation):** adds Cloudflare account setup, Access with the client's identity provider, Secrets Store, Terraform for the zone and WAF, and both Workers with staging environments. The work is about the same as the AWS setup, likely a little less since there are no VPCs, load balancers, or container clusters to configure.
- **Milestone 3 (Import):** built on Workflows instead of BullMQ jobs, with no change in duration.
- **Milestone 6 (Launch):** adds a D1 restore drill and a review of the WAF move from log to block mode.

**Ongoing costs:** expect the Workers Paid base fee plus usage for D1, R2, Queues, Workflows, Browser Run, and Containers. At MVP volume (hundreds to low thousands of clients) the Cloudflare portion should be small compared with the credit monitoring provider and e-sign fees. Estimate it with Cloudflare's pricing pages once expected volumes are confirmed.

## 21. Decisions Needed from the Client

1. **D1 or Postgres:** D1 keeps everything on Cloudflare. Postgres through Hyperdrive is the more conventional choice for financial data. Both work with the same codebase.
2. **Staff identity provider:** Google Workspace, Microsoft 365, or another provider for Cloudflare Access.
3. **Email:** accept the Email Service beta with fallback, or use Postmark from day one.
4. **Data location:** confirm all data must stay in the US, which sets the location hints for D1 and R2.
5. **Encryption:** is Secrets Store with app-level encryption acceptable, or is an HSM-backed KMS required now?

---

Sources:
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/index.md)
- [D1 Time Travel and backups](https://developers.cloudflare.com/d1/reference/time-travel/)
- [Cloudflare Workflows](https://developers.cloudflare.com/workflows/)
- [Containers and Sandboxes GA changelog](https://developers.cloudflare.com/changelog/2026-04-13-containers-sandbox-ga)
- [Cloudflare Email Service](https://developers.cloudflare.com/email-service/index.md)
- [Secrets Store with Workers](https://developers.cloudflare.com/secrets-store/integrations/workers)
- [Browser Run PDF generation](https://developers.cloudflare.com/browser-rendering/how-to/pdf-generation/)
- [OpenNext adapter on Workers](https://developers.cloudflare.com/workers/framework-guides/web-apps/opennext/index.md)
- [vinext on GitHub](https://github.com/cloudflare/vinext)
