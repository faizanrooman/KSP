-- 0200: ingestion pipeline support.

-- pg-boss job queue schema. ksp_app is DML-only and cannot CREATE schemas in the database, so the
-- migration role pre-creates the schema and lets ksp_app create pg-boss' own tables inside it
-- (pg-boss is started with createSchema=false; see packages/core/src/queue.ts).
CREATE SCHEMA IF NOT EXISTS pgboss;
GRANT USAGE, CREATE ON SCHEMA pgboss TO ksp_app;

-- Registration writes an integrity_checks row (re-hash of the stored original vs. the staged upload).
ALTER TABLE integrity_checks DROP CONSTRAINT IF EXISTS integrity_checks_trigger_check;
ALTER TABLE integrity_checks ADD CONSTRAINT integrity_checks_trigger_check
  CHECK (trigger IN ('SCHEDULED','ON_DEMAND','EXPORT','TIER_MIGRATION','RESTORE','REGISTRATION'));

-- Expiry sweep (cron uploads.expire) and quarantine queue lookups.
CREATE INDEX IF NOT EXISTS upload_sessions_open_expiry ON upload_sessions (expires_at) WHERE status IN ('INITIATED','UPLOADING');
CREATE INDEX IF NOT EXISTS evidence_quarantined ON evidence (created_at DESC) WHERE status = 'QUARANTINED';
CREATE INDEX IF NOT EXISTS upload_sessions_org ON upload_sessions (org_unit_id, created_at DESC);
