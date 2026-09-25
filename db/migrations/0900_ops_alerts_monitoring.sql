-- 0900: operations — alert evaluation cursors, alert delivery log, worker heartbeats, backup runs,
-- report-run metadata, and indexes for dashboard/alert queries.

-- Default alert rules (idempotent; production does not run the dev seed). Thresholds live in config.
INSERT INTO alert_rules (code, name, severity, config) VALUES
  ('UPLOAD_FAILED', 'Failed uploads', 'WARNING', '{}'),
  ('PROCESSING_FAILED', 'Media processing errors', 'WARNING', '{}'),
  ('STORAGE_THRESHOLD', 'Storage utilisation threshold', 'CRITICAL', '{}'),
  ('INTEGRITY_FAILURE', 'Evidence integrity (hash) failure', 'CRITICAL', '{}'),
  ('EXCESSIVE_DOWNLOADS', 'Excessive downloads/exports by a user', 'WARNING', '{"perHour": 20}'),
  ('AUTH_BRUTE_FORCE', 'Brute-force login attempts', 'CRITICAL', '{"failuresPer15Min": 20}'),
  ('AUDIT_CHAIN_BROKEN', 'Audit ledger chain verification failure', 'CRITICAL', '{"fullVerifyEveryHours": 24}'),
  ('POLICY_VIOLATION', 'Access policy violations (denied evidence access)', 'WARNING', '{"deniedPer15Min": 10}'),
  ('AI_FAILURE', 'AI analysis failures', 'WARNING', '{}'),
  ('QUEUE_BACKLOG', 'Processing queue backlog', 'WARNING', '{"maxQueued": 500, "maxAgeMinutes": 60}')
ON CONFLICT (code) DO NOTHING;

-- Alert fan-out bookkeeping: notified_at is cleared when an open alert escalates in severity.
ALTER TABLE alerts ADD COLUMN notified_at timestamptz;
ALTER TABLE alerts ADD COLUMN auto_resolved boolean NOT NULL DEFAULT false;
CREATE INDEX alerts_org_unit ON alerts (org_unit_id, status) WHERE org_unit_id IS NOT NULL;
CREATE INDEX alerts_rule_status ON alerts (rule_code, status, last_seen_at DESC);
CREATE INDEX alerts_pending_notify ON alerts (first_seen_at) WHERE notified_at IS NULL AND status = 'OPEN';

-- Per-rule evaluation watermark (alerts.evaluate cron). watermark = upper bound of the last evaluated
-- window; last_seq = last audit seq verified by AUDIT_CHAIN_BROKEN; state = rule-specific bookkeeping.
CREATE TABLE alert_cursors (
  rule_code    text PRIMARY KEY,
  watermark    timestamptz NOT NULL,
  last_seq     bigint,
  state        jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Outbound delivery attempts (webhook / email). SKIPPED rows record that a channel is not configured.
CREATE TABLE alert_deliveries (
  id          bigserial PRIMARY KEY,
  alert_id    uuid NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  channel     text NOT NULL CHECK (channel IN ('IN_APP','WEBHOOK','EMAIL')),
  status      text NOT NULL CHECK (status IN ('SENT','FAILED','SKIPPED')),
  recipients  integer,
  detail      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX alert_deliveries_alert ON alert_deliveries (alert_id, created_at DESC);
REVOKE UPDATE, DELETE, TRUNCATE ON alert_deliveries FROM ksp_app;

-- Liveness of background processes: each worker (and the AI worker) upserts its row every 30 s.
CREATE TABLE worker_heartbeats (
  id            text PRIMARY KEY,          -- <service>:<hostname>:<pid>
  service       text NOT NULL,             -- ksp-worker | ksp-ai-worker
  hostname      text NOT NULL,
  pid           integer NOT NULL,
  version       text,
  started_at    timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  info          jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX worker_heartbeats_seen ON worker_heartbeats (service, last_seen_at DESC);
GRANT SELECT, INSERT, UPDATE ON worker_heartbeats TO ksp_ai;

-- Backup/restore runs — populated by the backup & DR tooling; read by /system/health.
CREATE TABLE backup_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  status       text NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','SUCCEEDED','FAILED')),
  kind         text NOT NULL,             -- e.g. DB_BASE, DB_WAL, OBJECTS, CONFIG, RESTORE_TEST
  size_bytes   bigint,
  sha256       text,
  location     text,                      -- operator-facing location label (never returned to non-admins)
  error        text
);
CREATE INDEX backup_runs_kind_time ON backup_runs (kind, started_at DESC);
CREATE INDEX backup_runs_time ON backup_runs (started_at DESC);

-- Reports: size, timings, frozen requester scope and org filter.
ALTER TABLE report_runs ADD COLUMN size_bytes bigint;
ALTER TABLE report_runs ADD COLUMN started_at timestamptz;
ALTER TABLE report_runs ADD COLUMN org_unit_id uuid REFERENCES org_units(id);
ALTER TABLE report_runs ADD COLUMN download_count integer NOT NULL DEFAULT 0;
-- SHA-256 of the canonical CSV serialisation of the report rows (printed in PDF footers); sha256 = file hash.
ALTER TABLE report_runs ADD COLUMN content_sha256 text;
CREATE INDEX report_runs_status ON report_runs (status, created_at);

-- Storage snapshots: how the numbers were obtained (S3 listing vs database sums) and the DB-side figures
-- recorded alongside every S3 listing so drift between the catalogue and the object store is visible.
ALTER TABLE storage_snapshots ADD COLUMN source text NOT NULL DEFAULT 'S3_LIST' CHECK (source IN ('S3_LIST','DB_SUM'));
ALTER TABLE storage_snapshots ADD COLUMN db_object_count bigint;
ALTER TABLE storage_snapshots ADD COLUMN db_total_bytes bigint;
CREATE INDEX storage_snapshots_bucket_time ON storage_snapshots (bucket, captured_at DESC);

-- Alert/dashboard query support.
CREATE INDEX login_attempts_failed_time ON login_attempts (created_at DESC) WHERE NOT success;
CREATE INDEX processing_jobs_failed_time ON processing_jobs (finished_at DESC) WHERE status = 'FAILED';
CREATE INDEX ai_jobs_failed_time ON ai_jobs (finished_at DESC) WHERE status = 'FAILED';
CREATE INDEX upload_sessions_failed_time ON upload_sessions (updated_at DESC) WHERE status = 'FAILED';
CREATE INDEX evidence_registered_at ON evidence (registered_at DESC) WHERE registered_at IS NOT NULL;
