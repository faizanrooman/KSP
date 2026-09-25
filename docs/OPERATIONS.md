# Operations

## Routine

| When | Task | How |
|---|---|---|
| daily | check backups succeeded | Grafana / `SELECT kind,status,started_at FROM backup_runs ORDER BY started_at DESC LIMIT 10`; alert `KspBackupMissing` |
| daily | review open alerts (integrity, audit chain, brute force) | web → Alerts |
| weekly | restore verification result (`ksp-backup-verify`) | `kubectl -n ksp-vms logs job/<latest>`; `backup_runs kind=VERIFY` |
| weekly | dependency / image scan results | GitHub Security tab (Trivy, CodeQL, npm audit) |
| monthly | patch base images (refresh digests in `deploy/docker/Dockerfile`, compose, CI), rebuild | release workflow |
| quarterly | DR drill on staging (`tests/dr/drill.sh` locally; full site failover on staging) — record timings in DISASTER-RECOVERY.md | |
| quarterly | access review (users, role assignments, API clients) | admin UI / audit |
| yearly | key rotation per [SECRETS.md](SECRETS.md); certificate renewal for evidence signing | |

## Scaling

* API: HPA on CPU/memory (prod 3–24). Uploads/streaming are I/O bound — watch `ksp_api_upload_bytes_total` rate
  and pod network; raise `maxReplicas` rather than per-pod limits.
* Worker: HPA on CPU (prod 4–40); queue depth is the real signal: `SELECT name, count(*) FROM pgboss.job WHERE state IN ('created','retry') GROUP BY 1`.
  `WORKER_CONCURRENCY` per pod × replicas ≤ DB pool budget (`max_connections`).
* AI worker: replicas × `AI_WORKER_CONCURRENCY`; GPU nodes if enabled.
* PostgreSQL: vertical first; read replicas (`ksp-db-r`) for backups/reports.

## Deploy / rollback

`scripts/ops/k8s-deploy.sh <env> <tag>` (CI does this). Rollback: `kubectl -n ksp-vms rollout undo deployment/<name>`
— only to a release compatible with the current schema (migrations are forward-only).

## Key rotation

See [SECRETS.md](SECRETS.md): JWT (forces re-login), media token secret (≤ 5 min disruption), signing key (new
`SIGNING_KEY_ID`, archive old certificate), DB/S3 credentials (dual credentials, rolling restart).

## Logs

All services log JSON to stdout (pino; `service`, `reqId`, redacted secrets). Ship with the cluster log agent
(Fluent Bit / Vector) to the SIEM; retain ≥ 1 year (CERT-In: 180 days minimum). The tamper-evident audit trail is
in PostgreSQL (`audit_events`) and must not be replaced by logs.

## Monitoring

Prometheus scrapes api `:9464` and worker `:9465` (`METRICS_HOST=0.0.0.0` in containers; not routed via Ingress).
Rules: `deploy/monitoring/prometheus/rules/ksp.yml` (compose) and `PrometheusRule ksp-vms` (k8s): API down, no
healthy instances, worker down, 5xx ratio, latency, auth-failure spike, memory, event-loop lag, backup failed /
missing. Dashboards: `deploy/monitoring/grafana/dashboards/` (regenerate with `gen-dashboards.py`). Application
alerts (integrity failure, audit chain broken…) are raised by the app itself (alerts module).
