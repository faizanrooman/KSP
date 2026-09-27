-- 1000: versioned audit hash canonical form (SEC-R1).
--
-- The v1 canonical form (audit_canonical(), migration 0002) omits user_agent, so a DB superuser could alter
-- that column without breaking the chain. History is NOT rewritten: existing rows keep hash_version = 1 and
-- are verified with v1. From this migration on audit_append() writes hash_version = 2, whose canonical text
-- covers EVERY column (incl. user_agent and the version itself). audit_verify() checks each row with its own
-- version and rejects a version downgrade (a v1 row after a v2 row), so a v2 row cannot be "re-labelled" v1.

-- ADD COLUMN with a constant default is metadata-only (no row rewrite, no UPDATE trigger fired).
ALTER TABLE audit_events ADD COLUMN hash_version smallint NOT NULL DEFAULT 1 CHECK (hash_version IN (1, 2));

CREATE OR REPLACE FUNCTION audit_canonical_v2(e audit_events) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT concat_ws('|',
    'v2', e.seq::text, e.event_id::text,
    to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    e.actor_type, coalesce(e.actor_id,''), coalesce(e.actor_name,''), coalesce(host(e.actor_ip),''),
    coalesce(e.user_agent,''), coalesce(e.session_id::text,''), e.action, e.category, e.outcome,
    coalesce(e.resource_type,''), coalesce(e.resource_id,''), coalesce(e.evidence_id::text,''),
    coalesce(e.case_id::text,''), coalesce(e.org_unit_id::text,''), e.details::text)
$$;

-- Expected hash of a row under its own canonical version (single source of truth for every verifier).
CREATE OR REPLACE FUNCTION audit_row_hash(e audit_events) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(digest(e.prev_hash || '|' || CASE e.hash_version
                                                 WHEN 2 THEN audit_canonical_v2(e)
                                                 WHEN 1 THEN audit_canonical(e)
                                               END, 'sha256'), 'hex')
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
  v_row.hash_version := 2;
  v_row.hash := audit_row_hash(v_row);
  INSERT INTO audit_events VALUES (v_row.*);
  RETURN v_row;
END $$;

CREATE OR REPLACE FUNCTION audit_verify(p_from bigint DEFAULT 1, p_to bigint DEFAULT NULL)
RETURNS TABLE (checked bigint, first_bad_seq bigint, head_seq bigint, head_hash text)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  r audit_events;
  v_prev_hash text;
  v_prev_version smallint;
  v_expected_seq bigint;
  v_checked bigint := 0;
  v_bad bigint := NULL;
  v_head audit_events;
BEGIN
  IF p_from <= 1 THEN
    v_prev_hash := repeat('0', 64);
    v_prev_version := 1;
  ELSE
    SELECT hash, hash_version INTO v_prev_hash, v_prev_version FROM audit_events WHERE seq = p_from - 1;
  END IF;
  v_expected_seq := greatest(p_from, 1);
  FOR r IN SELECT * FROM audit_events WHERE seq >= p_from AND (p_to IS NULL OR seq <= p_to) ORDER BY seq LOOP
    IF r.seq <> v_expected_seq OR r.prev_hash IS DISTINCT FROM v_prev_hash
       OR r.hash_version < coalesce(v_prev_version, 1)
       OR r.hash IS DISTINCT FROM audit_row_hash(r) THEN
      v_bad := r.seq;
      EXIT;
    END IF;
    v_prev_hash := r.hash;
    v_prev_version := r.hash_version;
    v_expected_seq := r.seq + 1;
    v_checked := v_checked + 1;
    v_head := r;
  END LOOP;
  RETURN QUERY SELECT v_checked, v_bad, v_head.seq, v_head.hash;
END $$;
