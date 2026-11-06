#!/usr/bin/env bash
# Runs da-app and da-jobs together on http://localhost:8787 with shared local state.
set -euo pipefail
cd "$(dirname "$0")/.."
STATE="$(bash scripts/state-dir.sh)"
echo "Local state: $STATE"
npx wrangler d1 migrations apply DB --local -c apps/app/wrangler.jsonc --persist-to "$STATE"
exec npx wrangler dev -c apps/app/wrangler.jsonc -c apps/jobs/wrangler.jsonc --persist-to "$STATE" "$@"
