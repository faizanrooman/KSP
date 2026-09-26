-- Bulk audit ledger for the perf database, appended through audit_append() so the hash chain is REAL (audit_verify()
-- must pass afterwards). 10 transactions x :batch events; \timing gives single-session append throughput.
--   psql "$DATABASE_MIGRATION_URL" -v batch=100000 -f tests/perf/seed/audit.sql
\set ON_ERROR_STOP on
\if :{?batch}
\else
  \set batch 100000
\endif
\timing on
CREATE TEMP TABLE perf_ev AS SELECT id, org_unit_id, uploaded_by, row_number() OVER (ORDER BY id) AS n FROM evidence WHERE evidence_number LIKE 'PERF-%';
CREATE INDEX ON perf_ev (n);
ANALYZE perf_ev;
-- The "hot" item: 1000 custody events on one evidence item (custody view benchmark).
SELECT count(audit_append('USER', e.uploaded_by::text, 'perf.hot', '10.1.0.1'::inet, 'perf', NULL,
                          (ARRAY['EVIDENCE_VIEWED','EVIDENCE_PLAYED','EVIDENCE_METADATA_UPDATED','EVIDENCE_SNAPSHOT_CREATED'])[1 + i % 4], 'CUSTODY', 'SUCCESS',
                          'evidence', e.id::text, e.id, NULL, e.org_unit_id, jsonb_build_object('perf', i)))
  FROM perf_ev e, generate_series(1, 1000) i WHERE e.n = 1;

\set i 0
SELECT format($f$
SELECT count(audit_append(CASE WHEN g %% 20 = 0 THEN 'SYSTEM' ELSE 'USER' END, e.uploaded_by::text, 'perf.u', ('10.' || (g %% 250) || '.0.1')::inet, 'perf-agent', NULL,
                          a.action, a.cat, CASE WHEN g %% 50 = 0 THEN 'DENIED' ELSE 'SUCCESS' END, 'evidence', e.id::text,
                          CASE WHEN a.cat = 'CUSTODY' THEN e.id END, NULL, e.org_unit_id, jsonb_build_object('n', g)))
  FROM generate_series(1, %s) g
  JOIN perf_ev e ON e.n = 1 + (g * 7919) %% (SELECT count(*) FROM perf_ev)
  CROSS JOIN LATERAL (SELECT (ARRAY['EVIDENCE_VIEWED','EVIDENCE_PLAYED','LOGIN','EVIDENCE_DOWNLOADED','SEARCH_PERFORMED','EVIDENCE_TAGGED'])[1 + g %% 6] AS action,
                             (ARRAY['CUSTODY','CUSTODY','AUTH','CUSTODY','SEARCH','CUSTODY'])[1 + g %% 6] AS cat) a
$f$, :batch) AS q \gset
:q ;
:q ;
:q ;
:q ;
:q ;
:q ;
:q ;
:q ;
:q ;
:q ;
ANALYZE audit_events;
SELECT count(*) AS audit_events, max(seq) AS head FROM audit_events;
