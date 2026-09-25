-- 0005: FIR & case management, evidence linking, integrations, investigation workspace.

CREATE TABLE firs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fir_number      text NOT NULL,
  fir_year        integer NOT NULL CHECK (fir_year BETWEEN 1950 AND 2200),
  org_unit_id     uuid NOT NULL REFERENCES org_units(id),   -- registering police station
  org_path        ltree NOT NULL,
  registered_at   timestamptz NOT NULL,
  acts_sections   text[] NOT NULL DEFAULT '{}',             -- e.g. {'BNS 303(2)','BNS 115(2)'}
  complainant     text,
  brief_facts     text,
  place_of_occurrence text,
  occurred_from   timestamptz,
  occurred_to     timestamptz,
  status          text NOT NULL DEFAULT 'REGISTERED' CHECK (status IN ('REGISTERED','UNDER_INVESTIGATION','CHARGESHEETED','FINAL_REPORT','CLOSED','TRANSFERRED')),
  source          text NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL','CCTNS','FIR_SYSTEM')),
  external_ref    text,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_unit_id, fir_year, fir_number)
);
CREATE INDEX firs_org_path ON firs USING gist (org_path);
CREATE TRIGGER firs_updated BEFORE UPDATE ON firs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE cases (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_number               text NOT NULL UNIQUE,
  title                     text NOT NULL,
  description               text,
  fir_id                    uuid REFERENCES firs(id),
  org_unit_id               uuid NOT NULL REFERENCES org_units(id),
  org_path                  ltree NOT NULL,
  status                    text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','UNDER_INVESTIGATION','PENDING_TRIAL','IN_TRIAL','CLOSED','ARCHIVED')),
  priority                  text NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW','NORMAL','HIGH','CRITICAL')),
  investigating_officer_id  uuid REFERENCES users(id),
  supervisor_id             uuid REFERENCES users(id),
  court_name                text,
  court_case_number         text,
  opened_at                 timestamptz NOT NULL DEFAULT now(),
  closed_at                 timestamptz,
  external_system           text,
  external_ref              text,
  created_by                uuid REFERENCES users(id),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cases_org_path ON cases USING gist (org_path);
CREATE INDEX cases_io ON cases (investigating_officer_id);
CREATE INDEX cases_title_trgm ON cases USING gin (title gin_trgm_ops);
CREATE TRIGGER cases_updated BEFORE UPDATE ON cases FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Case team (beyond IO/supervisor) — grants case-scoped access to linked evidence.
CREATE TABLE case_members (
  case_id     uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id),
  role        text NOT NULL DEFAULT 'MEMBER' CHECK (role IN ('MEMBER','ANALYST','PROSECUTION_LIAISON')),
  added_by    uuid REFERENCES users(id),
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, user_id)
);

CREATE TABLE case_evidence (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id      uuid NOT NULL REFERENCES cases(id),
  evidence_id  uuid NOT NULL REFERENCES evidence(id),
  linked_by    uuid NOT NULL REFERENCES users(id),
  linked_at    timestamptz NOT NULL DEFAULT now(),
  note         text,
  unlinked_by  uuid REFERENCES users(id),
  unlinked_at  timestamptz,
  unlink_reason text
);
CREATE UNIQUE INDEX case_evidence_active ON case_evidence (case_id, evidence_id) WHERE unlinked_at IS NULL;
CREATE INDEX case_evidence_evidence ON case_evidence (evidence_id);

CREATE TABLE case_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id     uuid NOT NULL REFERENCES cases(id),
  author_id   uuid NOT NULL REFERENCES users(id),
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX case_notes_case ON case_notes (case_id, created_at);
REVOKE UPDATE, DELETE ON case_notes FROM ksp_app;  -- case diary entries are append-only

-- External integration systems (CCTNS, FIR, case diary, digital evidence repositories).
-- The supplied specification does NOT define these systems' API contracts; adapters are configured here
-- and remain UNVERIFIED until real contracts/credentials are provided.
CREATE TABLE integration_systems (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL UNIQUE,
  name            text NOT NULL,
  system_type     text NOT NULL CHECK (system_type IN ('CCTNS','FIR','CASE_DIARY','EVIDENCE_REPOSITORY','OTHER')),
  adapter         text NOT NULL,                  -- adapter implementation id (e.g. 'cctns-rest-v1', 'fixture')
  base_url        text,
  config          jsonb NOT NULL DEFAULT '{}'::jsonb,
  credentials_ref text,                           -- name of the secret holding credentials (never the secret)
  enabled         boolean NOT NULL DEFAULT false,
  verified        boolean NOT NULL DEFAULT false, -- true only after a successful live contract test
  last_sync_at    timestamptz,
  last_status     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER integration_systems_updated BEFORE UPDATE ON integration_systems FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE integration_sync_log (
  id            bigserial PRIMARY KEY,
  system_id     uuid NOT NULL REFERENCES integration_systems(id),
  direction     text NOT NULL CHECK (direction IN ('INBOUND','OUTBOUND')),
  operation     text NOT NULL,
  status        text NOT NULL CHECK (status IN ('SUCCESS','FAILURE')),
  request_ref   text,
  summary       jsonb NOT NULL DEFAULT '{}'::jsonb,
  error         text,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX integration_sync_log_system ON integration_sync_log (system_id, created_at DESC);

-- ---------------------------------------------------------------------------------------------
-- Investigation workspace
-- ---------------------------------------------------------------------------------------------
CREATE TABLE workspaces (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title        text NOT NULL,
  description  text,
  case_id      uuid REFERENCES cases(id),
  owner_id     uuid NOT NULL REFERENCES users(id),
  org_unit_id  uuid NOT NULL REFERENCES org_units(id),
  status       text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspaces_owner ON workspaces (owner_id);
CREATE INDEX workspaces_case ON workspaces (case_id);
CREATE TRIGGER workspaces_updated BEFORE UPDATE ON workspaces FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id),
  role         text NOT NULL DEFAULT 'VIEWER' CHECK (role IN ('OWNER','EDITOR','VIEWER')),
  added_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE workspace_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  evidence_id     uuid NOT NULL REFERENCES evidence(id),
  sync_offset_ms  bigint NOT NULL DEFAULT 0,        -- offset for time-synchronised multi-video playback
  sort_order      integer NOT NULL DEFAULT 0,
  notes           text,
  added_by        uuid NOT NULL REFERENCES users(id),
  added_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, evidence_id)
);

CREATE TABLE bookmarks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_id   uuid NOT NULL REFERENCES evidence(id),
  workspace_id  uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id),
  time_ms       bigint NOT NULL CHECK (time_ms >= 0),
  label         text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bookmarks_evidence ON bookmarks (evidence_id, time_ms);

-- Annotations are derived analytical data; they never modify the original. Soft-deleted for auditability.
CREATE TABLE annotations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_id   uuid NOT NULL REFERENCES evidence(id),
  workspace_id  uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  author_id     uuid NOT NULL REFERENCES users(id),
  kind          text NOT NULL CHECK (kind IN ('NOTE','HIGHLIGHT','REGION')),
  start_ms      bigint NOT NULL CHECK (start_ms >= 0),
  end_ms        bigint CHECK (end_ms IS NULL OR end_ms >= start_ms),
  body          text,
  region        jsonb,                              -- {x,y,w,h} normalised for REGION
  color         text CHECK (color IS NULL OR color ~ '^#[0-9a-fA-F]{6}$'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  deleted_by    uuid REFERENCES users(id)
);
CREATE INDEX annotations_evidence ON annotations (evidence_id, start_ms) WHERE deleted_at IS NULL;
CREATE TRIGGER annotations_updated BEFORE UPDATE ON annotations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE timeline_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title         text NOT NULL,
  description   text,
  occurred_at   timestamptz NOT NULL,
  evidence_id   uuid REFERENCES evidence(id),
  time_ms       bigint,
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX timeline_events_ws ON timeline_events (workspace_id, occurred_at);

CREATE TABLE evidence_relations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_a    uuid NOT NULL REFERENCES evidence(id),
  evidence_b    uuid NOT NULL REFERENCES evidence(id),
  relation      text NOT NULL CHECK (relation IN ('SAME_INCIDENT','DIFFERENT_ANGLE','CONTINUATION','RELATED')),
  note          text,
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (evidence_a <> evidence_b),
  UNIQUE (evidence_a, evidence_b, relation)
);
