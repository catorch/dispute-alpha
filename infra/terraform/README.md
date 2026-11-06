# infra/terraform

Terraform (Cloudflare provider v5, pinned `~> 5.28`) for the Dispute Alpha edge and storage.

## Ownership split (spec §16, R24.5)

| Terraform owns | Wrangler owns (`apps/*/wrangler.jsonc`, CI) |
|---|---|
| Zone settings (SSL Full strict, TLS 1.2, Always HTTPS, HSTS, Bot Fight Mode) | Workers `da-app`, `da-jobs` (+ `-staging`) and their custom domains / DNS for `app.` and `staging.` |
| `notify.` SPF, DKIM, DMARC records | D1 databases `da-prod`, `da-staging` and migrations |
| WAF managed + custom rules, rate limiting | Queues + DLQs, Workflows, Durable Objects, Containers |
| Access applications, policies, CI service token | Secrets Store secrets, Worker vars (`ACCESS_AUD` etc.) |
| R2 buckets, r2.dev disabled, lifecycle rules | |

Never create a Worker, D1 database, or queue here, and never hand-edit Terraform-owned settings in the dashboard (the next apply reverts them).

## Files

- `zone.tf`: zone settings, Bot Fight Mode, email DNS
- `waf.tf`: `http_request_firewall_managed`, `http_request_firewall_custom`, `http_ratelimit` rulesets
- `access.tf`: Access policies and applications (prod staff, prod bypass, staging)
- `r2.tf`: 10 buckets (`da-*`, `da-staging-*`), lifecycle (backups `d1/` prefix 365 d, quarantine 7 d; `audit/` archives kept)
- `terraform.tfvars.example`: copy to `terraform.tfvars` (git-ignored)

## Prerequisites

1. Zone active on the client's Cloudflare account; Zero Trust org created (team domain noted for `ACCESS_TEAM_DOMAIN`).
2. Identity provider added in Zero Trust → Settings → Authentication (decision D2); copy its UUID into `identity_provider_id`.
3. API token for Terraform (account: Access Apps and Policies Edit, Access Service Tokens Edit, Workers R2 Storage Edit; zone: Zone Settings Edit, DNS Edit, Zone WAF Edit, Bot Management Edit, Firewall Services Edit). Export as `CLOUDFLARE_API_TOKEN`. This is a different token from the CI deploy token.
4. Decide `r2_jurisdiction` (D4) **before** the first apply. Jurisdiction cannot be changed later, and with `"us"` every R2 binding in `wrangler.jsonc` needs `"jurisdiction": "us"`.

## Apply order

```sh
export TF_DATA_DIR=...           # optional: keep .terraform off small disks
terraform init                   # configure a remote backend (R2/S3) before real use
terraform plan -out tf.plan
terraform apply tf.plan
```

1. **Terraform first**: buckets must exist before `wrangler deploy`, and Access must protect `staging.` before staging is deployed (R2.3).
2. Copy outputs into Wrangler/GitHub:
   - `terraform output access_aud_prod` → `ACCESS_AUD` in `apps/app/wrangler.jsonc` vars
   - `terraform output access_aud_staging` → `env.staging.vars.ACCESS_AUD`
   - `terraform output ci_access_client_id` / `-raw ci_access_client_secret` → GitHub secrets `STAGING_ACCESS_CLIENT_ID` / `STAGING_ACCESS_CLIENT_SECRET`
3. **Wrangler**: create D1, queues, Secrets Store secrets (task 2.5), then CI deploys the Workers (their custom domains create the `app.`/`staging.` DNS records).
4. One week after launch: `waf_mode = "block"` and apply (runbook). Once stable: `hsts_preload = true`, `dmarc_policy = "quarantine"`.

## Plan notes

- Two rate-limit rules need Pro or higher. `rate_limit_period` / `rate_limit_mitigation_timeout` must be values your plan allows.
- `fight_mode` is Free-plan Bot Fight Mode. On Pro+ use the `sbfm_*` attributes of `cloudflare_bot_management` instead.
- `waf_mode = "log"` overrides every managed rule to log. `"block"` removes the override, so each rule uses its Cloudflare default action (OWASP blocks on the anomaly-score rule).
- The webhook IP allowlist rule only exists when `webhook_ip_ranges` is non-empty. Webhooks are always signature-verified by the Worker.
- `cloudflare_r2_managed_domain` cannot be destroyed by Terraform (provider warning). That is harmless: it only records that r2.dev is disabled.
