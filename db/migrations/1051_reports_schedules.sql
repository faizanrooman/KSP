-- 1051: scheduled (recurring) reports (FN-2).
-- A schedule belongs to its owner. At each due slot the reports.schedule cron materialises a report_runs row
-- created_by = owner, with the owner's jurisdiction computed and frozen AT RUN TIME (a revoked grant stops
-- the schedule instead of leaking data). Recipients (users) are frozen into report_runs.recipient_ids at run
-- time, restricted to recipients whose own report jurisdiction covers the run's scope.
CREATE TABLE report_schedules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  report_type     text NOT NULL,
  format          text NOT NULL CHECK (format IN ('CSV','PDF','JSON')),
  params          jsonb NOT NULL DEFAULT '{}'::jsonb,        -- orgUnitId / actorId / inactiveDays
  frequency       text NOT NULL CHECK (frequency IN ('DAILY','WEEKLY','MONTHLY','CRON')),
  cron            text NOT NULL CHECK (length(cron) BETWEEN 9 AND 120),  -- effective 5-field cron (presets expanded)
  timezone        text NOT NULL DEFAULT 'Asia/Kolkata',
  lookback_days   integer NOT NULL DEFAULT 1 CHECK (lookback_days BETWEEN 1 AND 1098),
  owner_id        uuid NOT NULL REFERENCES users(id),
  recipient_ids   uuid[] NOT NULL DEFAULT '{}',
  email_recipients boolean NOT NULL DEFAULT true,           -- also e-mail owner + recipients (users.email)
  enabled         boolean NOT NULL DEFAULT true,
  next_run_at     timestamptz,
  last_run_at     timestamptz,
  last_run_id     uuid REFERENCES report_runs(id) ON DELETE SET NULL,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX report_schedules_due ON report_schedules (next_run_at) WHERE enabled;
CREATE INDEX report_schedules_owner ON report_schedules (owner_id, created_at DESC);
CREATE TRIGGER report_schedules_updated BEFORE UPDATE ON report_schedules FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE report_runs ADD COLUMN schedule_id uuid REFERENCES report_schedules(id) ON DELETE SET NULL;
ALTER TABLE report_runs ADD COLUMN scheduled_for timestamptz;
ALTER TABLE report_runs ADD COLUMN recipient_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE report_runs ADD COLUMN notified_at timestamptz;
-- One run per schedule slot (the cron is idempotent under concurrency / restarts).
CREATE UNIQUE INDEX report_runs_schedule_slot ON report_runs (schedule_id, scheduled_for) WHERE schedule_id IS NOT NULL;
CREATE INDEX report_runs_recipients ON report_runs USING gin (recipient_ids);
