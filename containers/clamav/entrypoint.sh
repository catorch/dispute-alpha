#!/bin/sh
set -eu
mkdir -p /run/clamav && chown clamav:clamav /run/clamav

# Refresh signatures on start. Signatures baked into the image are the fallback if the
# mirror is unreachable or rate-limits us, so a failed update never blocks startup.
freshclam --config-file=/etc/clamav/freshclam.conf --foreground --stdout || echo '{"msg":"freshclam start update failed, using baked signatures"}'

clamd --config-file=/etc/clamav/clamd.conf
freshclam --config-file=/etc/clamav/freshclam.conf -d   # daily refresh (Checks 1)

su-exec clamav python3 /app/shim.py &
# Exit when clamd or the shim dies so the platform restarts the container (tini reaps the orphans).
while kill -0 $! 2>/dev/null && pgrep -x clamd >/dev/null; do sleep 15; done
echo '{"msg":"clamd or shim exited, stopping container"}'
exit 1
