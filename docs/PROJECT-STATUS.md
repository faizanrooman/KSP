# Project Status

_Last updated: 2026-10-10 (demo feedback fixes)._

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
| Completion B (2026-09-27): SMTP e-mail alerts + retried deliveries (FN-1), scheduled reports (FN-2), AI-worker heartbeat/metrics/alert rules (FN-3), share unlock/extend/e-mail/re-issue + internal maxViews + variant deletion (FN-10/11), fixity coverage incl. RETAINED/DR copies (FN-6), DR disposal sweep (OPS-5), async quarantine release (FN-4), recordedAt precedence (FN-5), generation-prefixed reprocess (FN-7), queued snapshots (FN-8), timeline soft delete (FN-12), CLI fresh summary (FN-22); migrations 1050–1057 | API 478 · worker 66 · ai-worker 21 · web 23 · station client 4; build/typecheck/lint/vite green. Real SMTP relay, Prometheus rules and native DR replication UNVERIFIED; DR drill not re-run (`age` missing on host) |
| Completion C (2026-09-27): Kannada in every PDF (bundled Noto Sans + Noto Sans Kannada, HarfBuzz shaping, /ActualText; FN-9), keyboard region annotations (FN-17), E2E for integrations / API clients / retention / two-officer disposal (FN-18), route-level code splitting (first page 2 615 → 548 kB JS; FN-24), custody keyset paging + capped search totals + bounded facets (FN-19/FN-13), react-router 7 (0 prod audit findings; EXT-11/SEC-08/SEC-18), AI test race fixed (FN-25), CI e2e job + pinned validator installer + strict validate-deploy (OPS-2/ENV-5); disposed-evidence thumbnail 404 fixed | API 482 · worker 66 · ai-worker 21 · web 25 · core 5 · station client 4 · E2E 52 (two consecutive full runs green); build, typecheck (+e2e), lint 0 errors, `validate-deploy.sh --strict --no-docker` passed; `ai.test.ts` 10/10 |
| Final audit (agent 20): full re-verification on a fresh worktree + fresh-clone check; 4 small bugs fixed (share maxViews race, lockout re-trigger after expiry, restore.sh password quoting, DR drill orphaned services) + migrate/codegen from source | FINAL-AUDIT.md §3 |
| Production hardening (2026-10): preflight refusing dev settings in production tiers, legal gates for FACE_*/ANPR (`aiLegalApprovals`, export stamp), PKCS#11/HSM signer (verified on SoftHSM2), media profiles (`MEDIA_PROFILE`/`MEDIA_ENCODER`), production seed, `ops:bootstrap-org`, `ops:purge-demo-data`, go-live checklist; migrations 1150–1151 | API/worker/core tests; `npm run preflight`; GO-LIVE-CHECKLIST.md |
| Tender completion pass (2026-10-08, [TENDER-COMPLIANCE.md](TENDER-COMPLIANCE.md)): §50 `ALLOWED_NETWORKS` allow-list (403 + audit, preflight warning); §45 Kannada UI (1 735 translations, 100 % of 1 720 extracted strings, switcher, locale formats, fonts; codemod + dictionary build with CI checks); §20 repository-wide face search (embeddings for every detected face, `face_searches`, worker scan, visibility-filtered API, page; **1 lakh faces in 7.8–8.2 s**); §16 AI accuracy harness (`npm run evaluate -w @ksp/ai-worker`: P/R/FPR/FNR sweeps, face-verification FAR/FRR/TAR/EER, ANPR read accuracy; `metrics.kspEvaluation`); face search under the FACE_RECOGNITION legal gate; migration 1200 | API 538 · worker 68 · ai-worker 32 · web 39 · core 5 · station client 4 (all passing, 2026-10-08); build, typecheck (+e2e), lint 0 errors, `vite build`, i18n checks green; E2E __E2E__ |
| Demo feedback fixes (2026-10-10): the sign-in MFA challenge follows the role policy (migration 1201 `users.mfa_self_enrolled`: asked when a role on *MFA mandatory for roles* applies or the user opted in; removing a role stops the prompt, re-adding it ends code-less sessions); Settings → Legal approvals shows **Not enforced** when `AI_LEGAL_GATES=off`; face search shows the face-recognition gate before upload; the Proxmox demo installer now enforces the legal gates (`--ai-legal-gates enforce|off`, `KSP_INSTALL_ARGS` for auto-deploy) and the demo loader skips refused tasks | `admin-settings.test.ts` policy test; auth + security-auth suites green; typecheck green; i18n 100 % (1 732 keys). Web production build: CI (the local bundler crashed intermittently, also on unchanged code) |
| Demo feedback fixes, round 2 (2026-10-10): internal shares to a recipient who can already open the item (jurisdiction / case / own) are refused (409 `RECIPIENT_ALREADY_HAS_ACCESS`) and existing ones are flagged *own access* — their expiry / view limit never applied; officers without `share:create` get a receive-only **Shared with me** menu entry instead of **Shares**; the Proxmox demo installs the nightly `ksp-backup.timer` (backup S3 identity, backup image, first run) so System health shows real backup runs | `shares.test.ts` refusal test; share suites green; installer / timer UNVERIFIED until run on the demo container |

Test totals (final audit branch, 2026-09-27): API 446 · worker 55 · ai-worker 19 · web 23 · station client 3 · E2E 65 — all passing; build, typecheck (+e2e), lint (0 errors, 5 warnings), web build green. `main` at `8ede45c` had 592 (API 444); the audit added 2 regression tests.

## In Progress
Nothing. UI/UX audit (A+B) merged 2026-09-27: 56 UI issues fixed (docs/UI-AUDIT-A.md, docs/UI-AUDIT-B.md), share-watermark race fixed; E2E 65/65 twice. All code-completable work is done (completion pass A/B/C merged 2026-09-27; see FINAL-AUDIT.md §10).

## Queued
Production-readiness conditions listed in [FINAL-AUDIT.md](FINAL-AUDIT.md) §8.

## Blocked / external
CCTNS/FIR/case-diary API contracts (not in spec) · CERT-In VAPT · HSM/DSC signing key · production S3 IAM separation · legal review (ANPR model licence, face-recognition DPIA, BSA s.63 template / export package) · GPU/transcoding capacity decision · custodian export-approval decision. Tracked in [KNOWN-ISSUES.md](KNOWN-ISSUES.md) (EXT-*).

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
External only (see FINAL-AUDIT.md §8): build/scan images and deploy to staging via CI; re-run E2E + DR drill on sound hardware; CERT-In VAPT; HSM/DSC signing key; legal reviews (BSA s.63 template, ANPR licence, face-recognition DPIA); CCTNS contracts; production object store (COMPLIANCE lock, per-service IAM); transcoding capacity decision; custodian export-approval decision (EXT-10).
