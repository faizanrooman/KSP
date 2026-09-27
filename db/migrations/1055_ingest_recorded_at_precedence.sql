-- 1055: recorded-at precedence (FN-5). The container's creation_time (camera clock written into the file) wins over
-- the client-declared value; the declared value is kept separately, and a difference of more than 5 minutes is
-- flagged (recorded_at_discrepancy_seconds) for the UI and the custody record. Immutable after registration,
-- like recorded_at itself.
ALTER TABLE evidence ADD COLUMN declared_recorded_at timestamptz;
ALTER TABLE evidence ADD COLUMN recorded_at_source text CHECK (recorded_at_source IN ('CONTAINER_TAG','DECLARED'));
ALTER TABLE evidence ADD COLUMN recorded_at_discrepancy_seconds integer;

CREATE OR REPLACE FUNCTION evidence_recorded_at_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.registered_at IS NOT NULL
     AND (NEW.declared_recorded_at IS DISTINCT FROM OLD.declared_recorded_at OR NEW.recorded_at_source IS DISTINCT FROM OLD.recorded_at_source
          OR NEW.recorded_at_discrepancy_seconds IS DISTINCT FROM OLD.recorded_at_discrepancy_seconds) THEN
    RAISE EXCEPTION 'recorded-at provenance is immutable after registration' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER evidence_recorded_at_guard BEFORE UPDATE OF declared_recorded_at, recorded_at_source, recorded_at_discrepancy_seconds ON evidence
  FOR EACH ROW EXECUTE FUNCTION evidence_recorded_at_guard();

