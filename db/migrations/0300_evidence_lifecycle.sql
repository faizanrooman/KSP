-- 0300: evidence lifecycle bookkeeping — stored-copy registry (tier migration / disposal), legal hold history,
-- disposal execution outcome.

-- Every physical copy of an ORIGINAL that the system has ever written (one row per bucket/key/version).
-- The evidence row points at the CURRENT copy; superseded copies left behind by a tier migration (because the
-- store refused a governance-bypass delete) stay listed here as RETAINED so disposal can remove them later.
CREATE TABLE evidence_storage_copies (
  id              bigserial PRIMARY KEY,
  evidence_id     uuid NOT NULL REFERENCES evidence(id),
  tier            text NOT NULL CHECK (tier IN ('ACTIVE','ARCHIVE','LONG_TERM')),
  bucket          text NOT NULL,
  object_key      text NOT NULL,
  version_id      text,
  sha256          text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  status          text NOT NULL DEFAULT 'CURRENT' CHECK (status IN ('CURRENT','RETAINED','DELETED','DISPOSED')),
  status_note     text,
  object_lock_until timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bucket, object_key, version_id)
);
CREATE INDEX evidence_storage_copies_evidence ON evidence_storage_copies (evidence_id, created_at);
CREATE UNIQUE INDEX evidence_storage_copies_one_current ON evidence_storage_copies (evidence_id) WHERE status = 'CURRENT';
CREATE TRIGGER evidence_storage_copies_updated BEFORE UPDATE ON evidence_storage_copies FOR EACH ROW EXECUTE FUNCTION set_updated_at();
REVOKE DELETE, TRUNCATE ON evidence_storage_copies FROM ksp_app;

-- Legal hold history (append-only). evidence.legal_hold* holds the current state.
CREATE TABLE evidence_legal_hold_events (
  id            bigserial PRIMARY KEY,
  evidence_id   uuid NOT NULL REFERENCES evidence(id),
  action        text NOT NULL CHECK (action IN ('SET','RELEASED')),
  reason        text NOT NULL CHECK (length(reason) >= 5),
  actor_id      uuid NOT NULL REFERENCES users(id),
  storage_hold  text NOT NULL CHECK (storage_hold IN ('APPLIED','NOT_SUPPORTED','FAILED','NOT_APPLICABLE')),
  storage_note  text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX evidence_legal_hold_events_evidence ON evidence_legal_hold_events (evidence_id, created_at DESC);
REVOKE UPDATE, DELETE, TRUNCATE ON evidence_legal_hold_events FROM ksp_app;

-- Disposal execution outcome (an APPROVED request whose storage deletion was refused keeps its error here).
ALTER TABLE disposal_requests
  ADD COLUMN execution_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN execution_error    text,
  ADD COLUMN execution_result   jsonb;

-- Backfill the copy registry for already-registered evidence.
INSERT INTO evidence_storage_copies (evidence_id, tier, bucket, object_key, version_id, sha256, status, object_lock_until)
SELECT id, storage_tier, storage_bucket, storage_key, storage_version_id, sha256, 'CURRENT', object_lock_until
FROM evidence
WHERE storage_key IS NOT NULL AND sha256 IS NOT NULL AND storage_tier IN ('ACTIVE','ARCHIVE','LONG_TERM') AND status <> 'DISPOSED';
