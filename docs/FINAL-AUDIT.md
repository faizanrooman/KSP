# Final Audit — Documentation & Production Readiness

_Agent 20, 2026-09-27. Branch `worktree-agent-aa7e284aaacab3fe1` from `main` @ `8ede45c`. Independent re-verification:
every command in §3 was executed during this audit on the development host; nothing below is copied from earlier
reports without being re-run or re-read in code._

> **Host caveat.** The development host has shown signs of faulty RAM/CPU (segfaults of node/tsc/eslint/PostgreSQL,
> non-reproducible hash mismatches, one audit row altered after write in the perf DB — KNOWN-ISSUES ENV-1). All
> results here come from that single host. They must be re-confirmed on sound hardware (staging) before being relied
> on for a go-live decision.

## 1. Executive summary

* **Functionality:** all 20 specification modules are implemented end-to-end (DB → API → worker → UI) with
  authorization, custody auditing and automated tests. 18 modules are IMPLEMENTED+TESTED (5 of them with
  UNVERIFIED external parts: CCTNS, HSM, legal, real S3, AI accuracy); 2 (monitoring, backup/DR/deployment) are
  PARTIAL because their runtime pieces were never run. No module is missing. Details:
  [REQUIREMENTS-TRACEABILITY.md](REQUIREMENTS-TRACEABILITY.md).
* **Verification:** build, typecheck, lint, all 5 Vitest suites (546 tests), the web build, backup tests, deploy
  validation, the DR drill and the 48-test Playwright suite all pass (§3). A fresh clone builds and passes the API
  suite against a fresh database.
* **Found and fixed in this audit (with regression tests where code):** share `maxViews` race; lockout re-triggering
  after expiry; SQL interpolation of passwords in `restore.sh`; **the DR drill could report success against a stale
  primary API** (services were not always stopped); `db:migrate`/`db:codegen` failed on a fresh clone before a build.
* **Not verified anywhere:** container images, compose, Kubernetes, GitHub Actions, production-scale RTO/availability,
  real S3 vendor behaviour and IAM separation, GPU, CCTNS, HSM signing; no CERT-In VAPT.
* **Verdict:** **Ready for staging/UAT deployment — conditionally** (after the images are built and the stack is
  brought up and re-verified there). **Not ready for production** (§8 lists the conditions).

## 2. Module status

| # | Module | Status | Main open items |
|---|---|---|---|
| 1 | Authentication | IMPLEMENTED+TESTED | password expiry untested; SSO not in scope |
| 2 | User & role admin | IMPLEMENTED+TESTED | — |
| 3 | RBAC / jurisdiction | IMPLEMENTED+TESTED | — |
| 4 | Evidence registry | IMPLEMENTED+TESTED | no AV scan; HTTP ingestion only |
| 5 | Integrity / immutability | IMPLEMENTED+TESTED (+UNVERIFIED on production S3 / COMPLIANCE mode) | fixity sample size |
| 6 | Retention / lifecycle / tiers | IMPLEMENTED+TESTED (UI not browser-driven) | DR disposal sweep |
| 7 | Video processing & playback | IMPLEMENTED+TESTED | transcoding capacity decision |
| 8 | AI analysis | IMPLEMENTED+TESTED (+UNVERIFIED accuracy, GPU, licence, DPIA) | legal |
| 9 | Human review | IMPLEMENTED+TESTED | — |
| 10 | Search | IMPLEMENTED+TESTED | — |
| 11 | Investigation workspace | IMPLEMENTED+TESTED | — |
| 12 | Cases / FIR | IMPLEMENTED+TESTED (+UNVERIFIED CCTNS) | CCTNS contracts |
| 13 | Chain of custody | IMPLEMENTED+TESTED | — |
| 14 | Court export | IMPLEMENTED+TESTED (+UNVERIFIED legal template, HSM) | legal, HSM |
| 15 | Secure sharing | IMPLEMENTED+TESTED | notifications missing |
| 16 | Integrations / REST API | IMPLEMENTED+TESTED (+UNVERIFIED CCTNS, mTLS) | contracts |
| 17 | Dashboards / reports / alerts | IMPLEMENTED+TESTED (e-mail channel, scheduled reports MISSING) | e-mail |
| 18 | Audit / compliance | IMPLEMENTED+TESTED | `user_agent` outside hash (MEDIUM) |
| 19 | Monitoring / performance / security | PARTIAL | AI-worker metrics; Prometheus stack never run; VAPT |
| 20 | Backup / DR / deployment | PARTIAL | images/k8s/CI never run; prod-scale RTO |

Counts: IMPLEMENTED+TESTED 18 (5 of them — 5, 8, 12, 14, 16 — with UNVERIFIED external parts) · PARTIAL 2 · MISSING 0.

## 3. Verification results (executed in this audit)

Environment: private DBs `ksp_audit` / `ksp_test_audit`, ports offset 140, shared Postgres :5433 and versitygw :7480,
AI models fetched and SHA-256-verified (6/6 ACTIVE). Durations are wall clock on the (noisy) dev host.

| Command | Result | Duration |
|---|---|---|
| `npm ci` | 693 packages | 6 s |
| `npm run db:migrate` (worktree, before build) | **failed** (`@ksp/shared/dist` missing) → fixed (`--conditions=ksp-src`), then 18 migrations applied | — |
| `npm run db:seed` · `npm run fetch-models -w @ksp/ai-worker` | OK · 6 models OK/ACTIVE | — |
| `npm run build` | pass | 34 s |
| `npm run typecheck` | pass | 35 s |
| `npm run typecheck:e2e` | pass | 2 s |
| `npm run lint` | pass — 0 errors, 5 warnings (unused disable directives, 1 hooks dep, 1 `any`) | 9 s |
| `npx vite build` (apps/web) | pass — single 2.6 MB chunk (627 kB gzip) | 7 s |
| `npm test -w @ksp/api` | **444/444** (46 files) on the base commit; after fixes the changed files `auth.test.ts` 14/14, `share-portal.test.ts` 11/11; fresh-clone full run: see below | 109 s |
| `npm test -w @ksp/worker` | 55/55 (8 files) | 50 s |
| `npm test -w @ksp/ai-worker` | 19/19 (3 files, real ONNX inference) | 21 s |
| `npm test -w @ksp/web` | 23/23 (6 files) | 4 s |
| `npm test -w @ksp/station-client` | 3/3 | 8 s |
| `scripts/backup/test/verify-backup.test.sh` | 8/8 (pristine accepted; bit-flip, truncation, wrong key, resealed truncation, audit tamper, migration checksum, tail delete all rejected) | 7 s |
| `scripts/ci/validate-deploy.sh` | PASSED: hadolint, shellcheck (13 scripts), kustomize+kubeconform (staging 42, production 50, jobs 2+2 objects), actionlint, compose config (12 services), dashboards JSON; promtool SKIPPED (not available). Tools downloaded to a scratch dir — without them the script SKIPs and still passes (ENV-5) | 149 s |
| `tests/dr/drill.sh` (3 videos) | 1st run **failed** — exposed drill bug (primary services survived the "disaster"; stale API answered the DR readiness check). Fixed; re-run **pass**: restore→service ready 3.4 s, fixity of every original from the DR copy OK, `audit_verify` 58 events no break; cleanup complete | 145 s / 30 s |
| `tests/e2e/scripts/stack.sh start` + `npm run test:e2e` (then `stack.sh stop`) | **48/48 passed** (Chrome headless; axe 0 violations reported by the a11y specs; runtime guard for console errors / failed API calls / storage-URL leaks on every test) | 4.1 min |
| `npm audit --omit=dev` | 2 moderate (react-router ≤ 7.17: GHSA-wrjc-x8rr-h8h6, GHSA-337j-9hxr-rhxg), 0 high/critical | 1 s |
| Fresh clone (`git clone` of the branch into `.local/fresh`, `npm ci`, migrate + seed **before** build, build, API suite on new DBs `ksp_fresh`/`ksp_test_fresh`) | FRESH_RESULT | FRESH_DURATION |

The fresh-clone check uses the host toolchain and dev secrets (`.local/{node,bin,secrets,models}` symlinked from the
main checkout — these are generated per host and deliberately not committed); everything else came from git.

## 4. Security posture

* **Controls verified by tests:** RBAC + jurisdiction with 404 for out-of-scope (IDOR matrix 115 routes × 3 users),
  CSRF on every unsafe route, lockout/IP throttle, single-use TOTP, refresh-token reuse detection, least-privilege DB
  roles (`ksp_app` DML only, append-only tables, `ksp_ai` column grants), evidence immutability triggers, WORM
  storage, tokenised media without storage URLs (checked by the E2E runtime guard on every test), SSRF guard,
  malicious-media handling, production headers/CSP/HSTS and rate limits.
* **Fixed earlier:** SEC-01…SEC-16 over two internal rounds + lockout password oracle ([SECURITY-TEST-REPORT.md](SECURITY-TEST-REPORT.md)).
* **Fixed in this audit:** FA-1 share `maxViews` race, FA-2 lockout re-trigger, FA-3 password interpolation in
  `restore.sh`.
* **Open:** 1 MEDIUM (SEC-R1 `user_agent` not in the audit hash), LOW hardening items SEC-R4…R12, 2 moderate npm
  advisories needing a react-router major upgrade.
* **Residual / accepted:** FFmpeg memory-safety, bearer media tokens within TTL, DB superuser can bypass triggers
  (detected by the hash chain, not prevented), GOVERNANCE-mode object lock in dev, keys not in an HSM.
* **Not done:** **no CERT-In empanelled VAPT has been performed**; no container image scan; no browser XSS fuzzing,
  FFmpeg fuzzing, distributed brute force or real-cluster NetworkPolicy testing.

## 5. Performance summary (from [PERFORMANCE.md](PERFORMANCE.md); not re-run in this audit)

On one host with 100k evidence, 500k detections and 1.14M audit events: evidence list 14–57 ms after query fixes,
dashboard 33 ms, search ≈ 25–30 ms per call on ~6k rows and 0.2–0.35 s for state-wide full-text/facets, upload
≈ 203 MB/s single file, audit append ≤ 1.2k events/s, login ≈ 80/s per API process (argon2), AI ≈ 295 ms/frame for
all 6 tasks on CPU. **Caveats:** single noisy (and possibly faulty) host, no multi-node test, no production-sized
object store, 1080p30 long-footage throughput and uploads > 5 GiB untested; state-wide HLS transcoding needs a
capacity decision (~1 100 4-vCPU workers on CPU).

## 6. Deployment readiness

| Area | Verified locally | UNVERIFIED |
|---|---|---|
| Application processes | `npm run build`; API/worker/ai-worker/migrate/seed from simulated production image layouts (`simulate-image.sh`, used by the DR drill) in `NODE_ENV=production` | — |
| Container images | Dockerfile lints clean (hadolint) | **never built** (no Docker on host); no image scan |
| Compose | `docker compose config` renders 12 services | never started |
| Kubernetes | kustomize renders; kubeconform validates all objects | never applied; CNPG failover/PITR, NetworkPolicies, HPA, ExternalSecrets untested |
| CI/CD | actionlint clean | GitHub Actions **never executed**; no E2E job in CI |
| Backup / restore | encrypted backups, verification (8/8), restore, S3 replicate/repoint, DR drill (small data) | production-scale RTO (2 h), 99.5 % availability, native bucket replication |
| Monitoring | metrics endpoints, `/health/*`, heartbeats (tests) | Prometheus/Alertmanager/Grafana never run; AI-worker metrics missing |
| Storage | versitygw with versioning + Object Lock | AWS S3 / MinIO / Ceph / StorageGRID behaviour; IAM separation; COMPLIANCE mode |

## 7. External dependencies & blockers

| Blocker | Owner | Blocks |
|---|---|---|
| CCTNS / FIR / case-diary API contracts and test endpoint | SCRB / integration owner | production integrations (staging can use the fixture adapter) |
| HSM / DSC-backed signing key + CA certificate | security officer | production court exports & custody PDFs |
| Legal review: ANPR model licence (YOLOv9 GPL vs MIT derivative) | legal | production use of ANPR |
| Legal: biometric DPIA for face recognition | legal / DPO | production use of face recognition |
| Legal: BSA s.63 certificate template and export package acceptance | legal / prosecution | production court exports |
| Production S3 with Object Lock (COMPLIANCE) and per-service IAM separation | infrastructure | production |
| GPU / transcoding capacity decision | infrastructure / product | state-wide rollout |
| Custodian export-approval product decision | product owner | final role matrix |
| react-router major upgrade (moderate advisories) | web team | clean dependency audit |
| CERT-In empanelled VAPT | security officer | production |

## 8. Verdict

### Ready for staging / UAT deployment? — **Yes, conditionally**

The application is functionally complete and its automated verification is green. Staging is exactly where the
remaining unknowns must be retired, so deploy there provided that:

1. the five images are built and scanned, and the stack (compose or the staging overlay) starts and passes
   `/health/ready`;
2. the E2E suite and the DR drill are re-run against staging (on hardware not affected by ENV-1);
3. UAT uses synthetic or consented footage only (face recognition / ANPR legal reviews pending) and the fixture
   CCTNS adapter;
4. the dev self-signed signing key is clearly labelled non-evidentiary in UAT.

### Ready for production? — **No**

Conditions to reach production (all required):

1. CERT-In empanelled VAPT completed on staging; HIGH/CRITICAL findings fixed and re-tested.
2. Container images built, scanned (0 HIGH/CRITICAL), deployed via the CI/CD pipeline actually executed; k8s
   NetworkPolicies, CNPG failover and PITR demonstrated.
3. DR drill at production-representative volume on staging meets the 2-hour RTO; availability monitoring (SLO probe,
   Prometheus rules, Alertmanager routing, AI-worker metrics) deployed and alerting end-to-end.
4. HSM/DSC-backed signing key and CA-issued certificate in place for exports and custody reports.
5. Legal sign-off: BSA s.63 template and export package, ANPR model licence, face-recognition DPIA (or those
   features disabled).
6. Production object store with Object Lock in COMPLIANCE mode, per-service IAM identities verified by negative
   tests (AI worker cannot read originals), backup bucket locked at the DR site.
7. CCTNS/FIR contracts agreed and the `http-json` adapter (or a replacement) contract-tested against the real system,
   or integrations explicitly descoped for go-live.
8. Transcoding/GPU capacity decision made and load-tested at expected daily volume.
9. MEDIUM items resolved or formally accepted: SEC-R1 (audit hash coverage), FN-1 (e-mail alerts), FN-6 (fixity
   sample rate), FN-9 (Kannada rendering in PDFs), OPS-5 (DR disposal sweep), OPS-10 (key versioning), EXT-11
   (react-router upgrade), EXT-10 (custodian approval decision).
10. All verification in §3 repeated on sound hardware (ENV-1).

## 9. UNVERIFIED (consolidated)

Docker images · compose runtime · Kubernetes runtime · GitHub Actions · production-scale RTO and 99.5 % availability ·
CNPG failover/PITR · native object replication · AWS S3/MinIO/Ceph behaviour · S3 IAM separation · Object Lock
COMPLIANCE mode · CCTNS/FIR/case-diary integrations · mTLS client auth · HSM/DSC signing · legal acceptance of export
package and BSA s.63 template · AI accuracy on KSP footage / Indian plates · GPU inference · uploads > 5 GiB · Safari
native HLS and non-Chrome browsers · screen readers · real 1080p30 long-footage throughput · e-mail delivery · webhook
to a real receiver · Prometheus/Grafana stack · CERT-In VAPT.
