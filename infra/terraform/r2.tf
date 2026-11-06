# R2 buckets and lifecycle rules (spec §7, R10.10, R21.2). Private, no r2.dev URL.

locals {
  bucket_suffixes = ["documents", "quarantine", "letters", "reports-raw", "backups"]
  buckets = merge(
    { for s in local.bucket_suffixes : "da-${s}" => s },
    { for s in local.bucket_suffixes : "da-staging-${s}" => s },
  )
  day = 86400
  # bucket suffix => expiry. Backups expire only under d1/ (nightly exports); audit/ monthly
  # archives in the same bucket are long-term retention (R19.5) and are never auto-deleted.
  expiry = {
    backups    = { days = 365, prefix = "d1/" }
    quarantine = { days = 7, prefix = "" }
  }
}

resource "cloudflare_r2_bucket" "this" {
  for_each     = local.buckets
  account_id   = var.account_id
  name         = each.key
  location     = var.r2_location
  jurisdiction = var.r2_jurisdiction
}

resource "cloudflare_r2_managed_domain" "off" {
  for_each     = cloudflare_r2_bucket.this
  account_id   = var.account_id
  bucket_name  = each.value.name
  jurisdiction = var.r2_jurisdiction
  enabled      = false
}

resource "cloudflare_r2_bucket_lifecycle" "expiry" {
  for_each     = { for name, s in local.buckets : name => local.expiry[s] if contains(keys(local.expiry), s) }
  account_id   = var.account_id
  bucket_name  = cloudflare_r2_bucket.this[each.key].name
  jurisdiction = var.r2_jurisdiction
  rules = [
    {
      id         = "expire-after-${each.value.days}d"
      enabled    = true
      conditions = { prefix = each.value.prefix }
      delete_objects_transition = {
        condition = { type = "Age", max_age = each.value.days * local.day }
      }
      abort_multipart_uploads_transition = {
        condition = { type = "Age", max_age = 7 * local.day }
      }
    },
  ]
}
