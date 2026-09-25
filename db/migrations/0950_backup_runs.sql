-- Backup run registry (ops). Written by scripts/backup/* (as ksp_app) and read by dashboards/alerts.
-- IF NOT EXISTS: the dashboards/alerts workstream may create the same table; either order must work.
CREATE TABLE IF NOT EXISTS backup_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  status       text NOT NULL DEFAULT 'RUNNING',   -- RUNNING, SUCCEEDED, FAILED
  kind         text NOT NULL,          -- PG_DUMP, PG_BASEBACKUP, S3_REPLICATION, VERIFY
  size_bytes   bigint,
  sha256       text,
  location     text,                   -- backup bucket/key (operator-only; never returned to clients)
  error        text
);
CREATE INDEX IF NOT EXISTS backup_runs_started ON backup_runs (kind, started_at DESC);
