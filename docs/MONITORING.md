# Monitoring & Performance (spec module 19)

Status: metrics, health aggregation, heartbeats and alerting are implemented and tested on the dev host.
The **99.5 % monthly availability target is NOT claimed as met** — it has not been measured in any deployed
environment (UNVERIFIED).

## Service health — `GET /api/v1/system/health` (`system:monitor`)
Aggregates, with `status ok | degraded | down` and human-readable `reasons[]`:

* `api` — pid, Node version, uptime, RSS/heap, version (`KSP_VERSION`);
* `database` — reachability + latency, server version, size, `pg_is_in_recovery`, connections vs
  `max_connections`, API pool (total/idle/waiting), replication lag from `pg_stat_replication` (reported as
  `null` = "not observable" when the app role lacks `pg_monitor`, never as 0);
* `objectStorage` — HeadBucket on all seven buckets with latency;
* `queues` — per pg-boss queue: waiting (created+retry), active, completed/failed 24 h, age of oldest due job;
  dead-letter depth (`*.dead`) is a degraded reason;
* `workers` — `worker_heartbeats` rows (≤ 1 day), alive if seen within 90 s; no live worker → degraded;
* `backups` — `backup_runs` (populated by the backup/DR tooling): last successful run and age; no run
  recorded or none successful within 26 h → degraded;
* `auditLedger` — head seq/time, last signed checkpoint, events since, last incremental/full chain
  verification from the alert evaluator (`firstBadSeq` → degraded);
* `storage` — latest snapshot per bucket, by tier, % of declared capacity, 30-day trend, growth/day;
* `openAlerts` by severity; `alertChannels` (in-app / webhook configured? / e-mail NOT_IMPLEMENTED).

`/health/live` and `/health/ready` (public, unchanged) remain the load-balancer probes.

`GET /api/v1/system/metrics-summary` (`system:monitor`) — per-instance sliding 15-minute window: requests,
req/min, p50/p95/p99/mean latency (bucket interpolation, as `histogram_quantile`), 5xx and 4xx rates;
since-start totals; ten slowest routes by mean latency.

Web: `/system/health` (Administration → System health) renders all of the above and refreshes every 30 s.

## Heartbeats
`worker_heartbeats (id = <service>:<host>:<pid>, service, hostname, pid, version, started_at, last_seen_at,
info)`. The worker (`apps/worker/src/lib/monitoring.ts`, started from `main.ts`) upserts every 30 s.
**AI worker hook** (not wired by this workstream — `apps/ai-worker` is owned elsewhere): `ksp_ai` has
`SELECT, INSERT, UPDATE` on the table; call `writeHeartbeat(db, {id, service: 'ksp-ai-worker', …})` from
`@ksp/core` on a 30 s interval.

## Prometheus metrics
API — served on `127.0.0.1:METRICS_PORT` (not via the public ingress):

| Metric | Type | Labels |
|---|---|---|
| `ksp_api_http_request_duration_seconds` | histogram | method, route, status |
| `ksp_api_http_requests_total` | counter | method, route, status |
| `ksp_api_auth_failures_total` | counter | reason (bad_password, unknown_user, ip_throttled, mfa) |
| `ksp_api_active_sessions` | gauge | — (non-revoked, non-expired sessions; DB query at scrape) |
| `ksp_api_db_pool_connections` | gauge | state (total, idle, waiting) |
| `ksp_api_upload_bytes_total` | counter | — (successful chunk PUT content-length) |
| `ksp_api_upload_sessions_total` | counter | event (created, completed) |
| `ksp_api_*` process/Node defaults | | |

Worker — `127.0.0.1:METRICS_PORT+1`:

| Metric | Type | Labels |
|---|---|---|
| `ksp_worker_jobs_processed_total` | counter | queue, outcome (completed, failed) — every `boss.work` handler is wrapped |
| `ksp_worker_job_duration_seconds` | histogram | queue |
| `ksp_worker_ffmpeg_duration_seconds` | histogram | outcome — via the `mediaObservers.onFfmpeg` hook in `@ksp/core` |
| `ksp_queue_depth` | gauge | queue, state (queued, active, failed_24h) — DB at scrape |
| `ksp_queue_oldest_job_age_seconds` | gauge | queue |
| `ksp_fixity_checks_24h` | gauge | result (ok, failed) |
| `ksp_worker_heartbeat_timestamp_seconds` | gauge | — |

AI worker hooks (documented, not implemented here): `ksp_ai_jobs_processed_total{task,outcome}`,
`ksp_ai_inference_duration_seconds{model}` on its own metrics port.

## SLO: 99.5 % monthly availability
* **Measurement**: an external synthetic probe (Prometheus blackbox exporter or equivalent, outside the
  cluster) requests `GET /health/ready` every 30 s from at least two locations. A minute is *bad* if the
  majority of probes in it fail or take > 5 s. Availability = good minutes / total minutes per calendar month.
  Planned maintenance counts against the budget unless explicitly excluded in the service agreement.
* **Error budget**: 0.5 % of a 30-day month = **3 h 36 min** (31-day month: 3 h 43 min; 43.8 h/year ≈
  3 h 39 min average per month).
* **Secondary SLI** (API quality): ratio of non-5xx responses from `ksp_api_http_requests_total`, excluding
  `/health/*`; target ≥ 99.5 %.
* **Alerting thresholds** (Prometheus rules; burn-rate on the probe SLI):
  * page: 14.4× burn over 1 h AND 5 min (2 % of monthly budget in 1 h);
  * page: 6× burn over 6 h AND 30 min;
  * ticket: 1× burn over 3 days;
  * `ksp_queue_oldest_job_age_seconds > 3600` for 10 min (mirrors QUEUE_BACKLOG);
  * `time() - ksp_worker_heartbeat_timestamp_seconds > 120` (worker down);
  * `histogram_quantile(0.95, sum by (le) (rate(ksp_api_http_request_duration_seconds_bucket{route!~"/health.*"}[5m]))) > 1` for 10 min;
  * `ksp_api_db_pool_connections{state="waiting"} > 0` for 5 min.
* **Status: UNVERIFIED** — no probe is deployed; Prometheus rules are specified here, not deployed or tested
  (Docker/k8s unavailable on the dev host). In-app alerts (QUEUE_BACKLOG, STORAGE_THRESHOLD, AUDIT_CHAIN_BROKEN,
  worker heartbeat on the health page) work without Prometheus.

## Database performance note
`0901_ops_disable_jit.sql` sets `jit = off` for the application database. Jurisdiction filters inflate
planner cost estimates past `jit_above_cost`, and LLVM compilation dominated query time (dashboard evidence
totals on 50k rows: 454 ms with JIT, 31 ms without; full dashboard 1.3 s → 75–82 ms). JIT only benefits long
analytical scans, which this system does not run interactively.

## Logs
Structured JSON (pino) from API and worker (`LOG_LEVEL`), request id in every HTTP log line and error body.
Shipping/retention of logs is a deployment concern (see deploy/, UNVERIFIED).
