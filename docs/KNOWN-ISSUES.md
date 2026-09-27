# Known Issues & Limitations

_Consolidated by the final audit, 2026-09-27. Duplicates merged; fixed items moved to the appendix._

Severity: **HIGH** blocks production · **MEDIUM** fix or accept explicitly before production · **LOW** hardening /
cosmetic · **ENV** development-host only.
Status: `open` · `UNVERIFIED` (not run anywhere yet) · `decision` (product/legal owner must decide) · `accepted`.
Owner is a role, not a person.

## Compliance, legal & external dependencies

| ID | Issue | Sev | Status | Owner / next step |
|---|---|---|---|---|
| EXT-1 | No CERT-In empanelled VAPT performed (two internal assessment rounds only, see SECURITY-TEST-REPORT.md) | HIGH | open | Security officer: commission VAPT on staging |
| EXT-2 | CCTNS / FIR / case-diary / evidence-repository API contracts not in the specification; `http-json` adapter contract `ksp-cctns-json-v0` is a guess; push operations implemented but not scheduled; mTLS client path never exercised | HIGH | UNVERIFIED | Integration owner: obtain contracts + test endpoint |
| EXT-3 | Signing uses a self-signed dev RSA-3072 key; production needs HSM/PKCS#11 or DSC/CCA eSign-backed key and CA-issued certificate | HIGH | open | Security officer: procure HSM/DSC; wire `packages/core` signer |
| EXT-4 | ANPR plate detector is a YOLOv9 derivative published as MIT while upstream YOLOv9 is GPL-3.0 | HIGH | decision | Legal: licence review before production use of ANPR |
| EXT-5 | Face recognition is biometric processing — legal basis / DPIA required | HIGH | decision | Legal / DPO: DPIA; until then keep FACE_RECOGNITION disabled |
| EXT-6 | Legal acceptance of the court export package and the pre-filled BSA s.63 certificate template not established (aids only) | HIGH | decision | Legal / prosecution: review template and package format |
| EXT-7 | Production S3 IAM separation (AI worker → derived bucket only; app/backup/replicate identities) cannot be shown on versitygw (single account); policies in `deploy/s3/policies/` | HIGH | UNVERIFIED | Infra: apply on the production store, run negative tests |
| EXT-8 | Object Lock runs in GOVERNANCE mode in dev (bypassable by privileged credentials); production should use COMPLIANCE | MEDIUM | decision | Custodian + infra: choose mode/retention per bucket |
| EXT-9 | CPU transcoding of the full HLS ladder at state-wide volume (~40 000 footage-hours/day) needs ~1 100 4-vCPU workers — GPU / proxy-only default / on-demand HLS decision | HIGH | decision | Infra / product: capacity decision (INFRASTRUCTURE.md) |
| EXT-10 | Should EVIDENCE_CUSTODIAN hold `export:approve`? Default matrix gives it only to SUPERVISOR | MEDIUM | decision | Product owner |
| EXT-11 | react-router 6.30.x advisories (`npm audit --omit=dev`: 2 moderate — GHSA-wrjc-x8rr-h8h6 open redirect via backslash in `<Link>`/`useNavigate`, GHSA-337j-9hxr-rhxg SSR hydration, SSR not used) fixed only in 7.18 (major upgrade); 0 high/critical | MEDIUM | open | Web: plan react-router 7 upgrade |

## Deployment, DR & operations

| ID | Issue | Sev | Status | Owner / next step |
|---|---|---|---|---|
| OPS-1 | Container images, compose and Kubernetes never built or run (no Docker on the dev host); validated statically (`scripts/ci/validate-deploy.sh`) + runtime layout simulated (`scripts/ci/simulate-image.sh`) | HIGH | UNVERIFIED | DevOps: build images + deploy to staging |
| OPS-2 | GitHub Actions `ci.yml` / `release.yml` never executed; versitygw release tarball name in the CI DR step assumed; CI does not run the Playwright suite | MEDIUM | UNVERIFIED | DevOps: first CI run; add E2E job |
| OPS-3 | 2-hour restoration and 99.5 % availability not demonstrated at production scale; local drill only (small data); CNPG failover, PITR, native replication untested | HIGH | UNVERIFIED | DevOps: staging DR drill at realistic volume |
| OPS-4 | `s3-replicate.ts` copies get new version IDs → `--repoint` needed after failover (native replication avoids it); full re-hash is O(bytes) — use `--trust-marker` within the RTO | LOW | accepted | by design |
| OPS-5 | Disposal is not propagated to the DR store (copies persist until their own lock expires) — DR disposal sweep needed | MEDIUM | open | DevOps / custodian |
| OPS-6 | Staging bucket lifecycle (abort incomplete multipart, orphaned/quarantined objects) not applied on versitygw (NotImplemented); `ensure-buckets.mjs` applies it where supported | LOW | open | Infra: verify on production store |
| OPS-7 | Base image digests resolved 2026-09-25; must be refreshed monthly (no Renovate/Dependabot yet) | LOW | open | DevOps |
| OPS-8 | Backup manifests are not signed (dump hashes live inside the manifest); `restore.sh` places manifest `headSeq` into SQL unquoted | LOW | open | DevOps: sign manifest with the backup key |
| OPS-9 | Trivy k8s notes: `ksp-ai-config` carries inert key-shaped placeholders; container UIDs/GIDs ≤ 10000 | LOW | open | DevOps |
| OPS-10 | `DATA_ENCRYPTION_KEY` has no key versioning; rotation needs re-encryption of MFA secrets (not implemented); must be restored with the DB | MEDIUM | open | Backend |

## Security (residual / hardening)

| ID | Issue | Sev | Status | Owner / next step |
|---|---|---|---|---|
| SEC-R1 | `audit_canonical()` (migration 0002) does not include `user_agent`, so a DB superuser could alter that column without breaking the hash chain (all other columns are covered; the app role cannot UPDATE at all) | MEDIUM | open | Backend: new migration with a versioned canonical form (old rows keep v1) |
| SEC-R2 | Residual: FFmpeg demuxer/decoder memory-safety; media tokens are bearer secrets for their TTL (not re-checked against permission changes); DB superuser can bypass triggers (detected by the hash chain, not prevented); keys not in HSM | MEDIUM | accepted | Security officer |
| SEC-R3 | Not yet tested: browser XSS fuzzing, container images, FFmpeg fuzzing, distributed share-portal brute force, real-cluster NetworkPolicies | MEDIUM | UNVERIFIED | VAPT scope |
| SEC-R4 | Rate limits use an in-memory store → per API replica | LOW | open | Backend: shared store if needed |
| SEC-R5 | `/auth/mfa/disable` checks the TOTP code without the single-use step (password also required) | LOW | open | Backend |
| SEC-R6 | `/auth/mfa/setup` replaces an existing MFA secret without re-authentication (live session required) | LOW | open | Backend |
| SEC-R7 | Public `/health/ready` echoes backend error text (≤ 200 chars) | LOW | open | Backend: generic message, detail in logs |
| SEC-R8 | API-client Basic auth skips argon2 for an unknown `client_id` (timing enumeration of client ids) | LOW | open | Backend: dummy hash as in login |
| SEC-R9 | Search `ai.reviewStatus=ANY_NON_REJECTED` needs only `search:use` (every default role with `search:use` also holds `ai:request`; only custom roles are affected) | LOW | open | Backend: require an AI permission |
| SEC-R10 | `ksp_ai` may set any `ai_jobs.status` (no transition guard) — a compromised AI worker could revive a cancelled job | LOW | open | Backend: transition trigger |
| SEC-R11 | Snapshot with `source: original` needs only `evidence:snapshot`, not `evidence:download_original` (output is a custody-audited still image) | LOW | decision | Product: confirm intended |
| SEC-R12 | Dashboard `orgUnitId` filter does not check the unit is inside the viewer's jurisdiction (data stays scoped; unit existence leaks) | LOW | open | Backend |
| SEC-R13 | Locked accounts answer 423 for any password — reveals that a username exists and is locked | LOW | accepted | trade-off |

## Functional gaps

| ID | Area | Issue | Sev | Status |
|---|---|---|---|---|
| FN-1 | Alerts | E-mail channel not implemented (deliveries recorded FAILED "not implemented"); webhook tested only against a local server; failed external deliveries are not retried | MEDIUM | open |
| FN-2 | Reports | Scheduled (recurring) reports not implemented | LOW | open |
| FN-3 | Monitoring | AI worker has no service metrics/heartbeat (only per-job heartbeat); availability SLO probe and Prometheus alert rules authored, not deployed | MEDIUM | open / UNVERIFIED |
| FN-4 | Ingestion | Quarantine release re-hashes the object inside the HTTP request (slow for multi-GB files) | LOW | open |
| FN-5 | Ingestion | Client-declared `recordedAt` overrides container creation time | LOW | open |
| FN-6 | Integrity | Nightly fixity sweep samples 100 items/night (≈36k/year) — too small for state-wide volume; secondary copies not fixity-checked | MEDIUM | open |
| FN-7 | Video | Reprocess deletes old derivatives before new ones exist; reprocess enqueues even when already processing | LOW | open |
| FN-8 | Video | Snapshot extraction runs in the API process (rate-limited, 90 s timeout) — move to queue at scale | LOW | open |
| FN-10 | Sharing | Locked external share cannot be unlocked or extended; no e-mail/SMS delivery of link/code; revoke does not delete per-share watermarked variants | LOW | open |
| FN-11 | Sharing | `maxViews` counts portal opens and is not applied to internal-user shares | LOW | open |
| FN-12 | Investigation | Manual timeline events are hard-deleted (audit row remains), unlike annotations | LOW | open |
| FN-13 | Search | Totals use `count(*) OVER ()`; ranking over large match sets ~0.2–0.35 s state-wide | LOW | open |
| FN-14 | Search | Radius search ignores antimeridian wrap (irrelevant for Karnataka) | LOW | accepted |
| FN-15 | API clients | argon2 on every Basic-auth request (no cache); IPv6 allow-list entries must be exact addresses | LOW | open |
| FN-16 | AI | Accuracy figures are upstream; no evaluation on KSP footage; plate OCR not validated on Indian plates; GPU inference untested; small-face track fragmentation during pans | MEDIUM | UNVERIFIED |
| FN-17 | Accessibility | E2E/axe in Chrome only (Firefox/Safari/Edge, screen readers, zoom/forced colours untested) — ACCESSIBILITY.md. (Keyboard region editor done, see appendix) | MEDIUM | UNVERIFIED |
| FN-18 | Web | Integrations, API-client, retention and disposal screens axe-scanned only, not driven by E2E | LOW | open |
| FN-19 | Performance | Single-host measurements only (PERFORMANCE.md); custody view unpaginated (1 000 events ≈ 0.6 MB); login ≈ 80/s per API process (argon2); audit append ≤ 1.2k/s | MEDIUM | open |
| FN-20 | Storage | Uploads > 5 GiB, AWS S3 / MinIO / Ceph behaviour, Safari native HLS, real 1080p30 long-footage throughput untested | MEDIUM | UNVERIFIED |
| FN-21 | Storage | versitygw ignores Object Lock on CopyObject and refuses conditional writes to tombstoned keys — code uses multipart copy and never reuses keys | LOW | mitigated |
| FN-22 | Station CLI | Summary "Detail" column can show a stale status | LOW | open (cosmetic) |
| FN-23 | E2E | API runs with `NODE_ENV=test` semantics during E2E (relaxed rate limits) | LOW | by design |
| FN-25 | Tests | Intermittent: `apps/api/test/ai.test.ts` end-to-end AI job once processed 3 frames instead of ≥ 5 (fresh-clone run, final audit); passed on 3 re-runs. Investigate frame sampling under load before blaming the host | LOW | monitor |
| FN-24 | Web | Production bundle is a single 2.6 MB JS chunk (627 kB gzip) — no route-level code splitting | LOW | open |

## Development host (ENV)

| ID | Issue | Status |
|---|---|---|
| ENV-1 | Host shows hardware-level instability: node/tsc/eslint/PostgreSQL/Vite segfaults under load, non-reproducible hash mismatches, one audit row altered after write (detected by `audit_verify` in the perf DB). Do not use it for production-like data; run memtest; re-verify results on another machine | open |
| ENV-2 | Docker socket not accessible; system PostgreSQL (5432) unavailable → project cluster on 5433 | by design for dev |
| ENV-3 | Heavy FFmpeg/upload suites slow/flaky when several agents run concurrently; green on sequential runs. Single-threaded `eslint .` crashes → lint uses `--concurrency` | monitor |
| ENV-4 | Editing an applied migration causes checksum errors in a worktree's private DB (rebuild it) | note |
| ENV-5 | Tools used by `validate-deploy.sh` / backup tests (hadolint, shellcheck, kustomize, kubeconform, actionlint, age, promtool) are not installed on the host; a missing validator prints SKIP and the script still passes. The final audit downloaded them into a scratch dir (promtool still skipped) | note |

## Appendix — resolved

| Issue | Resolution |
|---|---|
| Test fixtures leaked in /tmp (~11 GB) and 10-year-locked S3 test objects filled the local store (~17 GB) | per-run temp dir removed; test env `OBJECT_LOCK_DAYS=1`; store cleared 2026-09-25 |
| React 19 hoisted next to the app's React 18 | React 18 pinned at root + Vite dedupe |
| Watermark burn-in for shared media not implemented | implemented (`share.watermark` queue, per-share variants) |
| SEC-09 reprocess not scoped; SEC-10..SEC-16 (IDOR, mass assignment, races, JWT, rate limits, media tokens, uploads, zip, injection, headers) | fixed in security round 2 |
| TOTP codes replayable within their window | SEC-12, migration 0991 (single-use step, atomic recovery-code consumption) |
| Lockout 423 only for the correct password (password oracle) | 423 for any password while locked |
| E2E TOTP helper reused codes within a step | strictly increasing steps per secret |
| **Final audit:** share `maxViews` could be exceeded by concurrent opens | atomic conditional increment + concurrency test (`share-portal.test.ts`) |
| **Final audit:** after a lockout expired, one wrong password re-locked the account (failure count never reset) | expired lock restarts the count (login + MFA) + test (`auth.test.ts`) |
| **Final audit:** `restore.sh` interpolated DB role passwords into SQL text | `roles.sql` uses psql `:'var'` quoting; all callers pass raw values |
| **Final audit:** `npm run db:migrate` / `db:codegen` failed on a fresh clone before `npm run build` | scripts run from source (`--conditions=ksp-src`) |
| FN-9 PDFs used standard fonts (Kannada / non-Latin not rendered) | bundled Noto Sans + Noto Sans Kannada (OFL, SHA-256 pinned), HarfBuzz shaping, /ActualText; tests compare glyph runs with HarfBuzz, pdftotext round-trip and a 300 dpi raster (CHAIN-OF-CUSTODY.md). Other non-Latin scripts still print `?` |
| FN-17 region annotations were pointer-only | keyboard region editor in AnnotationStudio (focusable frame: arrows move, Shift+arrows resize, Enter sets, Escape; X/Y/W/H % inputs; polite announcements); `91-keyboard` E2E + axe on the editor; unit tests for the geometry |
