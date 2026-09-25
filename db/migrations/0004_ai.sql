-- 0004: AI analysis platform (logically isolated) and human-in-the-loop review.
--
-- Isolation: the AI worker connects as ksp_ai which can ONLY
--   * read ai_models, ai_jobs, watchlists and the PROXY/derived derivative rows it is told to process,
--   * update its own job progress/status columns,
--   * insert ai_detections,
--   * append audit events.
-- It cannot read evidence, users, cases, storage keys of originals, or change review decisions.
-- Storage isolation is enforced separately: the AI worker's S3 credentials only reach the derived bucket.

CREATE TABLE ai_models (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code               text NOT NULL,                 -- e.g. yolo-coco, scrfd-face, arcface, anpr-plate
  name               text NOT NULL,
  task               text NOT NULL CHECK (task IN ('FACE_DETECTION','FACE_RECOGNITION','ANPR','PERSON_DETECTION','OBJECT_DETECTION','CLASSIFICATION')),
  version            text NOT NULL,
  runtime            text NOT NULL DEFAULT 'onnxruntime',
  artifact_uri       text NOT NULL,                 -- file path / URI of the model artefact
  artifact_sha256    text,
  labels             text[] NOT NULL DEFAULT '{}',
  default_threshold  real NOT NULL DEFAULT 0.5 CHECK (default_threshold BETWEEN 0 AND 1),
  config             jsonb NOT NULL DEFAULT '{}'::jsonb,
  metrics            jsonb NOT NULL DEFAULT '{}'::jsonb, -- evaluation metrics (precision/recall) for this version
  status             text NOT NULL DEFAULT 'STAGED' CHECK (status IN ('STAGED','ACTIVE','RETIRED')),
  notes              text,
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  activated_at       timestamptz,
  retired_at         timestamptz,
  UNIQUE (code, version)
);
CREATE UNIQUE INDEX ai_models_one_active_per_task ON ai_models (task, code) WHERE status = 'ACTIVE';

CREATE TABLE ai_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_id     uuid NOT NULL REFERENCES evidence(id),
  requested_by    uuid NOT NULL REFERENCES users(id),
  tasks           text[] NOT NULL,
  status          text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','COMPLETED','FAILED','CANCELLED')),
  progress        real NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 1),
  -- Everything the isolated worker needs is snapshotted here so it never reads the evidence table.
  input           jsonb NOT NULL,                -- {derivativeBucket, derivativeKey, durationMs, frameRate, width, height}
  params          jsonb NOT NULL DEFAULT '{}'::jsonb, -- {sampleFps, thresholds:{task:0.x}, watchlistIds}
  model_ids       uuid[] NOT NULL DEFAULT '{}',
  stats           jsonb NOT NULL DEFAULT '{}'::jsonb,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  finished_at     timestamptz
);
CREATE INDEX ai_jobs_evidence ON ai_jobs (evidence_id, created_at DESC);
CREATE INDEX ai_jobs_status ON ai_jobs (status, created_at);

-- Persons of interest for face recognition (watchlist) — reference embeddings only.
CREATE TABLE ai_watchlists (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('FACE','VEHICLE')),
  org_unit_id  uuid NOT NULL REFERENCES org_units(id),
  description  text,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ai_watchlist_entries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  watchlist_id  uuid NOT NULL REFERENCES ai_watchlists(id) ON DELETE CASCADE,
  label         text NOT NULL,                  -- person name/reference, or plate number for VEHICLE
  plate_normalized text,                        -- VEHICLE: A-Z0-9 only
  embedding     real[],                         -- FACE: L2-normalised embedding from the recognition model
  model_id      uuid REFERENCES ai_models(id),
  image_key     text,                           -- reference image in derived bucket
  notes         text,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_watchlist_entries_list ON ai_watchlist_entries (watchlist_id);
CREATE INDEX ai_watchlist_entries_plate ON ai_watchlist_entries (plate_normalized) WHERE plate_normalized IS NOT NULL;

CREATE TABLE ai_detections (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id           uuid NOT NULL REFERENCES ai_jobs(id),
  evidence_id      uuid NOT NULL REFERENCES evidence(id),
  model_id         uuid NOT NULL REFERENCES ai_models(id),
  model_code       text NOT NULL,
  model_version    text NOT NULL,
  task             text NOT NULL,
  label            text NOT NULL,                -- 'person', 'car', 'face', plate text, watchlist label...
  confidence       real NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  threshold        real NOT NULL,
  frame_time_ms    bigint NOT NULL,
  frame_number     bigint,
  bbox_x           real, bbox_y real, bbox_w real, bbox_h real,  -- normalised [0,1] relative to frame
  track_id         text,
  attributes       jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {dominantColor, colorName, plateText, watchlistEntryId, similarity...}
  embedding        real[],
  crop_key         text,                         -- crop image in derived bucket
  review_status    text NOT NULL DEFAULT 'PENDING' CHECK (review_status IN ('PENDING','APPROVED','REJECTED','NEEDS_SECOND_REVIEW')),
  reviewed_by      uuid REFERENCES users(id),
  reviewed_at      timestamptz,
  review_comment   text,
  corrected_label  text,                         -- reviewer correction (feeds retraining datasets)
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_detections_evidence ON ai_detections (evidence_id, frame_time_ms);
CREATE INDEX ai_detections_review ON ai_detections (review_status, created_at);
CREATE INDEX ai_detections_label ON ai_detections (task, lower(label));
CREATE INDEX ai_detections_attrs ON ai_detections USING gin (attributes jsonb_path_ops);
CREATE INDEX ai_detections_job ON ai_detections (job_id);

CREATE TABLE ai_review_events (
  id               bigserial PRIMARY KEY,
  detection_id     uuid NOT NULL REFERENCES ai_detections(id),
  reviewer_id      uuid NOT NULL REFERENCES users(id),
  action           text NOT NULL CHECK (action IN ('APPROVE','REJECT','REQUEST_SECOND_REVIEW','COMMENT','CORRECT_LABEL')),
  previous_status  text NOT NULL,
  new_status       text NOT NULL,
  comment          text,
  corrected_label  text,
  model_id         uuid NOT NULL,
  model_version    text NOT NULL,
  confidence       real NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_review_events_detection ON ai_review_events (detection_id, created_at);
REVOKE UPDATE, DELETE, TRUNCATE ON ai_review_events FROM ksp_app;

-- Reviewed detections exported as labelled datasets for model retraining / evaluation.
CREATE TABLE ai_training_exports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task            text NOT NULL,
  model_id        uuid REFERENCES ai_models(id),
  filter          jsonb NOT NULL DEFAULT '{}'::jsonb,
  sample_count    integer NOT NULL DEFAULT 0,
  bucket          text,
  object_key      text,
  status          text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','COMPLETED','FAILED')),
  error           text,
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);

-- ---- ksp_ai least-privilege grants -------------------------------------------------------------
GRANT SELECT ON ai_models, ai_watchlists, ai_watchlist_entries TO ksp_ai;
GRANT SELECT (id, evidence_id, tasks, status, input, params, model_ids, created_at) ON ai_jobs TO ksp_ai;
GRANT UPDATE (status, progress, stats, error, started_at, finished_at) ON ai_jobs TO ksp_ai;
GRANT INSERT ON ai_detections TO ksp_ai;
GRANT SELECT (id, job_id) ON ai_detections TO ksp_ai;
