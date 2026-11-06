#!/usr/bin/env bash
# Prints the directory for local wrangler state (D1, R2, queues, Secrets Store).
# Override with DA_STATE_DIR. Defaults to .wrangler/state, unless the project's filesystem cannot
# hold private permissions (some mounted/NTFS drives), which wrangler's Secrets Store requires.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -n "${DA_STATE_DIR:-}" ]; then echo "$DA_STATE_DIR"; exit 0; fi
probe=.wrangler/.perm-probe
mkdir -p "$probe"
chmod 700 "$probe" 2>/dev/null || true
mode=$(stat -c %a "$probe" 2>/dev/null || stat -f %Lp "$probe")
rmdir "$probe"
if [ "$mode" = "700" ]; then
  echo ".wrangler/state"
else
  dir="${XDG_STATE_HOME:-$HOME/.local/state}/dispute-alpha"
  mkdir -p "$dir"
  echo "$dir"
fi
