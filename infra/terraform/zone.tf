# Zone settings, Bot Fight Mode, and email-auth DNS (spec §11, §12; R7.1, R18.4).
# app./staging. DNS records are NOT managed here: the Workers custom_domain routes in
# wrangler.jsonc create and own them.

locals {
  zone_settings = {
    ssl              = "strict"
    min_tls_version  = "1.2"
    always_use_https = "on"
  }
  email_domain = "${var.email_subdomain}.${var.zone_name}"
}

resource "cloudflare_zone_setting" "basic" {
  for_each   = local.zone_settings
  zone_id    = var.zone_id
  setting_id = each.key
  value      = each.value
}

resource "cloudflare_zone_setting" "hsts" {
  zone_id    = var.zone_id
  setting_id = "security_header"
  value = {
    strict_transport_security = {
      enabled            = true
      max_age            = 31536000
      include_subdomains = true
      preload            = var.hsts_preload
      nosniff            = true
    }
  }
}

# Free-plan Bot Fight Mode. On Pro+ this becomes Super Bot Fight Mode (sbfm_* attributes).
resource "cloudflare_bot_management" "this" {
  zone_id    = var.zone_id
  fight_mode = true
}

# TXT content is quoted: the API stores TXT values quoted and unquoted input causes plan drift.
resource "cloudflare_dns_record" "spf" {
  zone_id = var.zone_id
  name    = local.email_domain
  type    = "TXT"
  ttl     = 3600
  content = "\"v=spf1 ${join(" ", [for i in var.spf_includes : "include:${i}"])} ~all\""
  comment = "SPF for transactional email (managed by Terraform)"
}

resource "cloudflare_dns_record" "dmarc" {
  zone_id = var.zone_id
  name    = "_dmarc.${local.email_domain}"
  type    = "TXT"
  ttl     = 3600
  content = "\"v=DMARC1; p=${var.dmarc_policy}${var.dmarc_rua == "" ? "" : "; rua=${var.dmarc_rua}"}; adkim=r; aspf=r\""
  comment = "DMARC for transactional email (managed by Terraform)"
}

resource "cloudflare_dns_record" "dkim" {
  for_each = var.dkim_records
  zone_id  = var.zone_id
  name     = each.key
  type     = each.value.type
  ttl      = 3600
  content  = each.value.type == "TXT" ? "\"${trim(each.value.content, "\"")}\"" : each.value.content
  proxied  = false
  comment  = "DKIM from email provider (managed by Terraform)"
}
