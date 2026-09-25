-- 0500: AI worker isolation hardening + watchlist embedding bookkeeping.
-- Justification for every grant: docs/AI-ARCHITECTURE.md ("Database privileges of ksp_ai").

-- ---- Watchlist reference embeddings are computed by the isolated worker ------------------------------
ALTER TABLE ai_watchlist_entries
  ADD COLUMN embedding_error text,          -- worker could not compute an embedding (no face found, unreadable image)
  ADD COLUMN embedded_at     timestamptz;
-- The worker fills embedding/model_id for FACE entries whose embedding IS NULL; it cannot change label/image/list.
GRANT UPDATE (embedding, model_id, embedding_error, embedded_at) ON ai_watchlist_entries TO ksp_ai;

-- ---- Jobs: heartbeat / stale-job detection needs to read the columns the worker itself maintains ------
GRANT SELECT (progress, stats, error, started_at, finished_at) ON ai_jobs TO ksp_ai;

-- ---- Detections: the worker may NOT set any review/human column, even at INSERT time ------------------
-- 0004 granted table-wide INSERT; narrow it to the machine-produced columns. review_status defaults to PENDING.
REVOKE INSERT ON ai_detections FROM ksp_ai;
GRANT INSERT (id, job_id, evidence_id, model_id, model_code, model_version, task, label, confidence, threshold,
              frame_time_ms, frame_number, bbox_x, bbox_y, bbox_w, bbox_h, track_id, attributes, embedding, crop_key)
  ON ai_detections TO ksp_ai;

-- Every detection must belong to a RUNNING job for the same evidence item and one of the job's models;
-- model code/version are copied from the model registry (a worker cannot mislabel provenance).
CREATE OR REPLACE FUNCTION ai_detection_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  j ai_jobs;
  m ai_models;
BEGIN
  SELECT * INTO j FROM ai_jobs WHERE id = NEW.job_id;
  IF j.id IS NULL OR j.evidence_id <> NEW.evidence_id THEN
    RAISE EXCEPTION 'detection does not match its job/evidence' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF j.status <> 'RUNNING' THEN
    RAISE EXCEPTION 'detections can only be added to a RUNNING job (job is %)', j.status USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT (NEW.model_id = ANY (j.model_ids)) THEN
    RAISE EXCEPTION 'detection model is not one of the job models' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO m FROM ai_models WHERE id = NEW.model_id;
  NEW.model_code := m.code;
  NEW.model_version := m.version;
  NEW.task := m.task;
  NEW.review_status := 'PENDING';
  NEW.reviewed_by := NULL; NEW.reviewed_at := NULL; NEW.review_comment := NULL; NEW.corrected_label := NULL;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ai_detection_guard() FROM PUBLIC;
CREATE TRIGGER ai_detections_guard BEFORE INSERT ON ai_detections FOR EACH ROW EXECUTE FUNCTION ai_detection_guard();

-- Detections are evidence-derived records: never deleted by the application (reviews are append-only events).
REVOKE DELETE, TRUNCATE ON ai_detections FROM ksp_app;

-- Review queue / listing indexes.
CREATE INDEX ai_detections_queue ON ai_detections (review_status, confidence DESC) WHERE review_status IN ('PENDING','NEEDS_SECOND_REVIEW');
CREATE INDEX ai_training_exports_created ON ai_training_exports (created_at DESC);
CREATE INDEX ai_watchlist_entries_pending ON ai_watchlist_entries (created_at) WHERE embedding IS NULL AND embedding_error IS NULL;
