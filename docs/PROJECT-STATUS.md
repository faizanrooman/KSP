# Project Status

_Last updated: 2026-09-27 (final audit, agent 20)._

## Overall
REAL IMPLEMENTATION STATUS: **FEATURE-COMPLETE FOR THE 20 SPECIFICATION MODULES ON THE DEVELOPMENT HOST — all automated suites green; deployment artefacts never run; external/legal blockers open. Ready for a staging/UAT deployment once images are built and verified; NOT production-ready.** Verdict and conditions: [FINAL-AUDIT.md](FINAL-AUDIT.md); module-by-module evidence: [REQUIREMENTS-TRACEABILITY.md](REQUIREMENTS-TRACEABILITY.md).

## Completed (implemented + automatically tested on `main`)
| Area | Evidence of verification |
|---|---|
| Foundation: schema 0001–0006, shared contracts, core platform, dev services without Docker | migrations apply on clean DB; codegen reproducible |
| Tamper-evident audit ledger (hash chain, append-only, privilege revocation) | superuser tampering detected by `audit_verify()`; app role cannot UPDATE/DELETE/INSERT directly |
| Object storage WORM (versioning + Object Lock + conditional writes) | overwrite → PreconditionFailed; locked version delete → AccessDenied (versitygw) |
| Authentication (password policy/history, lockout, IP throttle, TOTP MFA + recovery codes, refresh rotation with reuse detection, CSRF, session limits) | 13 API tests |
| Evidence ingestion (resumable chunked uploads, validation, SHA-256/512, dedupe, quarantine, WORM registration, metadata/GPS extraction, station CLI, web uploader) | API/worker/CLI tests incl. 217 MiB upload; headless-browser run by the agent |
| Evidence registry, legal hold, fixity, tiering, retention, dual-control disposal | API + worker tests |
| Video pipeline (proxy, HLS ladder, poster/thumbnail/sprites), tokenised streaming with Range, original download, exact-frame snapshots, player + synchronised multi-player | API + worker tests; exact-frame pixel comparison; agent headless-browser smoke |
| Identity & administration (users, role assignments with privilege-escalation guard, custom roles with SoD checks, org units, devices, settings; admin UI) | 51 admin/security API tests |
| Cases/FIR, evidence linking (case-based visibility), append-only case diary, timeline; integration adapters (fixture + http-json skeleton, SSRF-guarded); API clients; external REST API (search/metadata/tokenised download) | 47 API tests; external systems UNVERIFIED |
| Advanced permission-aware search (text, jurisdiction, officer/device, time, radius/bbox, tags, case/FIR, tiers, approved-AI label/colour/plate/watchlist; facets; saved searches; related evidence) + investigation workspaces (members, items, sync offsets, bookmarks, annotations/regions, incident timeline with overlap detection, relations) | 33 API tests; search ≈25–30 ms/API call on ~6k rows |
| Isolated AI platform (separate worker, ksp_ai DB role with column grants + DB trigger guard; real ONNX models: YOLOX-S objects/persons, YuNet faces, SFace recognition vs watchlists, ANPR detector+OCR, colour, rule-based tagging) + human review (queue, keyboard review, two-person rule for face matches, approved tags, history, training exports) | 13 API + 17 ai-worker tests with real inference; dev E2E ≈295 ms/frame for all 6 tasks on CPU |
| Chain of custody (per-item ledger verification, signed custody PDF), audit viewer/export/verify with signed hourly checkpoints, court export (dual approval, re-hash, signed manifest, Fact Sheet with BSA s.63 template, watermarked copies, offline VERIFY.txt), secure sharing (internal/external, access codes with lockout, expiry, max views, watermarked per-share media, access log) | 43 API + 6 worker tests; agent headless-browser run |
| Dashboards (role/jurisdiction-scoped KPIs, charts with text summaries), alerts (10 rules, cursor-based idempotent evaluator, dedupe, auto-resolve, notifications, webhook channel), 9 report types (CSV/JSON/PDF, hashed, jurisdiction-scoped), storage snapshots, Prometheus metrics, worker heartbeats, `/system/health` | 22 API + 27 worker tests; dashboard 75–82 ms on 50k rows |
| Internal security assessment (route-level authz/CSRF sweep of every route, SSRF, malicious media inputs, DB privilege tests, headers, crypto; semgrep, gitleaks, npm audit; STRIDE threat model) — 7 findings fixed incl. HIGH: FFmpeg followed references inside uploaded HLS playlists | 7 security suites; `docs/SECURITY-TEST-REPORT.md` (NOT a CERT-In VAPT) |
| DevOps & DR: multi-target Dockerfile, compose, kustomize k8s (staging/prod), CI + release workflows, encrypted backups (age) + verification, S3 replication/repoint, local DR drill | production entrypoints run from simulated image layouts; validators green; backup verify 8/8; DR drill restore→ready 3.9 s on ~44 MB (small-data only) |
| End-to-end browser suite (Playwright, real stack, Chrome headless): 11 scenario specs + axe on 64 page states + keyboard-only + responsive (1280/768); runtime guard (console errors, failed API calls, storage-URL/bucket-name leaks) on every test. 14 UI/API bugs fixed | 48/48 passed in two consecutive runs (4.4 min and 4.3 min); 0 axe violations after fixes (4 serious before); `docs/E2E-TESTS.md`, `docs/ACCESSIBILITY.md` |
| Security round 2 (IDOR matrix 115 routes × 3 users, JWT/session/MFA attacks, races, media tokens/traversal/Range, upload abuse, zip bombs, injection, production headers/rate limits; Trivy) — 8 more findings fixed (SEC-09…SEC-16) + lockout password oracle | 12 security suites; 0 HIGH/CRITICAL (Trivy/npm audit) |
| Performance (100k evidence, 500k detections, 1.14M audit events): query-shape fixes, list 84→14 ms (station) / 393→57 ms (state), dashboard 306→33 ms; upload 203 MB/s single file; audit append ≤1.2k/s | `docs/PERFORMANCE.md` (single host, noisy) |
| End-to-end integration (orchestrator): station CLI upload → REGISTERED → media READY → HLS playable via token; other-jurisdiction IO gets 404; audit chain intact | manual run 2026-09-25 |
| Final audit (agent 20): full re-verification on a fresh worktree + fresh-clone check; 4 small bugs fixed (share maxViews race, lockout re-trigger after expiry, restore.sh password quoting, DR drill orphaned services) + migrate/codegen from source | FINAL-AUDIT.md §3 |

Test totals (final audit branch, 2026-09-27): API 446 · worker 55 · ai-worker 19 · web 23 · station client 3 · E2E 48 (594 total) — all passing; build, typecheck (+e2e), lint (0 errors, 5 warnings), web build green. `main` at `8ede45c` had 592 (API 444); the audit added 2 regression tests.

## In Progress
Completion pass: B (e-mail alerts, scheduled reports, AI-worker metrics, sharing, fixity coverage, DR disposal, ingestion/video fixes) and C (Kannada PDFs, keyboard annotations, E2E coverage, code splitting, custody paging, react-router 7, CI). Completion A (security/backend hardening) merged 2026-09-27: API 466 tests, backup verify 14/14, DR drill restore→ready 4.7 s.

## Queued
Production-readiness conditions listed in [FINAL-AUDIT.md](FINAL-AUDIT.md) §8.

## Blocked / external
CCTNS/FIR/case-diary API contracts (not in spec) · CERT-In VAPT · HSM/DSC signing key · production S3 IAM separation · legal review (ANPR model licence, face-recognition DPIA, BSA s.63 template / export package) · GPU/transcoding capacity decision · custodian export-approval decision · react-router major upgrade. Tracked in [KNOWN-ISSUES.md](KNOWN-ISSUES.md) (EXT-*).

## Unverified
AI model accuracy on real KSP body-worn footage and Indian plates · GPU inference · Docker/compose/k8s (no Docker access on host) · behaviour on AWS S3/MinIO/Ceph (only versitygw tested) · uploads > 5 GiB · Safari native HLS · real 1080p30 long-footage throughput · 99.5% availability and 2-hour restoration targets at production scale (only a small-data local drill has run).

## Tests
See totals above. Commands (exact runs and durations in FINAL-AUDIT.md §3): `npm run build`, `npm run typecheck`, `npm run typecheck:e2e`, `npm run lint`, `npm test -w @ksp/api` (likewise `@ksp/worker`, `@ksp/ai-worker`, `@ksp/web`, `@ksp/station-client`), `(cd apps/web && npx vite build)`, `scripts/backup/test/verify-backup.test.sh`, `tests/dr/drill.sh`, `scripts/ci/validate-deploy.sh`, `tests/e2e/scripts/stack.sh start && npm run test:e2e`.

## Security
Implemented: RBAC + jurisdiction scoping (404 for out-of-scope), least-privilege DB roles, CSRF, rate limiting, security headers/CSP, tokenised media, no storage URLs to clients, audit of every evidence touch. Done: two internal assessment rounds (see SECURITY-TEST-REPORT.md), semgrep/gitleaks/npm audit/Trivy fs+config, STRIDE threat model. Not done: CERT-In empanelled VAPT, container image scanning (no Docker).

## Deployment
DevOps/DR workstream (see DEPLOYMENT.md, DISASTER-RECOVERY.md): multi-target Dockerfile, compose stack, kustomize base +
staging/production overlays, CI/CD workflows, monitoring config, encrypted backups, restore, S3 replication with hash
verification. **Verified locally:** `npm run build`; every production entrypoint (api, worker, ai-worker, migrate, seed)
started from a reproduction of the image layout with `npm ci --omit=dev` in `NODE_ENV=production`; static validation
(hadolint, shellcheck, kustomize+kubeconform 94 objects, actionlint, `docker compose config`); backup verification
rejects 7/7 corrupted or forged backups; **DR drill passed** (5 videos, restore→service ready 3.9 s, fixity of every
original from the DR copy, audit chain intact). **UNVERIFIED:** image builds, compose/k8s runtime, GitHub Actions runs,
CNPG failover/PITR, native object replication, production-scale RTO (2 h target).

## Known Issues
See `docs/KNOWN-ISSUES.md`.

## Next Actions
1. Orchestrator: review and merge the final-audit branch.
2. Build the container images and deploy to a staging cluster (first real run of Dockerfile/k8s/CI); repeat E2E + DR drill there.
3. Resolve the production conditions in [FINAL-AUDIT.md](FINAL-AUDIT.md) §8 (VAPT, HSM/DSC, CCTNS contracts, legal reviews, S3 IAM, capacity, re-verification off the faulty dev host).
