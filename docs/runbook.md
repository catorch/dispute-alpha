# Dispute Alpha Runbook

Operational procedures for production (`da-app`, `da-jobs`, D1 `da-prod`) and staging (`*-staging`, D1 `da-staging`). R25.3.

**Conventions.** Commands run from the repo root after `pnpm install`. Set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in your shell first. `W` means `pnpm exec wrangler`. Production commands need `-c apps/app/wrangler.jsonc` (or `apps/jobs/...`). Add `--env staging` for staging. **Always rehearse on staging first.**

| Thing | Where |
|---|---|
| CI pipelines | `.github/workflows/{pr,staging,release}.yml` |
| Edge, Access, R2 lifecycle | `infra/terraform` (see its README) |
| Workers, D1, queues, crons | `apps/*/wrangler.jsonc` |
| Secrets | Cloudflare Secrets Store (bound by name in wrangler.jsonc) |
| GitHub secrets | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `STAGING_ACCESS_CLIENT_ID`, `STAGING_ACCESS_CLIENT_SECRET`; environment vars `STAGING_URL`, `PROD_URL` |

---

## 1. Deploy

**Staging** happens automatically on every merge to `main` (`staging.yml`): migrations → `da-jobs-staging` → `da-app-staging` → Playwright smoke.

**Production** (`release.yml`):
1. Actions → Release → Run workflow, `action = release`. A `production` reviewer approves.
2. The pipeline:
   1. records a D1 Time Travel bookmark (shown in the run summary and saved as artifact `d1-bookmark-<run>`),
   2. applies migrations,
   3. deploys `da-jobs`,
   4. uploads a new `da-app` version and sends it 10% of traffic,
   5. smoke-tests the new version (`Cloudflare-Workers-Version-Overrides` header),
   6. promotes it to 100%.
3. If any step fails after the canary started, traffic automatically goes back to the previous `da-app` version. `da-jobs` and migrations are **not** reverted. See §2.

Rules:
- Migrations must be additive (`scripts/check-migrations.mjs` enforces this, R20.2). Drop or rename a column only in a later release, once no deployed version reads it. Mark that file `-- breaking-approved`.
- A release that adds a Durable Object migration (`migrations` in wrangler.jsonc) can't go through `versions upload`. Deploy that release with `W deploy -c apps/app/wrangler.jsonc` (no gradual rollout) and note it in the PR.

Manual fallback (CI down): `W d1 time-travel info da-prod --json` (save the bookmark) → `W d1 migrations apply DB --remote -c apps/app/wrangler.jsonc` → `W deploy -c apps/jobs/wrangler.jsonc` → `W deploy -c apps/app/wrangler.jsonc`.

## 2. Rollback

1. **Code only (the usual case).** Actions → Release → `action = rollback`. Leave `restore_d1_bookmark` empty. This runs `wrangler rollback` on `da-app` (to `rollback_version_id`, or the previous version if empty) and on `da-jobs`.
   - Manual: `W rollback [version-id] -c apps/app/wrangler.jsonc -m "reason"`. Use `W versions list -c apps/app/wrangler.jsonc` to find IDs.
   - During a canary, `W versions deploy <old-id>@100% -c apps/app/wrangler.jsonc -y` is enough.
2. **A migration corrupted data.** Rerun with `restore_d1_bookmark = <bookmark from the release run summary>`. **Everything written after the bookmark is lost.** Get the client owner's sign-off first and record the incident. Before restoring, export the current state: `W d1 export da-prod --remote --output pre-restore.sql`.

## 3. D1 restore

Never restore a drill into `da-prod` (R21.3). Real incidents use 3a against prod only after sign-off.

**3a. Time Travel (any point in the last 30 days)**
```sh
W d1 time-travel info da-prod --timestamp 2026-11-05T14:00:00Z --json   # find the bookmark
W d1 time-travel restore da-prod --bookmark <bookmark>                   # or --timestamp
```
Restore rewinds the database in place and prints a bookmark for undoing the restore. Save it.

**3b. Nightly R2 export (older than 30 days, or a clean copy)**

The `0 8 * * *` cron writes `da-backups/d1/YYYY-MM-DD.sql`. Lifecycle deletes these after 365 days.
```sh
W r2 object get da-backups/d1/2026-11-04.sql --remote --file restore.sql
W d1 create da-restore-test --location enam
W d1 execute da-restore-test --remote --file restore.sql
# verify (see §11), then either point traffic at it or copy specific rows back.
```
Promoting a restored DB means changing `database_id` in both wrangler.jsonc files, then deploying `da-jobs` and `da-app`. Do it only with sign-off.

## 4. Encryption key rotation (R6.2)

Keys are `ENC_KEY_V<n>` Secrets Store bindings. `ENC_KEY_CURRENT` picks the key used for new writes. Old versions stay readable while their rows are re-encrypted.

1. Generate a key: `openssl rand -base64 32`.
2. Store it (prompted, so the value never reaches shell history): `W secrets-store secret create <store-id> --name enc-key-v2 --scopes workers --remote`. Use `staging-enc-key-v2` for staging.
3. In **both** `apps/app/wrangler.jsonc` and `apps/jobs/wrangler.jsonc`, add `{ "binding": "ENC_KEY_V2", "store_id": "<store-id>", "secret_name": "enc-key-v2" }` and set `"ENC_KEY_CURRENT": "2"`. Merge, let staging run, then release.
4. Within 15 minutes, the `*/15` cron in `da-jobs` (`keyRotationTick`) sees `ENC_KEY_CURRENT` above the latest rotation and inserts one `key_rotation` row per encrypted table. It then re-encrypts 500 rows per table per tick.
5. Monitor:
   ```sh
   W d1 execute DB --remote -c apps/jobs/wrangler.jsonc --command "SELECT table_name, to_version, status, last_id, datetime(updated_at/1000,'unixepoch') FROM key_rotation ORDER BY updated_at DESC"
   ```
   It is finished when every row for `to_version = 2` shows `done`. Spot-check with `SELECT count(*) FROM client WHERE ssn_enc NOT LIKE 'v2:%'`, which should return 0.
6. Restart a stuck rotation manually (equivalent to `ops.startRotation`):
   ```sql
   DELETE FROM key_rotation WHERE status = 'running';
   INSERT INTO key_rotation (id, to_version, table_name, status, updated_at)
   SELECT lower(hex(randomblob(16))), 2, t, 'running', unixepoch()*1000
   FROM (SELECT 'client' t UNION ALL SELECT 'client_account' UNION ALL SELECT 'invite' UNION ALL SELECT 'report_item');
   ```
7. Keep `ENC_KEY_V1` bound for at least one release after completion (rollback safety). Then remove the binding and delete the secret.

Rotate `HMAC_KEY` only with a planned re-hash. Changing it breaks duplicate-client detection for existing rows.

## 5. Dead-letter queues

Every queue has a `-dlq` (`notifications-dlq`, `pdf-render-dlq`, `doc-scan-dlq`, `audit-export-dlq`, plus `staging-` versions). `da-jobs` consumes each DLQ and sends an ops alert (email to `OPS_ALERT_EMAIL`, Slack if configured) with a PII-free summary.

1. Read the alert: queue, message type, entity ID, last error.
2. Find the cause in Workers Logs (`da-jobs`, filter by entity ID) or Sentry.
3. Fix the cause (provider outage, bad data, code bug → release).
4. Redrive. Consumers are idempotent (R22.2), so replaying is safe:
   - `doc-scan`: the file is still in quarantine. Staff use the retry action, or re-enqueue it by releasing the fix. The weekly cleanup expires quarantine after 7 days.
   - `pdf-render`: `POST /api/v1/letters/:id/retry-render`.
   - `notifications`: usually drop it (the notice is stale). Re-trigger the source action if it matters.
   - `audit-export`: the admin re-requests the export.
5. Check backlog with `W queues list` and `W queues info <queue>`.

## 6. Scanner (ClamAV container) recovery

Symptoms: "Scan pending" older than 1 hour (the `scan_backlog` cron alerts), `doc-scan` retries, or 503s from the container. Files are **never** released unscanned. They wait in quarantine.

1. Check the latest `da-jobs` logs for `ClamAvContainer` errors. Typical causes are a mirror outage during freshclam at startup (harmless, baked signatures are used), OOM, or clamd crashing (the container exits and is restarted).
2. Redeploy `da-jobs` (`W deploy -c apps/jobs/wrangler.jsonc`). This rebuilds the image with fresh signatures and replaces the container instances.
3. Test locally with the same image: `docker build -t da-clamav containers/clamav && docker run -d -p 8080:8080 da-clamav && sh containers/clamav/smoke.sh`.
4. After recovery, retry the stuck documents (they re-enqueue on retry). Anything older than 7 days has been expired by the weekly cleanup, so ask for a re-upload.

## 7. Switch email provider

`EMAIL_PROVIDER` in `apps/jobs/wrangler.jsonc` vars: `cloudflare` (Email Service binding `EMAIL`) or `postmark` (needs the `POSTMARK_TOKEN` secret).

1. For Postmark: create the Postmark server and verify `notify.<domain>`. Add its DKIM record to `dkim_records` in Terraform and add `spf.mtasv.net` to `spf_includes` (or the Return-Path CNAME). Run `terraform apply`. Store the token: `W secrets-store secret create <store-id> --name postmark-token --scopes workers --remote`.
2. Set `"EMAIL_PROVIDER": "postmark"` (staging env first), merge, release.
3. Send a test notification on staging, and check SPF/DKIM pass in the received headers.
4. Switching back works the same way. Keep both providers' DNS records in place so a switch needs no DNS change.

## 8. Add staff

1. Make sure the person can sign in through the IdP. If they are outside `staff_email_domain`, add them to `staff_emails` in Terraform and run `terraform apply`.
2. An Org Admin creates the user in the app (Admin → Staff → Invite, or `POST /api/v1/users`) with the right role (`org_admin`, `staff`, `approver`). Access proves identity. The app's `user` row grants the role.
3. Remove staff: deactivate in the app (sessions are invalidated, reassignment tasks are created), then remove them from the IdP or `staff_emails`. Revoke live Access sessions in Zero Trust → Access → Users → Revoke.

## 9. Developer offboarding and token rotation (handoff, R25)

1. The client confirms they hold Super Administrator on the Cloudflare account, the GitHub org owner role, the domain registrar, and every provider account.
2. Cloudflare → Manage Account → Members: remove the developer, or reduce them to the roles still needed.
3. Zero Trust → Access → Users: revoke the developer's sessions. Remove their email from `staff_emails` and apply.
4. Rotate the CI token: create a new scoped API token (account: Workers Scripts Edit, D1 Edit, Workers R2 Storage Edit, Queues Edit, Workflows Edit, Containers Edit, Secrets Store Deployer, Browser Rendering Edit; zone: Workers Routes Edit) limited to this account. Update the GitHub secret `CLOUDFLARE_API_TOKEN`, run the staging workflow, then delete the old token.
5. Rotate the Terraform token and anything the developer may have seen. That includes the Access service token (`terraform apply -replace=cloudflare_zero_trust_access_service_token.ci`, then update the `STAGING_ACCESS_*` secrets), the D1 export token (`d1-export-api-token`), and provider API keys and webhook secrets in Secrets Store. Rotate keys at the provider first, then update the secret.
6. GitHub: remove the developer from the org and the `production` environment reviewers, and review deploy keys.

## 10. WAF: move from log to block

1. After 7 days of production traffic, review Security → Events filtered to the Managed and OWASP rulesets. Look for hits on legitimate traffic (webhooks, PDF/HTML uploads, letter editor posts).
2. For each false positive, add a skip or exception (a rule in `waf.tf` before the execute rules, scoped by path) rather than disabling the ruleset.
3. Set `waf_mode = "block"` in `terraform.tfvars`, then `terraform plan` and `apply`.
4. Watch Security Events and the API error rate for 24 hours. To revert, set `waf_mode = "log"` and apply.
5. Same pass (task 23.1): set `hsts_preload = true` once HTTPS is stable everywhere, and `dmarc_policy = "quarantine"` once DMARC reports are clean.

## 11. Quarterly restore drill (R21.3)

Run it every quarter and before launch. Record the date, operator, durations, and issues in the log below.

- [ ] Take the newest nightly export: `W r2 object get da-backups/d1/<date>.sql --remote --file drill.sql`
- [ ] `W d1 create da-restore-test --location enam`, then `W d1 execute da-restore-test --remote --file drill.sql`
- [ ] Verify: row counts for `organization`, `user`, `client`, `letter`, `audit_log` match prod at export time (within a day). The latest `audit_log.created_at` is from the export day.
- [ ] Spot-check encryption: `ssn_enc` values carry the expected `v<n>:` prefix (never bind prod keys to a scratch Worker).
- [ ] Time Travel on staging (fake data): note `W d1 time-travel info DB -c apps/app/wrangler.jsonc --env staging --json`, make a test write, `W d1 time-travel restore DB -c apps/app/wrangler.jsonc --env staging --bookmark <b>`, confirm the write is gone.
- [ ] Rehearse a code rollback on staging: `W rollback -c apps/app/wrangler.jsonc --env staging`, then redeploy.
- [ ] Delete the scratch DB: `W d1 delete da-restore-test`.
- [ ] Record RTO (time to a usable restored DB) and RPO (age of the newest export).

| Date | Operator | Export used | Restore time | Issues |
|---|---|---|---|---|
| | | | | |
