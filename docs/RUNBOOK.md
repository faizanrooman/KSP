# Incident runbook

First for every incident: open an incident record, note the time, preserve evidence (never "clean up" audit rows,
objects or logs), and inform the evidence custodian if evidence availability or integrity is affected.

## API down {#api-down}
Symptoms: `KspApiNoHealthyInstances`, 502/503 at the ingress.
1. `kubectl -n ksp-vms get pods -l app.kubernetes.io/name=ksp-api`; `describe` for OOMKilled / probe failures.
2. `/health/ready` body shows which dependency fails (`database`, `objectStorage`) → go to that section.
3. Crash on start: `kubectl logs --previous`; typical causes: invalid configuration (message names the variable),
   missing secret key, migration not applied (run the migrate Job).
4. Recent deploy? `kubectl rollout undo deployment/ksp-api`.

## API errors / latency {#api-errors}
Check Grafana "Slowest routes"; DB saturation (`pg_stat_activity`), object store latency. Search totals on huge
match sets are slow by design (KNOWN-ISSUES).

## Database down
1. CNPG: `kubectl cnpg status ksp-db` — failover is automatic (sync standby promoted). If no instance is healthy,
   do **not** re-init volumes; follow DISASTER-RECOVERY.md (PITR / restore.sh).
2. Apps reconnect automatically; pg-boss resumes queues; verify `SELECT * FROM audit_verify()` after any unclean
   failover.

## Object storage down
Uploads fail at completion, playback fails, readiness 503. Do not delete/recreate buckets (Object Lock cannot be
re-enabled on existing buckets). If the primary site is lost, switch `S3_ENDPOINT` to the DR store (DR runbook).

## Queue backlog {#queue-backlog}
`SELECT name, state, count(*) FROM pgboss.job WHERE state IN ('created','retry','active') GROUP BY 1,2`.
Scale workers; check dead-letter queues (`<queue>.dead`) for poison jobs; look at worker logs for FFmpeg errors.
Disk full in `/work` (transcode scratch) → see *Disk full*.

## AI worker down / heartbeat stale {#ai-worker-down}
`KspAiWorkerDown` (no scrapeable AI worker on :9466), `KspAiWorkerHeartbeatStale` (no `worker_heartbeats` write for
> 2 min — process alive but PostgreSQL unreachable as `ksp_ai`?), `KspAiQueueWaitHigh` (p90 queue wait > 30 min).
System health shows "AI workers" and the reason "no live AI worker heartbeat" while AI jobs are queued. Check the
pod/container logs (`component: ai-worker`), model verification init container, `DATABASE_AI_URL` credentials and
the derived-bucket identity. Queued jobs wait safely; RUNNING jobs of a dead worker are failed by the stale-job
reaper (`WORKER_LOST`) and can be re-requested. Add capacity (`AI_WORKER_CONCURRENCY` / replicas) for queue wait.

## Integrity failure alert
A fixity check found SHA-256 ≠ registered hash. **Do not modify or re-upload.** Record the evidence number,
compare with the DR copy (`s3-replicate.ts --verify-only`), check `evidence_storage_copies` for another verified
copy, inform the custodian and legal. The failure is already in the custody trail.

## Audit chain broken
`audit_verify()` returns `first_bad_seq`. Treat as a security incident (someone with DB superuser or disk access
edited history). Freeze DB superuser access, snapshot the database (do not repair), compare with the latest
verified backup (verify-backup reports the head hash of each backup) to bound the tampering window, escalate to CERT.

## Backup failed / missing {#backup-failed}
`kubectl -n ksp-vms logs job/<ksp-pg-backup-…>`; `backup_runs.error`. Common: backup store credentials, full
`/work` ephemeral volume, DR network policy CIDR. Re-run: `kubectl -n ksp-vms create job --from=cronjob/ksp-pg-backup manual-$(date +%s)`.
A failed **verification** means the backup is not restorable — page, investigate before the next retention prune.

## Auth attack {#auth-attack}
`KspAuthFailureSpike`: lockouts/IP throttling are automatic; check source IPs in the audit log (LOGIN_FAILED,
ACCOUNT_LOCKED); block at the WAF if needed.

## Disk full
* Worker `/work`: sized per `WORKER_CONCURRENCY` x largest upload x 2; old per-job directories indicate crashed
  jobs — they are safe to delete (scratch only, never evidence).
* **Lesson learned (development):** test runs once leaked ~11 GB of fixtures in `/tmp` and thousands of
  10-year-Object-Locked test objects in the S3 store (later ~17 GB cleared by hand). Rules: tests and drills use
  `OBJECT_LOCK_DAYS=1`, per-run temp dirs removed on teardown, drills delete their buckets
  (`tests/dr/drill.sh` cleans up with governance bypass). Never run test suites against production buckets.
* PostgreSQL volume: WAL archiving stuck (archive target unreachable) fills `pg_wal` — fix the archive target first.
