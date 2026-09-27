-- 1052: registry of copies written to the DR object store by scripts/backup/s3-replicate.ts (OPS-5).
-- Used by the dr.dispose-sweep cron / CLI to delete DR copies of DISPOSED evidence (disposal must reach every copy),
-- and by the fixity sweep to verify DR copies of originals (FN-6). Rows are never deleted (status DELETED keeps the
-- history); ksp_app may insert/update.
CREATE TABLE dr_object_copies (
  id            bigserial PRIMARY KEY,
  evidence_id   uuid REFERENCES evidence(id),
  kind          text NOT NULL CHECK (kind IN ('ORIGINAL','DERIVED')),
  bucket        text NOT NULL,             -- bucket name IN THE DR STORE (DR_BUCKET_PREFIX applied)
  object_key    text NOT NULL,
  version_id    text,                      -- version written by the replication (NULL: unversioned DR bucket)
  sha256        text CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes    bigint,
  status        text NOT NULL DEFAULT 'PRESENT' CHECK (status IN ('PRESENT','DELETED','DELETE_FAILED')),
  attempts      integer NOT NULL DEFAULT 0,
  last_error    text,
  last_verified_at timestamptz,
  replicated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (bucket, object_key, version_id)
);
CREATE INDEX dr_object_copies_evidence ON dr_object_copies (evidence_id);
CREATE INDEX dr_object_copies_open ON dr_object_copies (status, evidence_id) WHERE status <> 'DELETED';
CREATE TRIGGER dr_object_copies_updated BEFORE UPDATE ON dr_object_copies FOR EACH ROW EXECUTE FUNCTION set_updated_at();
REVOKE DELETE, TRUNCATE ON dr_object_copies FROM ksp_app;
