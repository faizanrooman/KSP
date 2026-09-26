-- Perf personas (non-MFA custom roles so load tests can log in with a password only; the MFA policy itself is untouched):
--   perf.sup   — district supervisor at blr_central (SUPERVISOR permissions)
--   perf.state — state-level auditor at ksp (AUDITOR permissions + search:use)
--   io.meera   — station IO at ps_cubbonpark (seeded dev user)
\set ON_ERROR_STOP on
INSERT INTO roles (code, name, description, permissions, is_system)
SELECT 'PERF_SUPERVISOR', 'Perf supervisor', 'perf test persona', permissions, false FROM roles WHERE code = 'SUPERVISOR'
ON CONFLICT (code) DO NOTHING;
INSERT INTO roles (code, name, description, permissions, is_system)
SELECT 'PERF_STATE', 'Perf state auditor', 'perf test persona', array_append(permissions, 'search:use'), false FROM roles WHERE code = 'AUDITOR'
ON CONFLICT (code) DO NOTHING;
INSERT INTO users (username, full_name, badge_number, home_org_unit_id, password_hash, password_changed_at)
SELECT v.u, v.n, v.b, (SELECT id FROM org_units WHERE code = v.org), (SELECT password_hash FROM users WHERE username = 'io.meera'), now()
  FROM (VALUES ('perf.sup', 'Perf Supervisor', 'PERF-SUP', 'blr_central'), ('perf.state', 'Perf State Auditor', 'PERF-STATE', 'ksp')) v(u, n, b, org)
ON CONFLICT (username) DO NOTHING;
INSERT INTO user_roles (user_id, role_id, org_unit_id)
SELECT u.id, r.id, u.home_org_unit_id FROM users u JOIN roles r ON r.code = CASE u.username WHEN 'perf.sup' THEN 'PERF_SUPERVISOR' ELSE 'PERF_STATE' END
 WHERE u.username IN ('perf.sup', 'perf.state')
   AND NOT EXISTS (SELECT 1 FROM user_roles x WHERE x.user_id = u.id);
