-- 0501: scope the ai_detections insert guard (0500) to the isolated AI worker's role.
-- The guard constrains ksp_ai (job must be RUNNING, same evidence, one of the job's models; provenance copied from the
-- registry; review columns forced to PENDING). The application role is trusted to maintain detections (it already owns
-- the review columns) and test fixtures / imports insert historical, already-reviewed detections.
CREATE OR REPLACE FUNCTION ai_detection_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  j ai_jobs;
  m ai_models;
BEGIN
  IF NOT pg_has_role(session_user, 'ksp_ai', 'MEMBER') OR pg_has_role(session_user, 'ksp_app', 'MEMBER') THEN
    RETURN NEW;
  END IF;
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
