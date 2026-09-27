-- 1002: ai_jobs status transition guard for the AI worker role (SEC-R10).
-- ksp_ai may only move a job forward: QUEUED -> RUNNING -> COMPLETED | FAILED | CANCELLED. A compromised AI
-- worker can therefore not revive a cancelled/finished job or re-queue one. The app role (cancellation,
-- re-analysis) is not restricted by this trigger.
CREATE OR REPLACE FUNCTION ai_jobs_status_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (current_user = 'ksp_ai' OR session_user = 'ksp_ai') AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT ((OLD.status = 'QUEUED' AND NEW.status = 'RUNNING')
         OR (OLD.status = 'RUNNING' AND NEW.status IN ('COMPLETED', 'FAILED', 'CANCELLED'))) THEN
      RAISE EXCEPTION 'ai_jobs: status transition % -> % not permitted for the AI worker', OLD.status, NEW.status
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ai_jobs_status_guard() FROM PUBLIC;
CREATE TRIGGER ai_jobs_status_guard BEFORE UPDATE OF status ON ai_jobs FOR EACH ROW EXECUTE FUNCTION ai_jobs_status_guard();
