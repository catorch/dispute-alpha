# Cloudflare Access (spec §10, §16; R2.3, R3).
# Access matches the most specific hostname+path, so the bypass apps below carve public
# paths out of the staff app. The Worker still verifies Cf-Access-Jwt-Assertion against ACCESS_AUD.

locals {
  staff_include = concat(
    var.staff_email_domain == "" ? [] : [{ email_domain = { domain = var.staff_email_domain } }],
    [for e in var.staff_emails : { email = { email = e } }],
  )
  public_api_paths = ["/api/v1/auth", "/api/v1/portal", "/api/v1/webhooks", "/api/v1/health"]
  public_spa_paths = ["/login", "/invite", "/reset", "/forgot", "/portal", "/assets"]
}

resource "cloudflare_zero_trust_access_policy" "staff" {
  account_id       = var.account_id
  name             = "Dispute Alpha staff"
  decision         = "allow"
  include          = local.staff_include
  require          = [{ login_method = { id = var.identity_provider_id } }]
  session_duration = var.access_session_duration
}

resource "cloudflare_zero_trust_access_policy" "bypass_everyone" {
  account_id = var.account_id
  name       = "Dispute Alpha public bypass"
  decision   = "bypass"
  include    = [{ everyone = {} }]
}

# Service token for CI smoke tests against staging (CF-Access-Client-Id / -Secret headers).
resource "cloudflare_zero_trust_access_service_token" "ci" {
  account_id = var.account_id
  name       = "dispute-alpha-ci-staging"
  duration   = "8760h"
}

resource "cloudflare_zero_trust_access_policy" "ci_service_token" {
  account_id = var.account_id
  name       = "Dispute Alpha CI service token"
  decision   = "non_identity"
  include    = [{ service_token = { token_id = cloudflare_zero_trust_access_service_token.ci.id } }]
}

# ---------- production ----------
resource "cloudflare_zero_trust_access_application" "prod_staff" {
  account_id                 = var.account_id
  name                       = "Dispute Alpha staff (prod)"
  type                       = "self_hosted"
  destinations               = [for p in ["/admin", "/api/v1"] : { type = "public", uri = "${var.app_hostname}${p}" }]
  allowed_idps               = [var.identity_provider_id]
  auto_redirect_to_identity  = true
  session_duration           = var.access_session_duration
  http_only_cookie_attribute = true
  same_site_cookie_attribute = "lax"
  policies                   = [{ id = cloudflare_zero_trust_access_policy.staff.id, precedence = 1 }]
}

resource "cloudflare_zero_trust_access_application" "prod_public_api" {
  account_id   = var.account_id
  name         = "Dispute Alpha public API (prod, bypass)"
  type         = "self_hosted"
  destinations = [for p in local.public_api_paths : { type = "public", uri = "${var.app_hostname}${p}" }]
  policies     = [{ id = cloudflare_zero_trust_access_policy.bypass_everyone.id, precedence = 1 }]
}

resource "cloudflare_zero_trust_access_application" "prod_public_spa" {
  account_id   = var.account_id
  name         = "Dispute Alpha client SPA (prod, bypass)"
  type         = "self_hosted"
  destinations = [for p in local.public_spa_paths : { type = "public", uri = "${var.app_hostname}${p}" }]
  policies     = [{ id = cloudflare_zero_trust_access_policy.bypass_everyone.id, precedence = 1 }]
}

# ---------- staging: whole host behind Access, webhooks bypassed ----------
resource "cloudflare_zero_trust_access_application" "staging" {
  account_id                 = var.account_id
  name                       = "Dispute Alpha (staging)"
  type                       = "self_hosted"
  destinations               = [{ type = "public", uri = var.staging_hostname }]
  allowed_idps               = [var.identity_provider_id]
  auto_redirect_to_identity  = true
  session_duration           = var.access_session_duration
  http_only_cookie_attribute = true
  same_site_cookie_attribute = "lax"
  policies = [
    { id = cloudflare_zero_trust_access_policy.ci_service_token.id, precedence = 1 },
    { id = cloudflare_zero_trust_access_policy.staff.id, precedence = 2 },
  ]
}

resource "cloudflare_zero_trust_access_application" "staging_webhooks" {
  account_id   = var.account_id
  name         = "Dispute Alpha staging webhooks (bypass)"
  type         = "self_hosted"
  destinations = [{ type = "public", uri = "${var.staging_hostname}/api/v1/webhooks" }]
  policies     = [{ id = cloudflare_zero_trust_access_policy.bypass_everyone.id, precedence = 1 }]
}
