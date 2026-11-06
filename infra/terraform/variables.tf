variable "account_id" {
  type        = string
  description = "Cloudflare account ID (client-owned account, spec §18)."
}

variable "zone_id" {
  type        = string
  description = "Zone ID of the client domain."
}

variable "zone_name" {
  type        = string
  description = "Apex domain, e.g. clientdomain.com."
}

variable "app_hostname" {
  type        = string
  description = "Production hostname, e.g. app.clientdomain.com (Worker custom domain, created by Wrangler)."
}

variable "staging_hostname" {
  type        = string
  description = "Staging hostname, e.g. staging.clientdomain.com (Worker custom domain, created by Wrangler)."
}

# ---------- Access ----------
variable "identity_provider_id" {
  type        = string
  description = "UUID of the Zero Trust identity provider staff log in with (decision D2: Google Workspace / Microsoft 365 / ...)."
}

variable "staff_email_domain" {
  type        = string
  default     = ""
  description = "Allow every IdP user with this email domain (e.g. clientdomain.com). Empty = disabled."
}

variable "staff_emails" {
  type        = list(string)
  default     = []
  description = "Individual staff emails allowed through Access (in addition to staff_email_domain)."

  validation {
    condition     = length(var.staff_emails) > 0 || var.staff_email_domain != ""
    error_message = "Set staff_email_domain or staff_emails, otherwise nobody can reach /admin."
  }
}

variable "access_session_duration" {
  type    = string
  default = "8h"
}

# ---------- Edge security ----------
variable "waf_mode" {
  type        = string
  default     = "log"
  description = "\"log\" for the first week after launch (managed rules only log), then \"block\" (managed rules use their default actions)."

  validation {
    condition     = contains(["log", "block"], var.waf_mode)
    error_message = "waf_mode must be \"log\" or \"block\"."
  }
}

variable "webhook_ip_ranges" {
  type        = list(string)
  default     = []
  description = "Published IP ranges (CIDR) of e-sign / credit / SMS webhook senders. Empty list = no IP allowlist rule (signature verification still applies)."
}

variable "us_only_auth_challenge" {
  type        = bool
  default     = false
  description = "Managed-challenge non-US traffic on /api/v1/auth/* (enable once traffic is confirmed US-only)."
}

variable "rate_limit_period" {
  type        = number
  default     = 60
  description = "Rate limit counting period in seconds. Allowed values depend on plan (Free: 10; Pro/Business: 10, 60, ...)."
}

variable "rate_limit_mitigation_timeout" {
  type        = number
  default     = 600
  description = "Seconds an offending IP stays blocked. Free plan allows only 10; Pro 60..3600 (check your plan)."
}

variable "auth_requests_per_period" {
  type    = number
  default = 20
}

variable "import_requests_per_period" {
  type    = number
  default = 10
}

variable "hsts_preload" {
  type        = bool
  default     = false
  description = "Add the HSTS preload directive. Turn on only once the site is stable on HTTPS (task 23.1); preload is hard to undo."
}

# ---------- Email (notify.<domain>) ----------
variable "email_subdomain" {
  type    = string
  default = "notify"
}

variable "spf_includes" {
  type        = list(string)
  default     = ["_spf.mx.cloudflare.net"]
  description = "SPF include mechanisms for the sending subdomain. Add spf.mtasv.net if Postmark sends with this domain as Return-Path."
}

variable "dmarc_policy" {
  type        = string
  default     = "none"
  description = "DMARC policy: start at none, move to quarantine after reports look clean."

  validation {
    condition     = contains(["none", "quarantine", "reject"], var.dmarc_policy)
    error_message = "dmarc_policy must be none, quarantine or reject."
  }
}

variable "dmarc_rua" {
  type        = string
  default     = ""
  description = "Optional aggregate report address, e.g. mailto:dmarc@clientdomain.com."
}

variable "dkim_records" {
  type = map(object({
    type    = string # TXT or CNAME, as the email provider specifies
    content = string
  }))
  default     = {}
  description = "DKIM records from the email provider, keyed by full record name (e.g. cf2024-1._domainkey.notify.clientdomain.com)."
}

# ---------- R2 ----------
variable "r2_location" {
  type        = string
  default     = "enam"
  description = "R2 location hint (decision D4). enam/wnam for North America. Only honored at bucket creation."
}

variable "r2_jurisdiction" {
  type        = string
  default     = "default"
  description = "R2 jurisdiction: \"default\", or \"us\" if the client confirms US-only residency (R28). Set before the first apply; it cannot change later. Wrangler bindings must then set the same jurisdiction."

  validation {
    condition     = contains(["default", "us", "eu", "fedramp"], var.r2_jurisdiction)
    error_message = "r2_jurisdiction must be default, us, eu or fedramp."
  }
}
