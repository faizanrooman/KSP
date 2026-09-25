-- 0002: tamper-evident, append-only audit ledger (also the digital chain-of-custody record).
--
-- Every row carries hash = sha256(prev_hash || canonical(row)). Rows are appended ONLY through
-- audit_append(), which serialises writers with a transaction-scoped advisory lock so the chain is
-- strictly linear. UPDATE / DELETE / TRUNCATE are blocked by triggers AND revoked from ksp_app.
-- audit_verify() recomputes the chain; any edit made by a superuser bypassing triggers is detected.

CREATE TABLE audit_events (
  seq            bigint PRIMARY KEY,                 -- gapless, assigned inside audit_append()
  event_id       uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  occurred_at    timestamptz NOT NULL,
  actor_type     text NOT NULL CHECK (actor_type IN ('USER','SYSTEM','API_CLIENT','EXTERNAL_RECIPIENT')),
  actor_id       text,                               -- user uuid, api client id, share id, or worker name
  actor_name     text,
  actor_ip       inet,
  user_agent     text,
  session_id     uuid,
  action         text NOT NULL,                      -- see packages/shared/src/audit.ts (AuditAction)
  category       text NOT NULL CHECK (category IN ('AUTH','ADMIN','EVIDENCE','CUSTODY','MEDIA','AI','REVIEW','SEARCH','INVESTIGATION','CASE','EXPORT','SHARE','INTEGRATION','SECURITY','SYSTEM','REPORT')),
  outcome        text NOT NULL CHECK (outcome IN ('SUCCESS','FAILURE','DENIED')),
  resource_type  text,
  resource_id    text,
  evidence_id    uuid,                               -- set for every custody-relevant event
  case_id        uuid,
  org_unit_id    uuid,
  details        jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash      text NOT NULL,
  hash           text NOT NULL UNIQUE
);
CREATE INDEX audit_events_time ON audit_events (occurred_at DESC);
CREATE INDEX audit_events_evidence ON audit_events (evidence_id, seq) WHERE evidence_id IS NOT NULL;
CREATE INDEX audit_events_case ON audit_events (case_id, seq) WHERE case_id IS NOT NULL;
CREATE INDEX audit_events_actor ON audit_events (actor_id, occurred_at DESC);
CREATE INDEX audit_events_action ON audit_events (action, occurred_at DESC);
CREATE INDEX audit_events_category ON audit_events (category, occurred_at DESC);

-- Canonical text that is hashed. jsonb::text is deterministic (keys sorted by length then bytes).
CREATE OR REPLACE FUNCTION audit_canonical(e audit_events) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT concat_ws('|',
    e.seq::text, e.event_id::text,
    to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    e.actor_type, coalesce(e.actor_id,''), coalesce(e.actor_name,''), coalesce(host(e.actor_ip),''),
    coalesce(e.session_id::text,''), e.action, e.category, e.outcome,
    coalesce(e.resource_type,''), coalesce(e.resource_id,''), coalesce(e.evidence_id::text,''),
    coalesce(e.case_id::text,''), coalesce(e.org_unit_id::text,''), e.details::text)
$$;

CREATE OR REPLACE FUNCTION audit_append(
  p_actor_type text, p_actor_id text, p_actor_name text, p_actor_ip inet, p_user_agent text, p_session_id uuid,
  p_action text, p_category text, p_outcome text, p_resource_type text, p_resource_id text,
  p_evidence_id uuid, p_case_id uuid, p_org_unit_id uuid, p_details jsonb
) RETURNS audit_events LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_prev audit_events;
  v_row  audit_events;
BEGIN
  -- Serialise all appenders (released at commit/rollback). 7340032 = arbitrary constant key for the ledger.
  PERFORM pg_advisory_xact_lock(7340032);
  SELECT * INTO v_prev FROM audit_events ORDER BY seq DESC LIMIT 1;
  v_row.seq := coalesce(v_prev.seq, 0) + 1;
  v_row.event_id := gen_random_uuid();
  v_row.occurred_at := clock_timestamp();
  v_row.actor_type := p_actor_type; v_row.actor_id := p_actor_id; v_row.actor_name := p_actor_name;
  v_row.actor_ip := p_actor_ip; v_row.user_agent := p_user_agent; v_row.session_id := p_session_id;
  v_row.action := p_action; v_row.category := p_category; v_row.outcome := p_outcome;
  v_row.resource_type := p_resource_type; v_row.resource_id := p_resource_id;
  v_row.evidence_id := p_evidence_id; v_row.case_id := p_case_id; v_row.org_unit_id := p_org_unit_id;
  v_row.details := coalesce(p_details, '{}'::jsonb);
  v_row.prev_hash := coalesce(v_prev.hash, repeat('0', 64));
  v_row.hash := encode(digest(v_row.prev_hash || '|' || audit_canonical(v_row), 'sha256'), 'hex');
  INSERT INTO audit_events VALUES (v_row.*);
  RETURN v_row;
END $$;

-- Recompute the chain between two sequence numbers. Returns the first broken row, if any.
CREATE OR REPLACE FUNCTION audit_verify(p_from bigint DEFAULT 1, p_to bigint DEFAULT NULL)
RETURNS TABLE (checked bigint, first_bad_seq bigint, head_seq bigint, head_hash text)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  r audit_events;
  v_prev_hash text;
  v_expected_seq bigint;
  v_checked bigint := 0;
  v_bad bigint := NULL;
  v_head audit_events;
BEGIN
  IF p_from <= 1 THEN
    v_prev_hash := repeat('0', 64);
  ELSE
    SELECT hash INTO v_prev_hash FROM audit_events WHERE seq = p_from - 1;
  END IF;
  v_expected_seq := greatest(p_from, 1);
  FOR r IN SELECT * FROM audit_events WHERE seq >= p_from AND (p_to IS NULL OR seq <= p_to) ORDER BY seq LOOP
    IF r.seq <> v_expected_seq OR r.prev_hash <> v_prev_hash
       OR r.hash <> encode(digest(r.prev_hash || '|' || audit_canonical(r), 'sha256'), 'hex') THEN
      v_bad := r.seq;
      EXIT;
    END IF;
    v_prev_hash := r.hash;
    v_expected_seq := r.seq + 1;
    v_checked := v_checked + 1;
    v_head := r;
  END LOOP;
  RETURN QUERY SELECT v_checked, v_bad, v_head.seq, v_head.hash;
END $$;

CREATE OR REPLACE FUNCTION audit_block_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit ledger is append-only (% blocked)', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION audit_block_mutation();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events FOR EACH STATEMENT EXECUTE FUNCTION audit_block_mutation();

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON audit_events FROM ksp_app;  -- inserts only via audit_append()
GRANT SELECT ON audit_events TO ksp_app;
GRANT EXECUTE ON FUNCTION audit_append(text,text,text,inet,text,uuid,text,text,text,text,text,uuid,uuid,uuid,jsonb) TO ksp_app, ksp_ai;

-- Periodic signed anchors of the chain head (written by the worker; signature by the ledger signing key).
-- An external copy of these checkpoints lets auditors prove that even a DB superuser did not rewrite history.
CREATE TABLE audit_checkpoints (
  id          bigserial PRIMARY KEY,
  head_seq    bigint NOT NULL,
  head_hash   text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  key_id      text NOT NULL,
  algorithm   text NOT NULL,
  signature   text NOT NULL
);
CREATE TRIGGER audit_checkpoints_no_update BEFORE UPDATE OR DELETE ON audit_checkpoints FOR EACH ROW EXECUTE FUNCTION audit_block_mutation();
REVOKE UPDATE, DELETE, TRUNCATE ON audit_checkpoints FROM ksp_app;
