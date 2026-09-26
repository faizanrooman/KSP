-- Synthetic performance dataset for a DEV/PERF database (never production). Run as the schema owner:
--   psql "$DATABASE_MIGRATION_URL" -v evidence=100000 -v detections=500000 -f tests/perf/seed/seed.sql
-- Then run tests/perf/seed/audit.sql for the audit ledger (hash chain via audit_append()).
-- Idempotency: refuses to run twice (checks for the PERF marker org unit).
\set ON_ERROR_STOP on
\if :{?evidence}
\else
  \set evidence 100000
\endif
\if :{?detections}
\else
  \set detections 500000
\endif
\timing on

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM org_units WHERE code = 'perf_d01') THEN RAISE EXCEPTION 'perf dataset already present'; END IF;
END $$;

SELECT setseed(0.42);

BEGIN;
-- 1. Org units: 30 perf districts x 9 stations, plus 9 extra stations in blr_central and blr_east (~292 stations).
INSERT INTO org_units (code, name, unit_type, parent_id, path, latitude, longitude)
SELECT format('perf_d%s', lpad(d::text, 2, '0')), format('Perf District %s', d), 'DISTRICT', p.id, p.path || format('perf_d%s', lpad(d::text, 2, '0'))::ltree,
       12 + random() * 4, 74.5 + random() * 3
  FROM generate_series(1, 30) d
  JOIN org_units p ON p.code = CASE WHEN d <= 10 THEN 'blr_city' ELSE 'southern_range' END;

INSERT INTO org_units (code, name, unit_type, parent_id, path, latitude, longitude)
SELECT format('ps_perf_%s_%s', d.code, s), format('Perf Station %s/%s', d.code, s), 'STATION', d.id, d.path || format('ps_perf_%s_%s', d.code, s)::ltree,
       coalesce(d.latitude, 12.97) + (random() - 0.5) * 0.2, coalesce(d.longitude, 77.59) + (random() - 0.5) * 0.2
  FROM org_units d, generate_series(1, 9) s
 WHERE d.code LIKE 'perf_d%' OR d.code IN ('blr_central', 'blr_east');

-- 2. Officers: ~10 per station, FIELD_OFFICER (90 %) / INVESTIGATING_OFFICER (10 %), same password as the dev users.
CREATE TEMP TABLE perf_stations AS
SELECT id, path, latitude, longitude, row_number() OVER (ORDER BY path) AS n FROM org_units WHERE unit_type = 'STATION';

INSERT INTO users (username, full_name, badge_number, rank, home_org_unit_id, password_hash, password_changed_at)
SELECT format('perf.u%s', lpad(i::text, 5, '0')), format('Perf Officer %s', i), format('PERF-%s', lpad(i::text, 5, '0')), 'Police Constable',
       s.id, (SELECT password_hash FROM users WHERE username = 'io.meera'), now()
  FROM generate_series(1, (SELECT count(*) * 10 FROM perf_stations)) i
  JOIN perf_stations s ON s.n = 1 + (i % (SELECT count(*) FROM perf_stations));

INSERT INTO user_roles (user_id, role_id, org_unit_id)
SELECT u.id, (SELECT id FROM roles WHERE code = CASE WHEN right(u.username, 1) = '0' THEN 'INVESTIGATING_OFFICER' ELSE 'FIELD_OFFICER' END), u.home_org_unit_id
  FROM users u WHERE u.username LIKE 'perf.u%';

CREATE TEMP TABLE perf_officers AS
SELECT u.id, u.home_org_unit_id, row_number() OVER (PARTITION BY u.home_org_unit_id ORDER BY u.id) AS k FROM users u WHERE u.username LIKE 'perf.u%';
CREATE INDEX ON perf_officers (home_org_unit_id, k);
ANALYZE perf_officers;

-- 3. Evidence: REGISTERED, spread over stations (ps_cubbonpark weighted as a busy station: 5 %), officers, 2 years of
--    recording dates, GPS near the station, category, codec/duration/size, sha256, searchable titles.
CREATE TEMP TABLE words(w text[]);
INSERT INTO words VALUES (ARRAY['chain snatching','traffic stop','protest','accident','assault','theft','burglary','vehicle check','raid','arrest','crowd control','patrol','complaint','pickpocket','drunk driving','hit and run','street fight','robbery','vandalism','noise complaint']);

INSERT INTO evidence (evidence_number, status, org_unit_id, org_path, uploaded_by, officer_id, title, description, category, original_filename, mime_type,
                      size_bytes, sha256, storage_tier, recorded_at, recorded_end_at, duration_ms, container_format, video_codec, audio_codec, width, height,
                      frame_rate, gps_latitude, gps_longitude, gps_source, location_text, media_status, registered_at, created_at)
SELECT format('PERF-%s', lpad(g.i::text, 7, '0')), 'REGISTERED', s.id, s.path, o.id, o.id,
       initcap((SELECT w[1 + (g.i * 7) % 20] FROM words)) || ' near ' || s.path::text,
       'Body-worn camera footage: ' || (SELECT w[1 + (g.i * 13) % 20] FROM words) || ', ' || (SELECT w[1 + (g.i * 3) % 20] FROM words),
       (ARRAY['PATROL','TRAFFIC','INCIDENT','RAID','CROWD','INTERVIEW'])[1 + g.i % 6],
       format('BWC_%s.mp4', g.i), 'video/mp4',
       (50 + (random() * 950)::int) * 1048576::bigint, encode(sha256(convert_to('perf' || g.i, 'UTF8')), 'hex'),
       (ARRAY['ACTIVE','ACTIVE','ACTIVE','ARCHIVE','LONG_TERM'])[1 + g.i % 5],
       rec, rec + make_interval(secs => dur / 1000.0), dur, 'mov,mp4,m4a,3gp,3g2,mj2', 'h264', 'aac', 1920, 1080, 30,
       s.latitude + (random() - 0.5) * 0.05, s.longitude + (random() - 0.5) * 0.05, 'CONTAINER_TAG', 'Near ' || s.path::text, 'READY', rec + interval '2 hours', rec + interval '1 hour'
  FROM (SELECT i, now() - (random() * 730) * interval '1 day' AS rec, (30000 + (random() * 1770000)::int)::bigint AS dur,
               CASE WHEN random() < 0.05 THEN (SELECT n FROM perf_stations WHERE path = 'ksp.blr_city.blr_central.ps_cubbonpark'::ltree)
                    ELSE 1 + (random() * ((SELECT count(*) FROM perf_stations) - 1))::int END AS sn
          FROM generate_series(1, :evidence) i) g
  JOIN perf_stations s ON s.n = g.sn
  JOIN LATERAL (SELECT id FROM perf_officers po WHERE po.home_org_unit_id = s.id ORDER BY po.k LIMIT 1 OFFSET (g.i % 10)) o ON true;

-- Tags: 0..3 per item from a small vocabulary.
INSERT INTO evidence_tags (evidence_id, tag, source)
SELECT e.id, t.tag, 'MANUAL'
  FROM evidence e
  CROSS JOIN LATERAL (SELECT DISTINCT (ARRAY['priority','court','review','night','two-wheeler','crowd','traffic','women-safety','narcotics','vip'])[1 + ((abs(hashtext(e.id::text || k)) % 10))] AS tag
                        FROM generate_series(1, (abs(hashtext(e.id::text)) % 4)) k) t
 WHERE e.evidence_number LIKE 'PERF-%'
ON CONFLICT DO NOTHING;

-- 4. AI: one model, one COMPLETED job per detection-bearing item, :detections detections over 50 % of the items.
INSERT INTO ai_models (code, name, task, version, artifact_uri, status, activated_at)
VALUES ('perf-yolo', 'Perf synthetic detector', 'OBJECT_DETECTION', '1', 'file:///dev/null', 'ACTIVE', now())
ON CONFLICT DO NOTHING;

CREATE TEMP TABLE perf_jobs AS
WITH e AS (SELECT id, uploaded_by, row_number() OVER (ORDER BY id) AS n FROM evidence WHERE evidence_number LIKE 'PERF-%' AND abs(hashtext(id::text)) % 2 = 0)
SELECT e.id AS evidence_id, e.uploaded_by, e.n FROM e;
ALTER TABLE perf_jobs ADD COLUMN job_id uuid DEFAULT gen_random_uuid();
INSERT INTO ai_jobs (id, evidence_id, requested_by, tasks, status, input, model_ids, started_at, finished_at)
SELECT job_id, evidence_id, uploaded_by, ARRAY['OBJECT_DETECTION'], 'COMPLETED', '{}'::jsonb, ARRAY[(SELECT id FROM ai_models WHERE code = 'perf-yolo')], now(), now() FROM perf_jobs;
CREATE INDEX ON perf_jobs (n);
ANALYZE perf_jobs;

INSERT INTO ai_detections (job_id, evidence_id, model_id, model_code, model_version, task, label, confidence, threshold, frame_time_ms, frame_number,
                           bbox_x, bbox_y, bbox_w, bbox_h, review_status, attributes)
SELECT j.job_id, j.evidence_id, (SELECT id FROM ai_models WHERE code = 'perf-yolo'), 'perf-yolo', '1', 'OBJECT_DETECTION',
       (ARRAY['person','person','person','car','car','motorcycle','truck','bus','bicycle','license_plate'])[1 + d.i % 10],
       0.5 + random() * 0.49, 0.5, (d.i * 997) % 1800000, (d.i * 997) % 1800000 / 33, random() * 0.8, random() * 0.8, 0.1, 0.2,
       (ARRAY['PENDING','APPROVED','APPROVED','REJECTED','NEEDS_SECOND_REVIEW'])[1 + d.i % 5],
       CASE WHEN d.i % 10 = 9 THEN jsonb_build_object('plate', format('KA%s%s%s', lpad(((d.i / 10) % 99)::text, 2, '0'), chr(65 + d.i % 26), lpad((d.i % 9999)::text, 4, '0'))) ELSE '{}'::jsonb END
  FROM generate_series(1, :detections) d(i)
  JOIN perf_jobs j ON j.n = 1 + (d.i % (SELECT count(*) FROM perf_jobs));
COMMIT;

ANALYZE org_units; ANALYZE users; ANALYZE user_roles; ANALYZE evidence; ANALYZE evidence_tags; ANALYZE ai_jobs; ANALYZE ai_detections;
SELECT (SELECT count(*) FROM org_units) AS org_units, (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM evidence) AS evidence,
       (SELECT count(*) FROM evidence_tags) AS tags, (SELECT count(*) FROM ai_detections) AS detections;
