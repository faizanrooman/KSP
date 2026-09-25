-- 0001: extensions, privileges, organisation hierarchy, identity & access management.
-- Requires db/bootstrap/roles.sql to have been run on the cluster.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS ltree;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ksp_app') OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ksp_ai') THEN
    RAISE EXCEPTION 'Roles ksp_app / ksp_ai missing. Run db/bootstrap/roles.sql first.';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO ksp_app, ksp_ai;
-- Every table/sequence/function created by the migration user is automatically usable by the app role.
-- Sensitive tables REVOKE selectively below and in later migrations. ksp_ai gets explicit grants only.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ksp_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ksp_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ksp_app;

-- Generic updated_at maintenance.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------------------------
-- Organisation hierarchy (jurisdiction). STATE > RANGE/COMMISSIONERATE > DISTRICT > SUBDIVISION > STATION.
-- path is an ltree of unit codes (lower-case, [a-z0-9_]) and drives jurisdiction-based access.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE org_units (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9_]{2,40}$'),
  name         text NOT NULL,
  unit_type    text NOT NULL CHECK (unit_type IN ('STATE','ZONE','RANGE','COMMISSIONERATE','DISTRICT','SUBDIVISION','CIRCLE','STATION','UNIT')),
  parent_id    uuid REFERENCES org_units(id),
  path         ltree NOT NULL UNIQUE,
  address      text,
  phone        text,
  latitude     double precision CHECK (latitude BETWEEN -90 AND 90),
  longitude    double precision CHECK (longitude BETWEEN -180 AND 180),
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX org_units_path_gist ON org_units USING gist (path);
CREATE INDEX org_units_parent ON org_units (parent_id);
CREATE TRIGGER org_units_updated BEFORE UPDATE ON org_units FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------------------------
CREATE TABLE users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username              citext NOT NULL UNIQUE CHECK (length(username) BETWEEN 3 AND 64),
  email                 citext UNIQUE,
  full_name             text NOT NULL,
  badge_number          text UNIQUE,              -- officer / employee ID
  rank                  text,
  designation           text,
  phone                 text,
  home_org_unit_id      uuid NOT NULL REFERENCES org_units(id),
  status                text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('PENDING','ACTIVE','LOCKED','DISABLED')),
  password_hash         text,
  password_changed_at   timestamptz,
  must_change_password  boolean NOT NULL DEFAULT true,
  failed_login_count    integer NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  mfa_enabled           boolean NOT NULL DEFAULT false,
  mfa_secret_enc        text,                     -- AES-256-GCM encrypted TOTP secret (app-level key)
  mfa_pending_secret_enc text,                    -- secret during enrolment, before confirmation
  mfa_recovery_codes    text[] NOT NULL DEFAULT '{}', -- argon2 hashes of one-time recovery codes
  mfa_enrolled_at       timestamptz,
  last_login_at         timestamptz,
  last_login_ip         inet,
  created_by            uuid REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  disabled_at           timestamptz,
  disabled_reason       text
);
CREATE INDEX users_home_org ON users (home_org_unit_id);
CREATE INDEX users_name_trgm ON users USING gin (full_name gin_trgm_ops);
CREATE TRIGGER users_updated BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE password_history (
  id            bigserial PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_history_user ON password_history (user_id, created_at DESC);

-- ---------------------------------------------------------------------------------------------
-- Roles & permissions (RBAC). Permission codes are defined in packages/shared/src/permissions.ts.
-- A role is granted to a user AT an org unit; it applies to that unit's whole subtree.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE roles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text NOT NULL UNIQUE CHECK (code ~ '^[A-Z][A-Z0-9_]{1,40}$'),
  name         text NOT NULL,
  description  text,
  permissions  text[] NOT NULL DEFAULT '{}',
  is_system    boolean NOT NULL DEFAULT false,   -- system roles cannot be deleted (permissions still configurable)
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER roles_updated BEFORE UPDATE ON roles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE user_roles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id      uuid NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  org_unit_id  uuid NOT NULL REFERENCES org_units(id),
  granted_by   uuid REFERENCES users(id),
  granted_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,
  UNIQUE (user_id, role_id, org_unit_id)
);
CREATE INDEX user_roles_user ON user_roles (user_id);

-- ---------------------------------------------------------------------------------------------
-- Sessions & tokens
-- ---------------------------------------------------------------------------------------------
CREATE TABLE sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  ip              inet,
  user_agent      text,
  mfa_verified    boolean NOT NULL DEFAULT false,
  revoked_at      timestamptz,
  revoke_reason   text
);
CREATE INDEX sessions_user_active ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,     -- sha256 of the opaque token; the token itself is never stored
  family_id   uuid NOT NULL,            -- all rotations of one login share a family; reuse => family revoked
  parent_id   uuid REFERENCES refresh_tokens(id),
  issued_at   timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  revoked_at  timestamptz
);
CREATE INDEX refresh_tokens_session ON refresh_tokens (session_id);
CREATE INDEX refresh_tokens_family ON refresh_tokens (family_id);

CREATE TABLE login_attempts (
  id          bigserial PRIMARY KEY,
  username    citext NOT NULL,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  ip          inet,
  user_agent  text,
  success     boolean NOT NULL,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_user_time ON login_attempts (username, created_at DESC);
CREATE INDEX login_attempts_ip_time ON login_attempts (ip, created_at DESC);

-- Machine clients for the REST integration API (CCTNS, FIR, case diary, DER systems).
CREATE TABLE api_clients (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  client_id     text NOT NULL UNIQUE,
  secret_hash   text NOT NULL,              -- argon2id
  scopes        text[] NOT NULL DEFAULT '{}',-- permission codes the client may use
  org_unit_id   uuid NOT NULL REFERENCES org_units(id), -- jurisdiction the client is limited to
  allowed_ips   cidr[] NOT NULL DEFAULT '{}',
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,
  revoked_at    timestamptz,
  last_used_at  timestamptz
);

-- ---------------------------------------------------------------------------------------------
-- Configurable system settings (password policy, session limits, thresholds...). Keys documented in
-- packages/shared/src/settings.ts. Values are JSON validated by the API.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE system_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- In-app notifications.
CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  title       text NOT NULL,
  body        text,
  link        text,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_unread ON notifications (user_id, created_at DESC) WHERE read_at IS NULL;
