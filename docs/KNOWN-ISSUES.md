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
| EXT-10 | Should EVIDENCE_CUSTODIAN hold `export:approve`? Default matrix gives it only to SUPERVISOR (unchanged) | MEDIUM | decision | Product owner. Mechanism ready: grant `export:approve` to EVIDENCE_CUSTODIAN in Roles admin (no separate setting — ADMIN-GUIDE.md § Export approval policy); tested incl. SoD (`exports.test.ts`) |

## Deployment, DR & operations

| ID | Issue | Sev | Status | Owner / next step |
|---|---|---|---|---|
| OPS-1 | Container images, compose and Kubernetes never built or run (no Docker on the dev host); validated statically (`scripts/ci/validate-deploy.sh`) + runtime layout simulated (`scripts/ci/simulate-image.sh`) | HIGH | UNVERIFIED | DevOps: build images + deploy to staging |
| OPS-2 | GitHub Actions `ci.yml` / `release.yml` never executed (incl. the new `e2e` Playwright job); versitygw release tarball name in the CI DR step assumed | MEDIUM | UNVERIFIED | DevOps: first CI run |
| OPS-3 | 2-hour restoration and 99.5 % availability not demonstrated at production scale; local drill only (small data); CNPG failover, PITR, native replication untested | HIGH | UNVERIFIED | DevOps: staging DR drill at realistic volume |
| OPS-4 | `s3-replicate.ts` copies get new version IDs → `--repoint` needed after failover (native replication avoids it); full re-hash is O(bytes) — use `--trust-marker` within the RTO | LOW | accepted | by design |
| OPS-5 | **Fixed**: DR copies made by `s3-replicate.ts` are recorded (`dr_object_copies`) and deleted by the `dr.dispose-sweep` cron / CLI once the evidence is DISPOSED (governance bypass, failures recorded + audited + retried). Native store replication of deletes and COMPLIANCE-mode DR buckets (cannot delete before retain-until) UNVERIFIED | LOW | fixed / UNVERIFIED | DevOps: give the worker a delete-capable DR identity |
| OPS-6 | Staging bucket lifecycle (abort incomplete multipart, orphaned/quarantined objects) not applied on versitygw (NotImplemented); `ensure-buckets.mjs` applies it where supported | LOW | open | Infra: verify on production store |
| OPS-7 | Base image digests resolved 2026-09-25; must be refreshed monthly (no Renovate/Dependabot yet) | LOW | open | DevOps |
| OPS-8 | Backup manifests were not signed; `restore.sh` placed manifest `headSeq` into SQL unquoted | LOW | fixed | Ed25519 detached `manifest.json.sig` (`BACKUP_SIGNING_KEY_FILE`), verified before any manifest field is used when `BACKUP_SIGNING_PUBKEY_FILE` is set (k8s verify job sets it; `BACKUP_REQUIRE_SIGNATURE=1` option); `headSeq` validated as integer + psql variable. `verify-backup.test.sh` 14/14 incl. forged-signature cases |
| OPS-9 | Trivy k8s notes: `ksp-ai-config` carried inert key-shaped placeholders; container UIDs/GIDs ≤ 10000 | LOW | fixed | placeholders removed from `ksp-ai-config` + compose (`KSP_SERVICE=ksp-ai-worker` makes the shared config loader not require JWT/signing/media/data-encryption secrets; inert per-process values instead); non-root UID/GID 10001 (api/worker/ai-worker/migrate/models), 10002 (backup), 10101 (web) in Dockerfile, k8s securityContext and compose tmpfs. `validate-deploy.sh` passes (hadolint, shellcheck, kustomize+kubeconform, actionlint, compose; promtool skipped). Images still not built (OPS-1) — Trivy not re-run |
| OPS-10 | `DATA_ENCRYPTION_KEY` had no key versioning / re-encryption | MEDIUM | fixed | `DATA_ENCRYPTION_KEYS` keyring (`id:base64,…`, first = current; `DATA_ENCRYPTION_KEY` still works as id `default`); ciphertext `v2.<keyId>.…` with the id as GCM AAD, legacy `v1` still decrypts; `npm run keys:rotate-data -w @ksp/core` re-encrypts MFA secrets + pending secrets in batches, idempotent, `KEY_ROTATED` audit (OPERATIONS.md). Keys must still be restored with the DB. Tests `security-crypto.test.ts` |

## Security (residual / hardening)

| ID | Issue | Sev | Status | Owner / next step |
|---|---|---|---|---|
| SEC-R1 | `audit_canonical()` (migration 0002) did not include `user_agent` | MEDIUM | fixed | Migration 1000: `audit_events.hash_version` (existing rows = 1, history not rewritten), `audit_canonical_v2()` covers every column incl. `user_agent`; `audit_append()` writes v2; `audit_verify()` + `audit_row_hash()` verify each row with its own version and reject a v2→v1 downgrade; custody/ledger + audit-viewer verifiers use `audit_row_hash()`. Pre-1000 rows remain without `user_agent` coverage. Test `audit-hash-v2.test.ts` |
| SEC-R2 | Residual: FFmpeg demuxer/decoder memory-safety; media tokens are bearer secrets for their TTL (not re-checked against permission changes); DB superuser can bypass triggers (detected by the hash chain, not prevented); keys not in HSM | MEDIUM | accepted | Security officer |
| SEC-R3 | Not yet tested: browser XSS fuzzing, container images, FFmpeg fuzzing, distributed share-portal brute force, real-cluster NetworkPolicies | MEDIUM | UNVERIFIED | VAPT scope |
| SEC-R4 | Rate limits used an in-memory store (per API replica) | LOW | fixed | PostgreSQL store (`apps/api/src/lib/rate-limit-store.ts`, UNLOGGED table `rate_limit_counters`, migration 1001; atomic UPSERT per request, cleanup every 60 s, fails open if the DB is unreachable); `RATE_LIMIT_STORE=memory\|postgres` (default postgres in production, memory elsewhere). Test `rate-limit-store.test.ts` (two instances share counts) |
| SEC-R5 | `/auth/mfa/disable` checked the TOTP code without the single-use step | LOW | fixed | disable now consumes the TOTP step exactly like login (shared `consumeTotp`), failures audited (`MFA_CHALLENGE_FAILED`, context mfa-disable), rate-limited. Test `security-auth.test.ts` |
| SEC-R6 | `/auth/mfa/setup` replaced an existing MFA secret without re-authentication | LOW | fixed | when MFA is enabled, setup requires the current password + a current TOTP code (step consumed) or a recovery code (consumed); `MFA_REENROLL_STARTED` / `MFA_CHALLENGE_FAILED` audited; old factor stays active until `/mfa/confirm`. API-only (the web UI offers no re-enrolment). Test `security-auth.test.ts` |
| SEC-R7 | Public `/health/ready` echoed backend error text | LOW | fixed | public probe returns only `ok`/`fail` per check; error detail is logged (warn) and available at authenticated `GET /system/health` (`system:monitor`). Test `security-residual.test.ts` |
| SEC-R8 | API-client Basic auth skipped argon2 for an unknown `client_id` | LOW | fixed | unknown/expired ids verify against the dummy argon2 hash (uniform timing); positive verifications cached ≤ 60 s keyed by sha256(client_id:secret), honoured only while the row's current `secret_hash` matches (row + `revoked_at`/expiry/IP re-checked every request; rotate/revoke also evict). Test `security-residual.test.ts` |
| SEC-R9 | Search `ai.reviewStatus=ANY_NON_REJECTED` needed only `search:use` | LOW | fixed | now also requires `ai:review` or `ai:request` (403 + `ACCESS_DENIED` audit otherwise). Test `security-residual.test.ts` |
| SEC-R10 | `ksp_ai` could set any `ai_jobs.status` | LOW | fixed | trigger `ai_jobs_status_guard` (migration 1002): for ksp_ai only QUEUED→RUNNING→COMPLETED/FAILED/CANCELLED; no revival/re-queue (42501). Test `security-residual.test.ts` |
| SEC-R11 | Snapshot with `source: original` needs only `evidence:snapshot`, not `evidence:download_original` (output is a custody-audited still image) | LOW | accepted | kept by decision; documented in AUTHORIZATION.md, pinned by `security-residual.test.ts` + `media.test.ts` |
| SEC-R12 | Dashboard `orgUnitId` filter did not check the unit is inside the viewer's jurisdiction | LOW | fixed | a unit outside the viewer's `dashboard:view` grant subtrees answers 404 exactly like a non-existent unit. Test `dashboard.test.ts` |
| SEC-R13 | Locked accounts answer 423 for any password — reveals that a username exists and is locked | LOW | accepted | trade-off |

## Functional gaps

| ID | Area | Issue | Sev | Status |
|---|---|---|---|---|
| FN-1 | Alerts | **Fixed**: SMTP e-mail channel (nodemailer; manager/rule/severity recipients) and retried external deliveries (`alerts.deliver`, exponential backoff, every attempt in `alert_deliveries`), tested against a local SMTP sink and HTTP server. Delivery through a real SMTP relay / real webhook receiver remains UNVERIFIED | LOW | fixed / UNVERIFIED |
| FN-2 | Reports | **Fixed**: scheduled reports (`report_schedules`, cron `reports.schedule`, owner jurisdiction frozen at run time, recipients notified in-app + e-mail link); e-mail via a real relay UNVERIFIED | LOW | fixed |
| FN-3 | Monitoring | **Fixed**: AI worker service heartbeat (ksp_ai, 30 s) + Prometheus metrics on :METRICS_PORT+2 (jobs, frames, per-model inference, claim latency); health page shows AI workers; Prometheus alert rules authored. Rules/probe not deployed (no Prometheus on the dev host) | LOW | fixed / rules UNVERIFIED |
| FN-4 | Ingestion | **Fixed**: quarantine release runs in the worker (`ingest.release`, 202 + status polling; release audit still in the registration transaction, actor = releasing user) | LOW | fixed |
| FN-5 | Ingestion | **Fixed**: container creation_time wins; declared value kept in `declared_recorded_at`; discrepancies > 5 min flagged (audit detail + UI badge). Camera clocks themselves may be wrong — the flag is for the investigator to judge | LOW | fixed |
| FN-6 | Integrity | **Fixed**: nightly fixity batch sized by `integrityPolicy.fullCycleDays` (+ byte budget, min/max), prioritising never-verified, recently tier-migrated and oldest-verified copies; RETAINED and recorded DR copies are verified with their own `integrity_checks` rows; coverage % and projected cycle on System health. Throughput at state-wide volume (≈ 2 TiB/night default budget) not measured | LOW | fixed |
| FN-7 | Video | **Fixed**: rebuilds go to a new generation prefix, rows switch atomically, old objects deleted afterwards (failed rebuild keeps the old set playable); reprocess returns 409 while a job is queued/running. An AI job reading the old proxy during the switch fails and must be re-run | LOW | fixed |
| FN-8 | Video | **Fixed**: snapshot extraction is a worker job (`media.snapshot`); the API waits ≤ 20 s (201) or returns 202 + status polling; UI unchanged for the fast path | LOW | fixed |
| FN-10 | Sharing | **Fixed**: unlock (sender / share:manage_all, attempts reset, audited), extend within policy, link e-mail (code out-of-band by default; opt-in separate code e-mail, trade-off documented), link re-issue, variants deleted on revoke/expire/lock. SMS delivery not implemented; real SMTP relay UNVERIFIED | LOW | fixed |
| FN-11 | Sharing | **Fixed**: `maxViews` applies to internal shares (share-based detail/playback opens, one per 30-min session; used-up shares stop granting visibility) | LOW | fixed |
| FN-12 | Investigation | **Fixed**: manual timeline events are soft-deleted (`deleted_at`/`deleted_by`; DELETE revoked from `ksp_app`) like annotations | LOW | fixed |
| FN-13 | Search | Relevance ranking of very broad text queries is O(matches) (~75 ms for 10 000 matches on the dev host); totals capped at 10 000 and facets bounded (see appendix) | LOW | open |
| FN-14 | Search | Radius search ignores antimeridian wrap (irrelevant for Karnataka) | LOW | accepted |
| FN-15 | API clients | argon2 on every Basic-auth request — fixed: ≤ 60 s positive-verification cache (SEC-R8). Open: IPv6 allow-list entries must be exact addresses | LOW | open |
| FN-16 | AI | Accuracy figures are upstream; no evaluation on KSP footage; plate OCR not validated on Indian plates; GPU inference untested; small-face track fragmentation during pans | MEDIUM | UNVERIFIED |
| FN-17 | Accessibility | E2E/axe in Chrome only (Firefox/Safari/Edge, screen readers, zoom/forced colours untested) — ACCESSIBILITY.md. (Keyboard region editor done, see appendix) | MEDIUM | UNVERIFIED |
| FN-19 | Performance | Single-host measurements only (PERFORMANCE.md); login ≈ 80/s per API process (argon2); audit append ≤ 1.2k/s. (Custody view paging done, see appendix) | MEDIUM | open |
| FN-20 | Storage | Uploads > 5 GiB, AWS S3 / MinIO / Ceph behaviour, Safari native HLS, real 1080p30 long-footage throughput untested | MEDIUM | UNVERIFIED |
| FN-21 | Storage | versitygw ignores Object Lock on CopyObject and refuses conditional writes to tombstoned keys — code uses multipart copy and never reuses keys | LOW | mitigated |
| FN-22 | Station CLI | **Fixed**: the summary is refreshed from the server before printing (also with `--no-wait`) and outcome updates always replace the detail; already-uploaded files are marked | LOW | fixed |
| FN-23 | E2E | API runs with `NODE_ENV=test` semantics during E2E (relaxed rate limits) | LOW | by design |

## Development host (ENV)

| ID | Issue | Status |
|---|---|---|
| ENV-1 | Host shows hardware-level instability: node/tsc/eslint/PostgreSQL/Vite segfaults under load, non-reproducible hash mismatches, one audit row altered after write (detected by `audit_verify` in the perf DB). Do not use it for production-like data; run memtest; re-verify results on another machine | open |
| ENV-2 | Docker socket not accessible; system PostgreSQL (5432) unavailable → project cluster on 5433 | by design for dev |
| ENV-3 | Heavy FFmpeg/upload suites slow/flaky when several agents run concurrently; green on sequential runs. Single-threaded `eslint .` crashes → lint uses `--concurrency` | monitor |
| ENV-4 | Editing an applied migration causes checksum errors in a worktree's private DB (rebuild it) | note |
| ENV-5 | Validators are not preinstalled on the host: `scripts/ci/install-tools.sh` installs pinned, SHA-256-verified hadolint/shellcheck/kustomize/kubeconform/actionlint/age/promtool into `.local/bin`; `validate-deploy.sh --strict` (and `CI=true`) fails on a missing validator. Docker compose cannot be validated here (`--no-docker`, reported) | note |

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
| FN-18 integrations / API-client / retention / disposal screens not driven by E2E | `tests/e2e/specs/12-admin-lifecycle.spec.ts` (fixture system + FIR import, API client secret-once + revoke, retention create/assign, two-officer disposal to DISPOSED) |
| FN-24 single 2.6 MB JS bundle (627 kB gzip) | route/tab `React.lazy` chunks + vendor chunks (react, charts, hls); first page loads 548 kB (157 kB gzip) — PERFORMANCE.md “Web bundle” |
| FN-19 custody view unpaginated (1 000 events ≈ 0.6 MB per request) | keyset pages of 200 (`after`/`before`/`filter`), whole-chain verification in SQL, “Load more”; PDF complete (batched, 20 000 cap removed); 590 → 119 KiB, 57 → 116 rps |
| FN-13 search totals via `count(*) OVER ()` | exact up to 10 000 then `totalApprox` (“10,000+”); tag/AI facets via bounded LATERAL lookups (facets 170–210 → 89–126 ms state-wide) |
| EXT-11 / SEC-08 / SEC-18 react-router 6.30 advisories (GHSA-wrjc-x8rr-h8h6, GHSA-337j-9hxr-rhxg) | upgraded to `react-router` 7.18.4 (declarative mode; imports moved from `react-router-dom`); `npm audit --omit=dev`: 0 vulnerabilities |
| FN-25 intermittent `ai.test.ts` job with 3 frames instead of ≥ 5 | root cause: the AI test-media cache (`.local/ai-test-media`, next to the shared model dir) is shared by every checkout on the host, and `slideshow()` reused any existing clip and built through a fixed temp name — two concurrent runs could rename a half-written clip into place (reproduced: a reader got a truncated / moov-less file). Fix: per-process temp file + atomic rename, cached clip reused only when its probed duration matches, 6 s fallback clip; the test now asserts `sourceDurationMs` ≥ 5.75 s and `framesProcessed ≥ framesTotal − 1` (FFmpeg `fps` rounding of the last frame). 10/10 consecutive runs green |
| OPS-2 (part) CI did not run the Playwright suite | `e2e` job in `ci.yml` (services, stack.sh, Chrome, artifacts on failure); actionlint clean |
| ENV-5 (part) missing validators printed SKIP and still passed | `scripts/ci/install-tools.sh` (pinned + checksum-verified) and strict mode in `validate-deploy.sh`; local strict run: all validators OK (compose skipped with `--no-docker`) |

**Orchestrator, 2026-09-27 (post-completion verification):** fixed a Tabs keyboard-navigation bug (arrow keys computed the next tab from a not-yet-committed selection, pinning rapid presses on one tab after the react-router 7 upgrade) with a component regression test; bounded the E2E runtime guard's teardown waits (a never-completing response hung teardown); keyboard-region spec now steers by the focused tab. E2E 52/52 twice.
