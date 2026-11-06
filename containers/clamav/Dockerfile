# ClamAV scanner for the doc-scan queue (spec §9, task 12.3). HTTP shim on :8080.
FROM alpine:3.22

RUN apk add --no-cache clamav-daemon freshclam python3 su-exec tini \
 && mkdir -p /run/clamav /var/lib/clamav && chown clamav:clamav /run/clamav /var/lib/clamav

COPY clamd.conf freshclam.conf /etc/clamav/
COPY shim.py /app/shim.py
COPY --chmod=755 entrypoint.sh /entrypoint.sh

# Bake a signature set so a cold start works even if the mirror is down (refreshed at start + daily).
RUN freshclam --config-file=/etc/clamav/freshclam.conf --foreground --stdout

EXPOSE 8080
ENTRYPOINT ["/sbin/tini", "--", "/entrypoint.sh"]
