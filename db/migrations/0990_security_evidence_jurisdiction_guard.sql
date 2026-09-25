-- Security testing workstream (SEC-06): evidence jurisdiction is immutable after registration.
-- evidence.org_unit_id / org_path decide who may see an item (evidenceVisibleSql). No application code changes
-- them after registration (ADR 7: jurisdiction never moves silently), but the evidence_guard trigger did not
-- protect them, so a compromised ksp_app connection (or an injection bug) could move evidence into another
-- jurisdiction without a trace in the integrity columns. Enforce it in the database for every role.
CREATE OR REPLACE FUNCTION evidence_jurisdiction_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.registered_at IS NOT NULL
     AND (NEW.org_unit_id IS DISTINCT FROM OLD.org_unit_id OR NEW.org_path IS DISTINCT FROM OLD.org_path) THEN
    RAISE EXCEPTION 'evidence jurisdiction (org_unit_id/org_path) is immutable after registration' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER evidence_jurisdiction_guard BEFORE UPDATE OF org_unit_id, org_path ON evidence
  FOR EACH ROW EXECUTE FUNCTION evidence_jurisdiction_guard();
