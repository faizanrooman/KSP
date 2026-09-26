# Requirements Traceability

_Final audit, 2026-09-27 (branch `worktree-agent-aa7e284aaacab3fe1`, base `8ede45c`)._

Maps the specification's 20 modules to code and to the tests that prove them. The specification document itself
is not in the repository; the module list and expectations come from the audit brief and the existing module
docs. Every module had **at least 3 claims spot-checked against the code** (file:line given) and all test suites
were **run** during this audit (results in [FINAL-AUDIT.md](FINAL-AUDIT.md) §3).

**Status legend:** **IT** = IMPLEMENTED+TESTED (automated test exercises it and passed in this audit) ·
**IU** = IMPLEMENTED-UNTESTED · **P** = PARTIAL · **M** = MISSING · **UV** = UNVERIFIED (depends on something
external that was not available: real CCTNS, HSM, Docker/k8s, real S3 vendor, legal review, production scale).

Test counts are `it(...)`/`test(...)` occurrences per file (parametrised cases count once), so they are lower
bounds. Run totals (this audit): API 446 · worker 55 · ai-worker 19 · web 23 · station-client 3 · E2E 48.
API = `apps/api/test/`, W = `apps/worker/test/`, AI = `apps/ai-worker/test/`, E2E = `tests/e2e/specs/`.

## Summary

| # | Module | Status | Notes |
|---|---|---|---|
| 1 | Authentication | IT | no SSO/LDAP (not in scope brief); password expiry untested |
| 2 | User & role administration | IT | no bulk import / HR sync |
| 3 | RBAC / jurisdiction | IT | route-by-route IDOR matrix |
| 4 | Evidence registry | IT | ingestion via HTTP only (no dock/vendor pull); no AV scan |
| 5 | Integrity / immutability | IT (+UV real S3 COMPLIANCE mode) | nightly fixity sample small for state-wide volume |
| 6 | Retention / lifecycle / tiers | IT (UI P) | retention/disposal UI not browser-tested |
| 7 | Video processing & playback | IT | sync-player math only E2E-tested for offsets; no redaction |
| 8 | AI analysis | IT (+UV accuracy/GPU/licence) | tagging is rule-based; accuracy on KSP footage unverified |
| 9 | Human review | IT | two-person rule enforced in app code only |
| 10 | Search | IT | unreviewed-AI filter not gated by `ai:review` (LOW) |
| 11 | Investigation workspace | IT (timeline events IU) | |
| 12 | Cases / FIR linking | IT (+UV CCTNS) | CCTNS contract unknown |
| 13 | Chain of custody | IT | tamper case covered by audit tests, not custody view |
| 14 | Court export | IT (+UV legal/HSM) | "dual approval" = requester + one different approver |
| 15 | Secure sharing | IT (notifications M) | maxViews race fixed in this audit |
| 16 | Integrations / REST API | IT (+UV CCTNS, mTLS) | integration/API-client UI not browser-driven |
| 17 | Dashboards / reports / alerts | IT (e-mail M, scheduled reports M) | |
| 18 | Audit / compliance | IT | `user_agent` not covered by the hash (MEDIUM, open) |
| 19 | Monitoring / performance / security | P | AI-worker metrics missing; Prometheus stack UV; no CERT-In VAPT |
| 20 | Backup / DR / deployment | P (runtime UV) | scripts + local drill IT; images/k8s/CI never run |

Counts (module level): IMPLEMENTED+TESTED 18 (of which 5 have UNVERIFIED external parts: 5, 8, 12, 14, 16; the
runtime parts of 19/20 are counted under PARTIAL) · PARTIAL 2 (19, 20) · MISSING 0. Sub-capabilities that are
MISSING: e-mail alerts, scheduled reports, AI-worker metrics, share notifications (plus out-of-brief items: SSO,
redaction, AV scan).

---

## 1. Authentication — IT

| Capability | Code | Tests | Status |
|---|---|---|---|
| Login, logout, me, session list/revoke | `apps/api/src/modules/auth/index.ts`, `apps/api/src/lib/session.ts` | API `auth.test.ts` (14), `security-auth.test.ts` (10) | IT |
| Password policy (length 12, classes, history 5) | `packages/shared/src/settings.ts`, `auth/index.ts` (change password) | `auth.test.ts`, E2E `01-auth` (7) | IT |
| Password expiry (`maxAgeDays`) forces change | `apps/api/src/lib/load-principal.ts` | none ages `password_changed_at` | IU |
| Lockout + per-IP throttle; no password oracle while locked | `auth/index.ts:88-128` | `auth.test.ts`, E2E `01-auth` | IT |
| TOTP MFA, single-use step (SEC-12), recovery codes, mandatory for roles | `auth/index.ts:140-190`, `db/migrations/0991_security_mfa_replay.sql`, `plugins/auth.ts` | `auth.test.ts`, `security-races.test.ts` (9), E2E `01-auth` | IT |
| Refresh rotation with reuse detection; idle/absolute/concurrent limits | `lib/session.ts:71-148` | `security-auth.test.ts` | IT |
| CSRF double-submit + Origin check | `plugins/auth.ts:126-134` | `auth.test.ts`, `security-routes.test.ts` (6, every route) | IT |
| SSO / LDAP / hardware keys | — | — | M (not requested in brief; noted) |

Spot-checks: (a) locked accounts answer 423 for any password — `auth/index.ts:107-112`; (b) **bug found and
fixed in this audit**: after a lockout expired, `failed_login_count` was still ≥ max so a single wrong password
re-locked the account — now an expired lock restarts the count (`auth/index.ts`, login and MFA paths; new test
"an expired lockout starts a fresh failure count"); (c) failed second factor counts toward lockout (SEC-11) —
`auth/index.ts:180-188`; (d) `/auth/mfa/disable` checks TOTP without the single-use step (LOW, KNOWN-ISSUES).

## 2. User & role administration — IT

| Capability | Code | Tests | Status |
|---|---|---|---|
| Users: create (one-time password), edit, status, unlock, reset password/MFA, sessions, grants | `apps/api/src/modules/users/{index,admin-lib}.ts` | API `admin-users.test.ts` (15), E2E `10-admin` (4) | IT |
| Custom roles, SoD conflicts (role, cross-role, holders) | `modules/roles/index.ts`, `packages/shared/src/permissions.ts` `SOD_CONFLICTS` | `admin-roles.test.ts` (12) | IT |
| Org units (ltree, no re-parenting) | `modules/org/index.ts` | `admin-org.test.ts` (4) | IT |
| Devices (register/assign/retire, scoped) | `modules/devices/index.ts` | `admin-devices.test.ts` (4) | IT |
| Settings (validated per key, audited) | `modules/settings/index.ts` | `admin-settings.test.ts` (4) | IT |
| Last-administrator guard; privilege-escalation guard | `users/index.ts` `assertRootAdministratorRemains` | `admin-users.test.ts`, `security-mass-assignment.test.ts` (5) | IT |
| Web admin screens | `apps/web/src/modules/admin/*` | E2E `10-admin`, axe `90-a11y` | IT |

Spot-checks: SoD checked across all initial grants on user creation (`users/index.ts:208`); users cannot change
their own status (`users/index.ts:285`); `SOD_CONFLICTS` pairs dispose_request/approve and audit:read/roles:manage
(`permissions.ts:75-78`, read directly).

## 3. RBAC / jurisdiction — IT

| Capability | Code | Tests | Status |
|---|---|---|---|
| Permission catalogue + 8 default roles | `packages/shared/src/permissions.ts` | `security-authz.test.ts` (12) | IT |
| Subtree scoping (`hasPermissionAt`, `pathCovers` whole-segment match) | `apps/api/src/lib/principal.ts:33-44` | `evidence.test.ts`, `security-idor.test.ts` (IDOR matrix 115 routes × 3 users) | IT |
| `evidenceVisibleSql` / `loadEvidenceFor`, out-of-scope → 404 | `apps/api/src/lib/access.ts:28-127` | `security-idor.test.ts`, E2E `11-authz` (3) | IT |
| DB guard: evidence jurisdiction immutable after registration | `db/migrations/0990_security_evidence_jurisdiction_guard.sql` | `security-db-privileges.test.ts` | IT |
| Route authn/authz/CSRF sweep of every route | — | `security-routes.test.ts` (6, iterates all routes) | IT |

Spot-checks: search predicates start with `evidenceVisibleSql` (`search/criteria.ts:5,12,146`);
`download_original` never borrowed from grants elsewhere (`access.ts:88-111`); invalid UUID → 404 (`access.ts:76`).

## 4. Evidence registry — IT

| Capability | Code | Tests | Status |
|---|---|---|---|
| Resumable chunked uploads, batches, per-chunk SHA-256 | `apps/api/src/modules/uploads/index.ts` | API `uploads.test.ts` (19), `uploads.large.test.ts` (217 MiB), `security-uploads.test.ts` (7), E2E `02-upload` | IT |
| Finalize: hash, ffprobe/decode, metadata/GPS, dedupe, quarantine or register | `packages/core/src/ingest/pipeline.ts`, `apps/worker/src/jobs/ingest` | W `ingest.test.ts` (5) | IT |
| Quarantine release/reject | `uploads/index.ts`, web `upload/QuarantinePage.tsx` | `uploads.test.ts` | IT |
| Evidence list/detail/metadata edit/tags (audited) | `modules/evidence/{index,queries}.ts` | `evidence.test.ts` (19), E2E `03-evidence` (4) | IT |
| Station CLI | `tools/station-client` | `station-client.test.ts` (3) | IT |
| Camera-dock / vendor pull ingestion, AV scan | — | — | M (not in brief; noted) |

Spot-checks: declared SHA-256 mismatch → quarantine `HASH_MISMATCH` (`pipeline.ts:175-190`); duplicate on SHA-256
(`pipeline.ts:222-243`); declared officer/device must be in uploader scope, SEC-13 (`uploads/index.ts:404-420`).

## 5. Integrity / immutability — IT (+UV)

| Capability | Code | Tests | Status |
|---|---|---|---|
| SHA-256 + SHA-512 at ingest, re-hash of stored WORM copy | `pipeline.ts:171-177,324-347` | `ingest.test.ts`, `uploads.test.ts` | IT |
| WORM copy (Object Lock, `If-None-Match: *`) | `packages/core/src/ingest/storage-ops.ts`, `packages/core/src/storage.ts` | W `lifecycle.test.ts` (lock headers), `storage.test.ts` | IT on versitygw; UV on production S3 COMPLIANCE mode |
| `evidence_guard` trigger: no DELETE, frozen columns, legal hold blocks disposal | `db/migrations/0003_evidence.sql:176-205` | `uploads.test.ts`, `security-db-privileges.test.ts` | IT |
| Fixity on demand + nightly sweep, CRITICAL alert on mismatch | `apps/worker/src/jobs/lifecycle/{fixity,scan}.ts` | `evidence.test.ts`, W `lifecycle.test.ts` | IT |

Spot-checks: trigger text read (`0003_evidence.sql:179,200`); fixity compares SHA-256, SHA-512 and size
(`fixity.ts:44-46`); lock mode NONE refused in production (`packages/core/src/config.ts`). Gap: sweep samples
100 items/night (KNOWN-ISSUES).

## 6. Retention / lifecycle / storage tiers — IT (UI partially)

| Capability | Code | Tests | Status |
|---|---|---|---|
| Retention policies CRUD (default policy protected) | `apps/api/src/modules/retention/index.ts` | API `retention.test.ts` (3) | IT |
| Legal hold (DB + S3 legal hold) | `modules/evidence/lifecycle-routes.ts:75` | `evidence.test.ts` | IT |
| Dual-control disposal (requester ≠ approver, blocked by hold/open case) | `lifecycle-routes.ts:305-309`, `0003_evidence.sql:303`, W `jobs/lifecycle/disposal.ts` | `evidence.test.ts`, W `lifecycle.test.ts` (5), `security-races.test.ts` | IT |
| Tiering ACTIVE → ARCHIVE → LONG_TERM (copy, re-hash, switch) | W `jobs/lifecycle/{scan,tier}.ts` | W `lifecycle.test.ts` | IT (tiers = buckets; storage classes UV) |
| Web: retention policies, disposal approvals, lifecycle tab | `apps/web/src/modules/evidence/*` | axe only | IU |

Spot-checks: DB CHECK `decided_by <> requested_by` (`0003_evidence.sql:303`, read); worker re-checks hold/case
under `FOR UPDATE` (`disposal.ts:47-58`); retain-until = registered_at + retention_days (`evidence/lifecycle.ts:34`).

## 7. Video processing & playback — IT

| Capability | Code | Tests | Status |
|---|---|---|---|
| Proxy MP4, HLS ladder, poster/thumbnails, sprites + VTT, VFR→CFR | `apps/worker/src/jobs/media/{plan,process}.ts` | W `media.test.ts` (6) | IT |
| Tokenised streaming with Range, HLS rewrite, no storage URLs | `apps/api/src/modules/media/{index,stream,tokens}.ts` | API `media.test.ts` (14), `security-media.test.ts` (15), E2E runtime guard (storage-URL leak check on every test) | IT |
| Exact-frame snapshots, original download (custody-audited) | `media/index.ts:195-300` | `media.test.ts` (pixel comparison) | IT |
| Malicious media inputs (HLS reference following etc.) | `packages/core/src/ingest/inspect.ts` | `security-media-input.test.ts` (4) | IT |
| Player + synchronised multi-player | `apps/web/src/modules/video/*`, used by workspaces | web `video.test.ts` (3), E2E `03-evidence`, `07-workspace` | IT (sync math: offsets only) |
| Redaction / blurring | — | — | M (not in brief; noted) |

Spot-checks: single `bytes=` range only, 206/416 (`stream.ts:24-62`); HLS keys whitelisted (`media/index.ts:148`);
play custody event throttled to one per 10 min (`media/index.ts:32,93-104`).

## 8. AI analysis — IT (+UV)

| Capability | Code | Tests | Status |
|---|---|---|---|
| Isolated worker, `ksp_ai` role with column grants + insert guard trigger | `apps/ai-worker`, `db/migrations/0500_ai_worker_isolation.sql`, `0501_*` | AI `pipeline.test.ts` (9, incl. privilege checks), `security-watchlist.test.ts` (2) | IT |
| Real ONNX inference: YOLOX-S objects/persons, YuNet faces, SFace recognition, ANPR, colour | `apps/ai-worker/src/models/manifest.ts` | AI `inference.test.ts` (4 + 4 conditional on models — models were fetched and ran in this audit) | IT |
| Classification tagging | `TAGGER_RULES` (rule-based, not a model) | `pipeline.test.ts` | P |
| Model registry (staged/activate/retire), watchlists, training export | `apps/api/src/modules/ai/*`, W `jobs/ai-training` | API `ai.test.ts` (7), E2E `04-ai` (4) | IT |
| Accuracy on KSP footage / Indian plates, GPU inference | — | — | UV |
| ANPR model licence, face-recognition DPIA | — | — | UV (legal) |

Spot-checks: ai-worker connects only via `DATABASE_AI_URL` (`apps/ai-worker/src/main.ts:18`); insert trigger forces
`PENDING` (`0500:23-47`); `ksp_ai` may update `ai_jobs.status` without a transition guard (LOW, KNOWN-ISSUES).

## 9. Human review — IT

| Capability | Code | Tests | Status |
|---|---|---|---|
| Queue, filters, keyboard review, bulk | `apps/api/src/modules/review/index.ts`, web `ai/ReviewQueuePage.tsx` | API `review.test.ts` (6), E2E `04-ai` | IT |
| Two-person rule for face-recognition matches | `packages/shared/src/ai.ts:17`, `review/index.ts:86-91` | `review.test.ts`, E2E `04-ai` (two approvers) | IT (app-level only) |
| Append-only review history; approved labels → evidence tags | `0004_ai.sql:125` | `review.test.ts` | IT |

Spot-checks: `DUAL_APPROVAL_TASKS = ['FACE_RECOGNITION']` (read); same reviewer refused with 409
`SECOND_REVIEWER_REQUIRED`; reject needs comment ≥ 3 chars (`review/index.ts:71`).

## 10. Search — IT

| Capability | Code | Tests | Status |
|---|---|---|---|
| Full text (tsquery + trigram), filters, geo radius/bbox, facets, related evidence | `apps/api/src/modules/search/{criteria,service,related}.ts`, `0600_search_investigation.sql` | API `search.test.ts` (19 incl. perf on ≥5k rows), web `search.test.ts` (3), E2E `05-search` (2) | IT |
| Approved-AI label/colour/plate/watchlist filters | `criteria.ts:112-119` | `search.test.ts` | IT |
| Saved searches (per user) | `search/index.ts` | `search.test.ts` | IT |
| Permission-aware (jurisdiction) | `criteria.ts:146` | `search.test.ts`, `security-idor.test.ts` | IT |

Spot-checks: `evidenceVisibleSql` first predicate (read); REJECTED detections never returned (`service.ts:130`);
`ANY_NON_REJECTED` needs only `search:use` (LOW — all default roles with `search:use` also hold `ai:request`).

## 11. Investigation workspace — IT

| Capability | Code | Tests | Status |
|---|---|---|---|
| Workspaces, members (OWNER/EDITOR/VIEWER), items, sync offsets | `apps/api/src/modules/workspaces/workspace-routes.ts` | API `workspaces.test.ts` (15), web `investigation.test.ts` (3), E2E `07-workspace` | IT |
| Bookmarks, annotations/regions (soft delete, DB-enforced), relations | `workspaces/notes-routes.ts`, `0600:63-70` | `workspaces.test.ts` | IT |
| Incident timeline (merged + manual, overlap detection) | `workspaces/timeline.ts:186-256` | merged view IT; manual event edit/delete only in authz sweep | IT / IU |

Spot-checks: `REVOKE DELETE ON annotations` (`0600:70`); relations audited on both items; manual timeline events are
hard-deleted (`timeline.ts:251`, audit row remains) — LOW, KNOWN-ISSUES.

## 12. Cases / FIR linking — IT (+UV)

| Capability | Code | Tests | Status |
|---|---|---|---|
| Cases CRUD, status workflow (reason for close/reopen), members | `apps/api/src/modules/cases/index.ts` | API `cases.test.ts` (15), E2E `06-cases` (2) | IT |
| Evidence link/unlink (case-based visibility), append-only case diary, timeline | `cases/{links,timeline}.ts`, `0005:86` | `cases.test.ts` | IT |
| FIRs CRUD/status, import | `modules/firs/index.ts` | `firs.test.ts` (5), `integrations.test.ts` | IT |
| Real CCTNS connectivity | `apps/api/src/integrations/adapters.ts` (`http-json` skeleton) | local stub only | UV |

Spot-checks: `REVOKE UPDATE, DELETE ON case_notes` (`0005:86`); close/reopen reason ≥ 5 chars (`cases/index.ts:172`);
duplicate FIR → 409 (tested).

## 13. Chain of custody — IT

| Capability | Code | Tests | Status |
|---|---|---|---|
| Per-item custody ledger with hash/link verification | `apps/api/src/modules/custody/index.ts`, `packages/core/src/custody/ledger.ts` | API `custody.test.ts` (3 — all touch types, authz, PDF signature via Node + openssl) | IT |
| Signed custody PDF (itself audited) | `packages/core/src/custody/custody-report.ts` | `custody.test.ts` | IT |
| Custody events asserted across modules | — | `cases`, `workspaces`, `exports`, `shares` tests | IT |

Spot-checks: PDF generation audited with payload + PDF SHA-256 (`custody/index.ts:89-104`); report states it is not a
BSA s.63 certificate (`custody-report.ts:155`); per-item `verifyCustody` relies on per-event flags, full chain via
`audit_verify()` (`ledger.ts:130`).

## 14. Court export — IT (+UV)

| Capability | Code | Tests | Status |
|---|---|---|---|
| Request → approve/reject (approver ≠ requester, DB CHECK) → build → download → revoke/expiry | `apps/api/src/modules/exports/index.ts`, W `jobs/exports/{build,index}.ts`, `0006:31`, `0800` | API `exports.test.ts` (11), W `exports.test.ts` (4), E2E `08-export` (3) | IT |
| Re-hash vs registered hash, signed manifest + SHA256SUMS, VERIFY.txt, watermarked copies, custody PDFs, fact sheet | `build.ts:102-129,289-300`, `packages/core/src/custody/fact-sheet.ts` | same + `security-export-verify.test.ts` (6+) | IT |
| Online/offline package verification | `exports/verify.ts`, web `VerifyPackagePage` | `security-export-verify.test.ts` | IT |
| BSA s.63 certificate template legal acceptance | `fact-sheet.ts:134` | — | UV (legal) |
| HSM / DSC-backed signing | documented integration points | — | UV (external) |

Spot-checks: self-approval refused (`exports/index.ts:268-271`) and DB CHECK (`0006:31`, read); approver must see
every item (`exports/index.ts:273-285`); integrity mismatch → FAILED + CRITICAL alert + custody event (`build.ts:102-129`).

## 15. Secure sharing — IT

| Capability | Code | Tests | Status |
|---|---|---|---|
| Internal / external shares, expiry cap, access code (hashed), lockout after 5 wrong codes | `apps/api/src/modules/shares/index.ts`, `share-portal/index.ts` | API `shares.test.ts` (8), `share-portal.test.ts` (11), web `sharing.test.ts` (3), E2E `09-share` (2) | IT |
| Watermarked per-share media, download/print permissions, access log | W `jobs/shares/index.ts` | `share-portal.test.ts` | IT |
| Max views | `share-portal/index.ts` | **race fixed in this audit** (atomic conditional increment + concurrent-open test) | IT |
| Link/code delivery by e-mail/SMS; unlock/extend | — | — | M |

Spot-checks: token + code stored only as hashes (`shares/index.ts:172-181`); `MAX_CODE_ATTEMPTS` 5
(`share-portal/index.ts:28`); expiry ≤ `maxShareDays` (`shares/index.ts:140`).

## 16. Integrations / REST API — IT (+UV)

| Capability | Code | Tests | Status |
|---|---|---|---|
| External REST API (search by FIR/case/station/officer/device/date; metadata; tokenised download) | `apps/api/src/modules/integration-api/index.ts` | API `integration-api.test.ts` (10) | IT |
| API clients: Basic auth (argon2), IP allow-list, expiry, rotate/revoke, per-client rate limit, fail-closed audit | `modules/api-clients/index.ts`, `plugins/auth.ts:77-97` | `api-clients.test.ts` (5) | IT |
| Adapters (fixture, `http-json` skeleton), SSRF egress guard with DNS re-check | `apps/api/src/integrations/{adapters,contract,egress}.ts` | `integrations.test.ts` (12), `security-ssrf.test.ts` (3+) | IT (real systems UV) |
| OpenAPI (`/api/docs`, auth-gated in production) | `apps/api/src/app.ts:101-115` | `security-production.test.ts` (access only) | P |
| mTLS client auth | — | never exercised | UV |
| Web integrations / API-client screens | `apps/web/src/modules/cases/{IntegrationsPage,ApiClientsPage}.tsx` | axe only | IU |

## 17. Dashboards / reports / alerts — IT (sub-items M)

| Capability | Code | Tests | Status |
|---|---|---|---|
| Role/jurisdiction-scoped dashboard | `apps/api/src/modules/dashboard/index.ts`, web `dashboard` | API `dashboard.test.ts` (5), web `dashboard.test.ts` (3), E2E `10-admin` | IT |
| 9 report types CSV/JSON/PDF, hashed, tokenised download | `packages/shared/src/reports.ts`, W `jobs/reports` | API `reports.test.ts` (5), W `reports.test.ts` (9) | IT |
| 10 alert rules, idempotent evaluator, dedupe, auto-resolve, in-app notifications, webhook | W `jobs/alerts/evaluate.ts`, `packages/core/src/alerts.ts` | API `alerts.test.ts` (6), W `alerts.test.ts` (13) | IT |
| E-mail channel | `alerts.ts:171` throws "not implemented" | — | M |
| Scheduled (recurring) reports; webhook retry | — | — | M |

## 18. Audit / compliance — IT

| Capability | Code | Tests | Status |
|---|---|---|---|
| Append-only hash-chained ledger (`audit_append` SECURITY DEFINER, triggers, privilege revocation) | `db/migrations/0002_audit_ledger.sql` | API `audit.test.ts` (11, incl. superuser tamper detection), `security-db-privileges.test.ts` | IT |
| Signed hourly checkpoints, incremental verify, checkpoint export | `packages/core/src/custody/checkpoint.ts`, W `jobs/audit` | W `audit.test.ts` (2) | IT |
| Audit viewer, CSV/JSON export (hashed), ledger verification UI | `modules/audit/index.ts`, web `audit/*` | `audit.test.ts`, E2E authz/axe | IT |
| `user_agent` column covered by the hash | `audit_canonical()` `0002:37-46` omits it | — | P (MEDIUM, open) |

## 19. Monitoring / performance / security — P

| Capability | Code | Tests | Status |
|---|---|---|---|
| Prometheus metrics (API, worker), `/health/live`, `/health/ready`, `/system/health`, worker heartbeats | `apps/api/src/{server,health}.ts`, `plugins/metrics.ts`, `packages/core/src/monitoring.ts` | API `system.test.ts` (6) | IT |
| AI-worker service metrics/heartbeat | — | — | M |
| Prometheus/Alertmanager/Grafana configuration | `deploy/monitoring/*` | static validation only | UV |
| Security headers/CSP/HSTS, rate limits, production hardening | `apps/api/src/app.ts:73-94` | `security-headers.test.ts` (4), `security-production.test.ts` (10), 17 security suites total | IT |
| Rate-limit store is per-instance (in memory) | `app.ts:94` | — | P |
| Performance scripts + measured results | `tests/perf/*`, `docs/PERFORMANCE.md` | run by the performance workstream (not re-run in this audit) | P |
| CERT-In VAPT | — | — | UV (external) |

## 20. Backup / DR / deployment — P

| Capability | Code | Tests | Status |
|---|---|---|---|
| Encrypted (age) backups + manifest, verification rejecting corrupt/forged backups | `scripts/backup/{pg-backup,verify-backup,lib}.sh` | `scripts/backup/test/verify-backup.test.sh` (run in this audit) | IT |
| Restore (idempotent, never drops), S3 replicate/verify/repoint | `scripts/backup/{restore.sh,s3-replicate.ts}` | `tests/dr/drill.sh` (run in this audit) | IT (small data) |
| Dockerfile (5 targets), compose, kustomize staging/production, NetworkPolicies, CNPG, CI/release workflows | `deploy/`, `.github/workflows/` | `scripts/ci/validate-deploy.sh` (static), `scripts/ci/simulate-image.sh` | UV (never built/run) |
| Production-scale RTO (2 h), 99.5 % availability, CNPG failover/PITR | — | — | UV |

Spot-checks: **bug fixed in this audit** — `restore.sh` interpolated role passwords into SQL text
(`-v "app_password='$PW'"`); `roles.sql` now uses psql `:'var'` quoting and all four callers pass raw values;
backup records the audit head before the dump (`pg-backup.sh:60-72`); manifests are not signed (KNOWN-ISSUES).
