-- 0003: devices, ingestion, evidence registry (immutable core), derivatives, lifecycle, integrity.

CREATE TABLE devices (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  serial_number        text NOT NULL UNIQUE,
  device_type          text NOT NULL DEFAULT 'BODY_WORN_CAMERA' CHECK (device_type IN ('BODY_WORN_CAMERA','DASH_CAMERA','HANDHELD','CCTV','DRONE','OTHER')),
  make                 text,
  model                text,
  firmware_version     text,
  org_unit_id          uuid NOT NULL REFERENCES org_units(id),
  assigned_officer_id  uuid REFERENCES users(id),
  status               text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','IN_REPAIR','LOST','RETIRED')),
  notes                text,
  created_by           uuid REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX devices_org ON devices (org_unit_id);
CREATE INDEX devices_officer ON devices (assigned_officer_id);
CREATE TRIGGER devices_updated BEFORE UPDATE ON devices FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Retention policies (configurable). Tier transitions are executed by the lifecycle worker.
CREATE TABLE retention_policies (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                  text NOT NULL UNIQUE,
  name                  text NOT NULL,
  description           text,
  retention_days        integer CHECK (retention_days IS NULL OR retention_days > 0), -- NULL = retain indefinitely
  archive_after_days    integer CHECK (archive_after_days IS NULL OR archive_after_days >= 0),
  long_term_after_days  integer CHECK (long_term_after_days IS NULL OR long_term_after_days >= 0),
  is_default            boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX retention_policies_one_default ON retention_policies (is_default) WHERE is_default;
CREATE TRIGGER retention_policies_updated BEFORE UPDATE ON retention_policies FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Ingestion: batches and resumable chunked upload sessions (S3 multipart under the hood).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE upload_batches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_unit_id   uuid NOT NULL REFERENCES org_units(id),
  created_by    uuid NOT NULL REFERENCES users(id),
  label         text,
  client_info   jsonb NOT NULL DEFAULT '{}'::jsonb,   -- station client name/version/host
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX upload_batches_org ON upload_batches (org_unit_id, created_at DESC);

CREATE TABLE upload_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id          uuid REFERENCES upload_batches(id),
  created_by        uuid NOT NULL REFERENCES users(id),
  org_unit_id       uuid NOT NULL REFERENCES org_units(id),
  original_filename text NOT NULL,
  declared_size     bigint NOT NULL CHECK (declared_size > 0),
  declared_mime     text,
  declared_sha256   text CHECK (declared_sha256 IS NULL OR declared_sha256 ~ '^[0-9a-f]{64}$'),
  chunk_size        integer NOT NULL CHECK (chunk_size >= 5242880),  -- S3 multipart minimum part size
  total_chunks      integer NOT NULL CHECK (total_chunks > 0),
  staging_bucket    text NOT NULL,
  staging_key       text NOT NULL,
  s3_upload_id      text,
  received_bytes    bigint NOT NULL DEFAULT 0,
  status            text NOT NULL DEFAULT 'INITIATED' CHECK (status IN ('INITIATED','UPLOADING','COMPLETING','COMPLETED','ABORTED','FAILED','EXPIRED')),
  declared_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,  -- officer, device, recorded_at, title, case, notes (from station client)
  evidence_id       uuid,
  error             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL
);
CREATE INDEX upload_sessions_batch ON upload_sessions (batch_id);
CREATE INDEX upload_sessions_status ON upload_sessions (status, updated_at);
CREATE INDEX upload_sessions_creator ON upload_sessions (created_by, created_at DESC);
CREATE TRIGGER upload_sessions_updated BEFORE UPDATE ON upload_sessions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE upload_parts (
  session_id   uuid NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
  part_number  integer NOT NULL CHECK (part_number >= 1),
  size_bytes   bigint NOT NULL,
  sha256       text NOT NULL,
  etag         text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, part_number)
);

-- Human-readable evidence numbers: KSP-<STATIONCODE>-<YYYY>-<NNNNNN>
CREATE TABLE evidence_number_counters (
  org_unit_id uuid NOT NULL REFERENCES org_units(id),
  year        integer NOT NULL,
  last_value  integer NOT NULL DEFAULT 0,
  PRIMARY KEY (org_unit_id, year)
);

-- ---------------------------------------------------------------------------------------------
-- Evidence registry. One row per ORIGINAL evidence file. Originals live in the immutable evidence bucket
-- (object lock). Derived outputs (proxies, HLS, thumbnails, AI results) are separate but linked.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE evidence (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_number     text UNIQUE,
  status              text NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED','VALIDATING','QUARANTINED','REJECTED','REGISTERED','DISPOSAL_PENDING','DISPOSED')),
  status_reason       text,
  org_unit_id         uuid NOT NULL REFERENCES org_units(id),
  org_path            ltree NOT NULL,                  -- denormalised from org_units.path for jurisdiction filtering
  upload_session_id   uuid UNIQUE REFERENCES upload_sessions(id),
  uploaded_by         uuid NOT NULL REFERENCES users(id),
  officer_id          uuid REFERENCES users(id),        -- officer who recorded the footage
  device_id           uuid REFERENCES devices(id),
  title               text,
  description         text,
  category            text,
  incident_at         timestamptz,
  original_filename   text NOT NULL,
  mime_type           text,
  size_bytes          bigint NOT NULL,
  sha256              text CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  sha512              text CHECK (sha512 IS NULL OR sha512 ~ '^[0-9a-f]{128}$'),
  storage_bucket      text,
  storage_key         text,
  storage_version_id  text,
  storage_tier        text NOT NULL DEFAULT 'ACTIVE' CHECK (storage_tier IN ('STAGING','ACTIVE','ARCHIVE','LONG_TERM')),
  object_lock_until   timestamptz,
  -- Extracted technical metadata (ffprobe + container tags + body-camera sidecar data)
  recorded_at         timestamptz,
  recorded_end_at     timestamptz,
  duration_ms         bigint,
  container_format    text,
  video_codec         text,
  audio_codec         text,
  width               integer,
  height              integer,
  frame_rate          numeric(10,4),
  bit_rate            bigint,
  gps_latitude        double precision CHECK (gps_latitude BETWEEN -90 AND 90),
  gps_longitude       double precision CHECK (gps_longitude BETWEEN -180 AND 180),
  gps_source          text,                            -- CONTAINER_TAG | SIDECAR | DECLARED | STATION
  location_text       text,
  device_metadata     jsonb NOT NULL DEFAULT '{}'::jsonb, -- vendor-specific tags from the file
  probe               jsonb,                           -- full ffprobe output (format + streams)
  media_status        text NOT NULL DEFAULT 'PENDING' CHECK (media_status IN ('PENDING','PROCESSING','READY','FAILED','UNSUPPORTED')),
  media_error         text,
  duplicate_of        uuid REFERENCES evidence(id),
  retention_policy_id uuid REFERENCES retention_policies(id),
  retain_until        timestamptz,
  legal_hold          boolean NOT NULL DEFAULT false,
  legal_hold_reason   text,
  legal_hold_by       uuid REFERENCES users(id),
  legal_hold_at       timestamptz,
  registered_at       timestamptz,
  archived_at         timestamptz,
  disposed_at         timestamptz,
  last_verified_at    timestamptz,
  search_text         tsvector,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX evidence_org_path ON evidence USING gist (org_path);
CREATE INDEX evidence_status ON evidence (status);
CREATE INDEX evidence_recorded ON evidence (recorded_at DESC);
CREATE INDEX evidence_created ON evidence (created_at DESC);
CREATE INDEX evidence_officer ON evidence (officer_id);
CREATE INDEX evidence_device ON evidence (device_id);
CREATE INDEX evidence_uploaded_by ON evidence (uploaded_by);
CREATE INDEX evidence_sha256 ON evidence (sha256);
CREATE INDEX evidence_geo ON evidence (gps_latitude, gps_longitude) WHERE gps_latitude IS NOT NULL;
CREATE INDEX evidence_search ON evidence USING gin (search_text);
CREATE INDEX evidence_title_trgm ON evidence USING gin (title gin_trgm_ops);
CREATE INDEX evidence_retain ON evidence (retain_until) WHERE status = 'REGISTERED';
CREATE TRIGGER evidence_updated BEFORE UPDATE ON evidence FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Integrity guard: once REGISTERED, identity/integrity columns can never change; evidence rows can never
-- be deleted (authorised disposal changes status to DISPOSED and removes the object, keeping the record).
CREATE OR REPLACE FUNCTION evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'evidence records cannot be deleted; use the authorised disposal workflow' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.registered_at IS NOT NULL THEN
    IF NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.sha512 IS DISTINCT FROM OLD.sha512
       OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes OR NEW.original_filename IS DISTINCT FROM OLD.original_filename
       OR NEW.evidence_number IS DISTINCT FROM OLD.evidence_number OR NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by
       OR NEW.upload_session_id IS DISTINCT FROM OLD.upload_session_id OR NEW.registered_at IS DISTINCT FROM OLD.registered_at
       OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at OR NEW.duration_ms IS DISTINCT FROM OLD.duration_ms
       OR NEW.probe IS DISTINCT FROM OLD.probe OR NEW.device_metadata IS DISTINCT FROM OLD.device_metadata
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'immutable evidence attributes cannot be modified after registration' USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- storage location may change only through tier migration (same hash verified by the worker) or disposal
    IF (NEW.storage_key IS DISTINCT FROM OLD.storage_key OR NEW.storage_bucket IS DISTINCT FROM OLD.storage_bucket)
       AND NEW.storage_tier = OLD.storage_tier AND NEW.status <> 'DISPOSED' THEN
      RAISE EXCEPTION 'evidence storage location can change only via tier migration or disposal' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.status = 'DISPOSED' THEN
      RAISE EXCEPTION 'disposed evidence is final' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.status = 'DISPOSED' AND OLD.legal_hold THEN
      RAISE EXCEPTION 'evidence under legal hold cannot be disposed' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER evidence_guard_update BEFORE UPDATE ON evidence FOR EACH ROW EXECUTE FUNCTION evidence_guard();
CREATE TRIGGER evidence_guard_delete BEFORE DELETE ON evidence FOR EACH ROW EXECUTE FUNCTION evidence_guard();
REVOKE DELETE, TRUNCATE ON evidence FROM ksp_app;

-- Full-text search vector maintenance (mutable descriptive fields + immutable identity fields).
CREATE OR REPLACE FUNCTION evidence_search_refresh() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_text :=
    setweight(to_tsvector('simple', coalesce(NEW.evidence_number,'')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.title,'')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.description,'')), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW.category,'') || ' ' || coalesce(NEW.location_text,'')), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW.original_filename,'')), 'C');
  RETURN NEW;
END $$;
CREATE TRIGGER evidence_search_tsv BEFORE INSERT OR UPDATE OF evidence_number, title, description, category, location_text, original_filename
  ON evidence FOR EACH ROW EXECUTE FUNCTION evidence_search_refresh();

-- Manual and review-approved AI tags.
CREATE TABLE evidence_tags (
  evidence_id  uuid NOT NULL REFERENCES evidence(id),
  tag          text NOT NULL CHECK (tag ~ '^[a-z0-9][a-z0-9 _:.-]{0,62}$'),
  source       text NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL','AI_APPROVED','INTEGRATION')),
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (evidence_id, tag)
);
CREATE INDEX evidence_tags_tag ON evidence_tags (tag);

-- Derived artefacts: NEVER the original. Stored in the derived bucket.
CREATE TABLE evidence_derivatives (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_id  uuid NOT NULL REFERENCES evidence(id),
  kind         text NOT NULL CHECK (kind IN ('PROXY_MP4','HLS','THUMBNAIL','POSTER','SPRITE','SNAPSHOT','AI_FRAME','AI_CROP','WATERMARKED')),
  bucket       text NOT NULL,
  object_key   text NOT NULL,              -- for HLS: prefix containing master.m3u8
  mime_type    text,
  size_bytes   bigint,
  sha256       text,
  width        integer,
  height       integer,
  meta         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by   uuid REFERENCES users(id),  -- NULL = system
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bucket, object_key)
);
CREATE INDEX evidence_derivatives_evidence ON evidence_derivatives (evidence_id, kind);

-- Background processing visibility (pg-boss executes; this table is the user-visible status record).
CREATE TABLE processing_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_id   uuid REFERENCES evidence(id),
  upload_session_id uuid REFERENCES upload_sessions(id),
  kind          text NOT NULL,             -- VALIDATE_REGISTER | MEDIA_PROCESS | TIER_MIGRATE | FIXITY_CHECK | DISPOSE ...
  status        text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','COMPLETED','FAILED','CANCELLED')),
  progress      real NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 1),
  attempts      integer NOT NULL DEFAULT 0,
  queue_job_id  text,
  error         text,
  result        jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX processing_jobs_evidence ON processing_jobs (evidence_id, created_at DESC);
CREATE INDEX processing_jobs_status ON processing_jobs (status, kind, created_at DESC);
CREATE TRIGGER processing_jobs_updated BEFORE UPDATE ON processing_jobs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Periodic and on-demand fixity (hash re-verification) of stored originals.
CREATE TABLE integrity_checks (
  id               bigserial PRIMARY KEY,
  evidence_id      uuid NOT NULL REFERENCES evidence(id),
  trigger          text NOT NULL CHECK (trigger IN ('SCHEDULED','ON_DEMAND','EXPORT','TIER_MIGRATION','RESTORE')),
  expected_sha256  text NOT NULL,
  actual_sha256    text,
  ok               boolean NOT NULL,
  error            text,
  requested_by     uuid REFERENCES users(id),
  checked_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX integrity_checks_evidence ON integrity_checks (evidence_id, checked_at DESC);
CREATE INDEX integrity_checks_failed ON integrity_checks (checked_at DESC) WHERE NOT ok;
REVOKE UPDATE, DELETE, TRUNCATE ON integrity_checks FROM ksp_app;

-- Authorised disposal requires a second, different approver (separation of duties).
CREATE TABLE disposal_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_id    uuid NOT NULL REFERENCES evidence(id),
  requested_by   uuid NOT NULL REFERENCES users(id),
  reason         text NOT NULL CHECK (length(reason) >= 10),
  authority_ref  text,                       -- court order / GO reference authorising disposal
  status         text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','EXECUTED','CANCELLED')),
  decided_by     uuid REFERENCES users(id),
  decided_at     timestamptz,
  decision_note  text,
  executed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (decided_by IS NULL OR decided_by <> requested_by)
);
CREATE UNIQUE INDEX disposal_one_open ON disposal_requests (evidence_id) WHERE status IN ('PENDING','APPROVED');
