-- 1053: fixity coverage (FN-6). integrity_checks now also covers secondary copies of originals:
--   PRIMARY  = the current copy (evidence.storage_*), as before
--   RETAINED = a superseded copy kept by a tier migration (evidence_storage_copies.status = 'RETAINED')
--   DR       = a copy in the DR object store recorded by s3-replicate.ts (dr_object_copies, kind ORIGINAL)
ALTER TABLE integrity_checks ADD COLUMN copy_kind text NOT NULL DEFAULT 'PRIMARY' CHECK (copy_kind IN ('PRIMARY','RETAINED','DR'));
ALTER TABLE integrity_checks ADD COLUMN storage_copy_id bigint REFERENCES evidence_storage_copies(id);
ALTER TABLE integrity_checks ADD COLUMN dr_copy_id bigint REFERENCES dr_object_copies(id);
ALTER TABLE integrity_checks ADD CONSTRAINT integrity_checks_copy_ref CHECK (
  (copy_kind = 'PRIMARY' AND storage_copy_id IS NULL AND dr_copy_id IS NULL)
  OR (copy_kind = 'RETAINED' AND storage_copy_id IS NOT NULL AND dr_copy_id IS NULL)
  OR (copy_kind = 'DR' AND dr_copy_id IS NOT NULL AND storage_copy_id IS NULL));
CREATE INDEX integrity_checks_time ON integrity_checks (checked_at DESC);

ALTER TABLE evidence_storage_copies ADD COLUMN last_verified_at timestamptz;
CREATE INDEX evidence_last_verified ON evidence (last_verified_at NULLS FIRST) WHERE status IN ('REGISTERED','DISPOSAL_PENDING');
