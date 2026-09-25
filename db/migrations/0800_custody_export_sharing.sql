-- 0800: chain of custody, court export, secure sharing (spec modules 13, 14, 15).
--
-- Adds build/verification bookkeeping to exports, per-item SHA-512 verification, share options (original
-- download, lockout timestamp) and checkpoint verification metadata. The tables themselves come from 0006.

-- ---------------------------------------------------------------------------------------------
-- Court exports
-- ---------------------------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS export_number_seq;

ALTER TABLE exports
  ADD COLUMN progress                 real NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 1),
  ADD COLUMN started_at               timestamptz,
  ADD COLUMN revoked_by               uuid REFERENCES users(id),
  ADD COLUMN revoked_at               timestamptz,
  ADD COLUMN revoke_reason            text,
  ADD COLUMN manifest                 jsonb,       -- copy of the signed manifest (lookup for POST /exports/verify)
  ADD COLUMN ledger_head_seq          bigint,      -- audit ledger head sealed into the manifest
  ADD COLUMN ledger_head_hash         text,
  ADD COLUMN signing_cert_fingerprint text;
CREATE INDEX exports_org_status ON exports (org_unit_id, status, created_at DESC);
CREATE INDEX exports_manifest_sha ON exports (manifest_sha256) WHERE manifest_sha256 IS NOT NULL;

ALTER TABLE export_items
  ADD COLUMN expected_sha512 text,
  ADD COLUMN verified_sha512 text,
  ADD COLUMN verify_error    text;

-- ---------------------------------------------------------------------------------------------
-- Secure sharing
-- ---------------------------------------------------------------------------------------------
ALTER TABLE shares
  ADD COLUMN allow_original boolean NOT NULL DEFAULT false,  -- recipient may download the ORIGINAL (not just the watermarked copy)
  ADD COLUMN locked_at      timestamptz;
ALTER TABLE shares ADD CONSTRAINT shares_original_requires_download CHECK (NOT allow_original OR allow_download);
CREATE INDEX shares_status_expiry ON shares (status, expires_at);
CREATE INDEX shares_org ON shares (org_unit_id, created_at DESC);

-- ---------------------------------------------------------------------------------------------
-- Audit checkpoints: signing certificate + result of the chain verification done when the checkpoint was cut.
-- (ADD COLUMN does not fire the append-only row trigger; existing rows keep NULLs.)
-- ---------------------------------------------------------------------------------------------
ALTER TABLE audit_checkpoints
  ADD COLUMN cert_fingerprint  text,
  ADD COLUMN verified_from_seq bigint,
  ADD COLUMN chain_ok          boolean;
CREATE INDEX audit_checkpoints_head ON audit_checkpoints (head_seq DESC);

-- Audit viewer filters (org unit scoping).
CREATE INDEX audit_events_org_unit ON audit_events (org_unit_id, seq DESC) WHERE org_unit_id IS NOT NULL;
