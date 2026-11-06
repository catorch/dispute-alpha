output "access_aud_prod" {
  description = "ACCESS_AUD for da-app (production vars)."
  value       = cloudflare_zero_trust_access_application.prod_staff.aud
}

output "access_aud_staging" {
  description = "ACCESS_AUD for da-app env.staging vars."
  value       = cloudflare_zero_trust_access_application.staging.aud
}

output "ci_access_client_id" {
  description = "GitHub secret STAGING_ACCESS_CLIENT_ID."
  value       = cloudflare_zero_trust_access_service_token.ci.client_id
}

output "ci_access_client_secret" {
  description = "GitHub secret STAGING_ACCESS_CLIENT_SECRET (terraform output -raw ci_access_client_secret)."
  value       = cloudflare_zero_trust_access_service_token.ci.client_secret
  sensitive   = true
}

output "r2_buckets" {
  value = sort(keys(cloudflare_r2_bucket.this))
}
