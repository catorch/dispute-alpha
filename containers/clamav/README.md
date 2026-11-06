# containers/clamav

ClamAV scanner used by the `doc-scan` consumer in `da-jobs` (`ClamAvContainer`). Alpine + clamd + freshclam + a stdlib Python HTTP shim. About 200 MB with baked signatures.

## Contract (the Worker depends on it)

| Request | Response |
|---|---|
| `POST /scan`, body = raw file bytes (Content-Length or chunked) | `200 {"result":"clean"}` or `200 {"result":"infected","signature":"<name>"}` |
| scanner error (clamd down, timeout, clamd ERROR) | `503 {"result":"error","message":"..."}`. Treat as retryable, keep the file in quarantine |
| body > 30 MiB | `413 {"result":"error","message":"..."}` |
| `GET /healthz` | `200` when clamd answers `PING`, else `503` |

Files are streamed to clamd with `INSTREAM` over the unix socket. Nothing is written to disk and no file content is logged.

## Signatures

- Baked in at build time, so a cold start works even if the ClamAV mirror is down or rate-limiting.
- `freshclam` runs at container start (failure is logged, baked set is used), then as a daemon checking once a day and telling clamd to reload.
- Rebuild the image (any deploy of `da-jobs`) to refresh the baked set.

## Process model

`tini` → `entrypoint.sh` → clamd (daemon) + freshclam (daemon) + shim. If clamd or the shim dies, the container exits with code 1 so the platform restarts it.

## Local test

```sh
docker build -t da-clamav containers/clamav
docker run --rm -d --name clamav -p 8080:8080 da-clamav
containers/clamav/smoke.sh http://localhost:8080   # EICAR -> infected, text -> clean, 30 MiB+1 -> 413
docker rm -f clamav && docker rmi da-clamav
```

The same check runs in CI (`.github/workflows/pr.yml`, job `clamav`).
