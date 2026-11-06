# WAF managed rules, custom rules, and rate limiting (spec §11, R7.2-R7.4).
# Each phase has exactly one zone entrypoint ruleset, so each phase is one cloudflare_ruleset.

locals {
  # Cloudflare-published managed ruleset IDs.
  cf_managed_ruleset_id   = "efb7b8c949ac4650a09736fc376e9aee"
  owasp_core_ruleset_id   = "4814384a9e5d4991b9815dcfc25d2f1f"
  managed_action_override = var.waf_mode == "log" ? { action = "log" } : null

  webhook_rule = length(var.webhook_ip_ranges) == 0 ? [] : [{
    ref         = "webhook_ip_allowlist"
    description = "Block webhooks not from provider IP ranges"
    expression  = "(starts_with(http.request.uri.path, \"/api/v1/webhooks/\") and not ip.src in {${join(" ", var.webhook_ip_ranges)}})"
    action      = "block"
  }]
  country_rule = var.us_only_auth_challenge ? [{
    ref         = "auth_non_us_challenge"
    description = "Managed challenge for non-US traffic on auth endpoints"
    expression  = "(starts_with(http.request.uri.path, \"/api/v1/auth/\") and ip.src.country ne \"US\")"
    action      = "managed_challenge"
  }] : []
  custom_rules = concat(local.webhook_rule, local.country_rule)
}

resource "cloudflare_ruleset" "waf_managed" {
  zone_id     = var.zone_id
  name        = "Managed WAF"
  description = "Cloudflare Managed + OWASP Core (mode: ${var.waf_mode})"
  kind        = "zone"
  phase       = "http_request_firewall_managed"

  rules = [
    {
      ref         = "cf_managed"
      description = "Cloudflare Managed Ruleset"
      expression  = "true"
      action      = "execute"
      action_parameters = {
        id        = local.cf_managed_ruleset_id
        overrides = local.managed_action_override
      }
    },
    {
      ref         = "owasp_core"
      description = "Cloudflare OWASP Core Ruleset"
      expression  = "true"
      action      = "execute"
      action_parameters = {
        id        = local.owasp_core_ruleset_id
        overrides = local.managed_action_override
      }
    },
  ]
}

resource "cloudflare_ruleset" "waf_custom" {
  count       = length(local.custom_rules) > 0 ? 1 : 0
  zone_id     = var.zone_id
  name        = "Custom WAF rules"
  description = "Webhook IP allowlist and optional US-only auth challenge"
  kind        = "zone"
  phase       = "http_request_firewall_custom"
  rules       = local.custom_rules
}

resource "cloudflare_ruleset" "rate_limit" {
  zone_id     = var.zone_id
  name        = "Rate limits"
  description = "Edge rate limits for auth and report import (the Worker also rate-limits per account)"
  kind        = "zone"
  phase       = "http_ratelimit"

  rules = [
    {
      ref         = "rl_auth"
      description = "Auth endpoints"
      expression  = "(starts_with(http.request.uri.path, \"/api/v1/auth/\"))"
      action      = "block"
      ratelimit = {
        characteristics     = ["cf.colo.id", "ip.src"]
        period              = var.rate_limit_period
        requests_per_period = var.auth_requests_per_period
        mitigation_timeout  = var.rate_limit_mitigation_timeout
      }
    },
    {
      ref         = "rl_report_import"
      description = "Credit report import"
      expression  = "(starts_with(http.request.uri.path, \"/api/v1/clients/\") and ends_with(http.request.uri.path, \"/reports/import\"))"
      action      = "block"
      ratelimit = {
        characteristics     = ["cf.colo.id", "ip.src"]
        period              = var.rate_limit_period
        requests_per_period = var.import_requests_per_period
        mitigation_timeout  = var.rate_limit_mitigation_timeout
      }
    },
  ]
}
