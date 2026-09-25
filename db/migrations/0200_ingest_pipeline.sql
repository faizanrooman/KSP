-- 0200: ingestion pipeline support.

-- Registration writes an integrity_checks row (re-hash of the stored original vs. the staged upload).
ALTER TABLE integrity_checks DROP CONSTRAINT IF EXISTS integrity_checks_trigger_check;
ALTER TABLE integrity_checks ADD CONSTRAINT integrity_checks_trigger_check
  CHECK (trigger IN ('SCHEDULED','ON_DEMAND','EXPORT','TIER_MIGRATION','RESTORE','REGISTRATION'));

-- Expiry sweep (cron uploads.expire) and quarantine queue lookups.
CREATE INDEX IF NOT EXISTS upload_sessions_open_expiry ON upload_sessions (expires_at) WHERE status IN ('INITIATED','UPLOADING');
CREATE INDEX IF NOT EXISTS evidence_quarantined ON evidence (created_at DESC) WHERE status = 'QUARANTINED';
CREATE INDEX IF NOT EXISTS upload_sessions_org ON upload_sessions (org_unit_id, created_at DESC);
