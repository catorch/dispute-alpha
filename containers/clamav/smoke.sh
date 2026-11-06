#!/bin/sh
# Contract smoke test for a running scanner: ./smoke.sh [base-url]. Used by CI (pr.yml) and locally.
set -eu
URL="${1:-http://localhost:8080}"

i=0
until curl -sf "$URL/healthz" >/dev/null; do
  i=$((i + 1)); [ "$i" -gt 90 ] && { echo "healthz never became ready"; exit 1; }
  sleep 2
done

# EICAR test string (harmless, every AV engine flags it). Split so this file itself isn't flagged.
EICAR='X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR''-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'

check() { # name, expected substring, actual
  case "$3" in *"$2"*) echo "ok   $1: $3" ;; *) echo "FAIL $1: expected $2, got $3"; exit 1 ;; esac
}

check eicar '"result": "infected"' "$(printf '%s' "$EICAR" | curl -s --data-binary @- "$URL/scan")"
check clean '"result": "clean"' "$(printf 'plain text, nothing to see' | curl -s --data-binary @- "$URL/scan")"
check oversize 413 "$(head -c 31457281 /dev/zero | curl -s -o /dev/null -w '%{http_code}' --data-binary @- "$URL/scan")"
