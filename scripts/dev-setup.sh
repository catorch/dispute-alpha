#!/usr/bin/env bash
# One-time local setup: .dev.vars, local Secrets Store values, and D1 migrations.
# Local state goes where scripts/state-dir.sh says (shared by both Workers under `pnpm dev`).
set -euo pipefail
cd "$(dirname "$0")/.."
PERSIST="$(bash scripts/state-dir.sh)"
echo "Local state: $PERSIST"
STORE="<secrets-store-id>"   # matches the placeholder store_id in wrangler.jsonc; local only

for d in app jobs; do
  [ -f "apps/$d/.dev.vars" ] || cp "apps/$d/.dev.vars.example" "apps/$d/.dev.vars"
done

secret() {
  if npx wrangler secrets-store secret create "$STORE" --name "$1" --value "$2" --scopes workers --persist-to "$PERSIST" >/dev/null 2>&1; then
    echo "  created local secret $1"
  else
    echo "  local secret $1 already exists (kept)"
  fi
}
echo "Local Secrets Store:"
secret enc-key-v1 "$(openssl rand -base64 32)"
secret hmac-key "$(openssl rand -base64 32)"
secret turnstile-secret "1x0000000000000000000000000000000AA"   # Cloudflare's always-pass test secret
secret credit-webhook-secret "local-credit-webhook-secret"
for unused in esign-api-key twilio-auth-token postmark-token d1-export-api-token slack-webhook-url; do secret "$unused" "unused-locally"; done

echo "Applying D1 migrations locally..."
pnpm -s db:migrate:local

cat <<'MSG'

Done. Next:
  pnpm build               # build the SPA once (da-app serves apps/web/dist)
  pnpm dev                 # da-app + da-jobs on http://localhost:8787
  pnpm dev:web             # optional: Vite dev server with HMR on http://localhost:5173
  pnpm db:seed:local       # org + admin@local.test, staff@local.test, approver@local.test

Staff auth is bypassed locally (DEV_STAFF_EMAIL, or send header x-dev-staff-email). Emails are
printed to the wrangler console instead of being sent (EMAIL_PROVIDER=memory).
MSG
