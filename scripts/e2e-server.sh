#!/usr/bin/env bash
# Boots an isolated local stack for Playwright: fresh state dir, local secrets, migrations,
# SPA built with the Turnstile test bypass, then da-app + da-jobs under wrangler dev.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${E2E_PORT:-8788}"
STATE="${E2E_STATE:-$(mktemp -d)}"
LOG="${E2E_LOG:-/tmp/da-e2e-server.log}"
STORE="<secrets-store-id>"
for d in app jobs; do [ -f "apps/$d/.dev.vars" ] || cp "apps/$d/.dev.vars.example" "apps/$d/.dev.vars"; done
mk() { npx wrangler secrets-store secret create "$STORE" --name "$1" --value "$2" --scopes workers --persist-to "$STATE" >/dev/null; }
mk enc-key-v1 "$(openssl rand -base64 32)"
mk hmac-key "$(openssl rand -base64 32)"
mk turnstile-secret "1x0000000000000000000000000000000AA"
mk credit-webhook-secret "e2e"
npx wrangler d1 migrations apply DB --local -c apps/app/wrangler.jsonc --persist-to "$STATE" >/dev/null
VITE_TURNSTILE_BYPASS=1 pnpm -s --filter @da/web build >/dev/null
: > "$LOG"
exec npx wrangler dev -c apps/app/wrangler.jsonc -c apps/jobs/wrangler.jsonc --persist-to "$STATE" --port "$PORT" 2>&1 | tee -a "$LOG"
