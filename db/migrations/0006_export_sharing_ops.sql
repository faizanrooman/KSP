-- 0006: court export, secure sharing, alerts, reports, storage metrics.

CREATE TABLE exports (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  export_number     text NOT NULL UNIQUE,
  created_by        uuid NOT NULL REFERENCES users(id),
  org_unit_id       uuid NOT NULL REFERENCES org_units(id),
  case_id           uuid REFERENCES cases(id),
  purpose           text NOT NULL,
  court_name        text,
  court_case_number text,
  recipient         text,
  options           jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {includeOriginal, includeWatermarked, includeCustody, includeFactSheet, watermarkText}
  status            text NOT NULL DEFAULT 'PENDING_APPROVAL' CHECK (status IN ('PENDING_APPROVAL','APPROVED','REJECTED','PROCESSING','READY','FAILED','EXPIRED','REVOKED')),
  approved_by       uuid REFERENCES users(id),
  approved_at       timestamptz,
  decision_note     text,
  bucket            text,
  object_key        text,
  size_bytes        bigint,
  sha256            text,                          -- hash of the package (zip) itself
  manifest_sha256   text,                          -- hash of manifest.json inside the package
  signature         text,                          -- detached signature over the manifest (base64)
  signature_alg     text,
  signing_key_id    text,
  error             text,
  download_count    integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  expires_at        timestamptz,
  CHECK (approved_by IS NULL OR approved_by <> created_by)
);
CREATE INDEX exports_creator ON exports (created_by, created_at DESC);
CREATE INDEX exports_status ON exports (status, created_at DESC);

CREATE TABLE export_items (
  export_id         uuid NOT NULL REFERENCES exports(id) ON DELETE CASCADE,
  evidence_id       uuid NOT NULL REFERENCES evidence(id),
  expected_sha256   text NOT NULL,
  verified_sha256   text,
  verified_ok       boolean,
  verified_at       timestamptz,
  PRIMARY KEY (export_id, evidence_id)
);

-- ---------------------------------------------------------------------------------------------
-- Secure sharing. External recipients get a link token + access code; both are stored hashed.
-- Media is only ever served through the API with short-lived signed tokens — never public storage URLs.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE shares (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by         uuid NOT NULL REFERENCES users(id),
  org_unit_id        uuid NOT NULL REFERENCES org_units(id),
  case_id            uuid REFERENCES cases(id),
  recipient_type     text NOT NULL CHECK (recipient_type IN ('INTERNAL_USER','EXTERNAL')),
  recipient_user_id  uuid REFERENCES users(id),
  recipient_name     text,
  recipient_email    citext,
  recipient_org      text,                    -- e.g. Public Prosecutor office, FSL, Court
  purpose            text NOT NULL,
  allow_download     boolean NOT NULL DEFAULT false,
  allow_print        boolean NOT NULL DEFAULT false,
  watermark          boolean NOT NULL DEFAULT true,
  max_views          integer CHECK (max_views IS NULL OR max_views > 0),
  view_count         integer NOT NULL DEFAULT 0,
  download_count     integer NOT NULL DEFAULT 0,
  token_hash         text UNIQUE,             -- sha256 of external link token
  access_code_hash   text,                    -- argon2id of the out-of-band access code
  failed_code_attempts integer NOT NULL DEFAULT 0,
  status             text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED','EXPIRED','LOCKED')),
  expires_at         timestamptz NOT NULL,
  revoked_by         uuid REFERENCES users(id),
  revoked_at         timestamptz,
  revoke_reason      text,
  last_accessed_at   timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK ((recipient_type = 'INTERNAL_USER' AND recipient_user_id IS NOT NULL)
      OR (recipient_type = 'EXTERNAL' AND recipient_email IS NOT NULL AND token_hash IS NOT NULL AND access_code_hash IS NOT NULL))
);
CREATE INDEX shares_creator ON shares (created_by, created_at DESC);
CREATE INDEX shares_recipient ON shares (recipient_user_id) WHERE recipient_user_id IS NOT NULL;

CREATE TABLE share_items (
  share_id     uuid NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  evidence_id  uuid NOT NULL REFERENCES evidence(id),
  PRIMARY KEY (share_id, evidence_id)
);
CREATE INDEX share_items_evidence ON share_items (evidence_id);

CREATE TABLE share_access_log (
  id           bigserial PRIMARY KEY,
  share_id     uuid NOT NULL REFERENCES shares(id),
  evidence_id  uuid REFERENCES evidence(id),
  action       text NOT NULL CHECK (action IN ('OPEN','VIEW','STREAM','DOWNLOAD','PRINT','DENIED','CODE_FAILED')),
  ip           inet,
  user_agent   text,
  detail       text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX share_access_log_share ON share_access_log (share_id, created_at DESC);
REVOKE UPDATE, DELETE, TRUNCATE ON share_access_log FROM ksp_app;

-- ---------------------------------------------------------------------------------------------
-- Alerts, reports, storage metrics
-- ---------------------------------------------------------------------------------------------
CREATE TABLE alert_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,     -- UPLOAD_FAILED, PROCESSING_FAILED, STORAGE_THRESHOLD, INTEGRITY_FAILURE, EXCESSIVE_DOWNLOADS, AUTH_BRUTE_FORCE, AUDIT_CHAIN_BROKEN, POLICY_VIOLATION
  name        text NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  severity    text NOT NULL DEFAULT 'WARNING' CHECK (severity IN ('INFO','WARNING','CRITICAL')),
  config      jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE alerts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_code         text NOT NULL,
  severity          text NOT NULL CHECK (severity IN ('INFO','WARNING','CRITICAL')),
  title             text NOT NULL,
  message           text NOT NULL,
  resource_type     text,
  resource_id       text,
  org_unit_id       uuid REFERENCES org_units(id),
  dedupe_key        text,
  occurrences       integer NOT NULL DEFAULT 1,
  status            text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ACKNOWLEDGED','RESOLVED')),
  acknowledged_by   uuid REFERENCES users(id),
  acknowledged_at   timestamptz,
  resolved_by       uuid REFERENCES users(id),
  resolved_at       timestamptz,
  resolution_note   text,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX alerts_dedupe_open ON alerts (dedupe_key) WHERE status <> 'RESOLVED' AND dedupe_key IS NOT NULL;
CREATE INDEX alerts_status ON alerts (status, severity, last_seen_at DESC);

CREATE TABLE report_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_type  text NOT NULL,
  params       jsonb NOT NULL DEFAULT '{}'::jsonb,
  format       text NOT NULL CHECK (format IN ('CSV','PDF','JSON')),
  status       text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','COMPLETED','FAILED')),
  row_count    integer,
  bucket       text,
  object_key   text,
  sha256       text,
  error        text,
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
CREATE INDEX report_runs_creator ON report_runs (created_by, created_at DESC);

CREATE TABLE storage_snapshots (
  id           bigserial PRIMARY KEY,
  captured_at  timestamptz NOT NULL DEFAULT now(),
  bucket       text NOT NULL,
  tier         text NOT NULL,
  object_count bigint NOT NULL,
  total_bytes  bigint NOT NULL,
  capacity_bytes bigint
);
CREATE INDEX storage_snapshots_time ON storage_snapshots (captured_at DESC);
