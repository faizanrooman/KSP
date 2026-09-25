-- 0700: case management, FIR, external integrations and integration API clients (spec modules 12 & 16).

-- Per-station, per-year case number counter: CASE-<STATION>-<YYYY>-<NNNN>.
CREATE TABLE case_number_counters (
  org_unit_id uuid NOT NULL REFERENCES org_units(id),
  year        integer NOT NULL,
  last_value  integer NOT NULL DEFAULT 0,
  PRIMARY KEY (org_unit_id, year)
);

-- Case lookups used by filters.
CREATE INDEX cases_fir ON cases (fir_id);
CREATE INDEX cases_supervisor ON cases (supervisor_id);
CREATE INDEX cases_status ON cases (status, opened_at DESC);
CREATE INDEX case_members_user ON case_members (user_id);
CREATE INDEX firs_acts_sections ON firs USING gin (acts_sections);
CREATE INDEX firs_registered ON firs (registered_at DESC);
CREATE INDEX case_evidence_case ON case_evidence (case_id, linked_at DESC);
-- Link rows are soft-unlinked (unlinked_at/by/reason), never deleted.
REVOKE DELETE ON case_evidence FROM ksp_app;

-- Integration systems: who verified the contract and when; who configured it.
ALTER TABLE integration_systems
  ADD COLUMN verified_at timestamptz,
  ADD COLUMN verified_by uuid REFERENCES users(id),
  ADD COLUMN created_by uuid REFERENCES users(id);
-- verified=true requires a recorded verification.
ALTER TABLE integration_systems ADD CONSTRAINT integration_systems_verified_ck CHECK (NOT verified OR verified_at IS NOT NULL);
-- The sync log is an append-only operational record.
REVOKE UPDATE, DELETE ON integration_sync_log FROM ksp_app;

-- API clients: per-client rate limit, revocation/rotation bookkeeping.
ALTER TABLE api_clients
  ADD COLUMN description text,
  ADD COLUMN rate_limit_per_minute integer NOT NULL DEFAULT 60 CHECK (rate_limit_per_minute BETWEEN 1 AND 10000),
  ADD COLUMN revoked_by uuid REFERENCES users(id),
  ADD COLUMN revoke_reason text,
  ADD COLUMN secret_rotated_at timestamptz;

-- Fixed-window request counters for per-client rate limiting (shared across API instances).
CREATE TABLE api_client_rate_windows (
  api_client_id uuid NOT NULL REFERENCES api_clients(id) ON DELETE CASCADE,
  window_start  timestamptz NOT NULL,
  count         integer NOT NULL DEFAULT 0,
  PRIMARY KEY (api_client_id, window_start)
);
