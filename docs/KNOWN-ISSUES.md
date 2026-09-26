# Known Issues & Limitations

| Area | Issue | Status |
|---|---|---|
| Environment | Docker socket not accessible on the development host; container builds untested | UNVERIFIED |
| Environment | System PostgreSQL (5432) credentials unavailable; project uses its own cluster on 5433 | by design for dev |
| Storage | versitygw runs single-account: per-service S3 credential isolation (AI worker → derived bucket only) cannot be demonstrated locally | UNVERIFIED |
| Signing | Dev signing key is a self-signed RSA-3072 certificate; production requires an HSM / DSC-backed key and CA-issued certificate | external dependency |
| Integrations | CCTNS/FIR/case-diary API contracts are not defined in the specification; adapters are interface + fixture only | external dependency |
| Compliance | No CERT-In empanelled VAPT has been performed | external dependency |
| Ingestion | Quarantine release re-hashes the stored object inside the HTTP request — slow for multi-GB files (make async) | open |
| Ingestion | No lifecycle rule configured on the staging bucket; orphaned/quarantined staged objects persist until reviewed | open (deployment) |
| Ingestion | Station CLI summary "Detail" column can show a stale evidence status (e.g. RECEIVED next to REGISTERED) | open (cosmetic) |
| Video | Reprocess deletes old derivatives before new ones exist (playback unavailable during reprocess) | open |
| Video | Snapshot extraction runs in the API process (rate-limited, 90 s timeout) — move to queue at scale | open |
| Video | Watermark burn-in for shared media not implemented yet (pending secure-sharing module) | open |
| Storage | versitygw ignores Object Lock on CopyObject and refuses conditional writes to tombstoned keys; code uses multipart copy and never reuses keys | mitigated |
| Integrations | Real CCTNS/FIR/case-diary/evidence-repository contracts unknown; `http-json` adapter contract `ksp-cctns-json-v0` is a best guess; push operations exist but are not scheduled | UNVERIFIED (external) |
| Integrations | mTLS client auth path never exercised | UNVERIFIED |
| API clients | argon2 verification on every Basic-auth request (no cache) — CPU cost under high integration load | open |
| API clients | IPv6 allow-list entries must be exact addresses (no IPv6 CIDR matching) | open |
| Web | Admin, cases/FIR, sharing, export, AI review, workspace UIs now exercised by the Playwright suite (Chrome only); integrations and API-client screens only axe-scanned, not driven | partly verified |
| Search | Totals use `count(*) OVER ()` — slow for very large match sets (switch to keyset + approximate totals) | open |
| Search | Radius search ignores antimeridian wrap (irrelevant for Karnataka) | accepted |
| Tests | Heavy FFmpeg/upload suites were intermittently slow/failing when several agents ran suites concurrently on one host; green on repeated sequential runs | monitor |
| Tests | Test runs leaked fixtures in /tmp (~11 GB) and 10-year-locked S3 test objects; fixed: per-run temp dir removed on teardown; test env OBJECT_LOCK_DAYS=1 | fixed |
| AI (licence) | ANPR plate detector is a YOLOv9 derivative published as MIT while upstream YOLOv9 is GPL-3.0 — legal review required before production | open (legal) |
| AI (legal) | Face recognition is biometric processing — requires legal basis / DPIA before production use | open (legal) |
| AI | Model accuracy metrics are upstream figures; no evaluation on KSP footage; plate OCR not validated on Indian plates | UNVERIFIED |
| AI | Track fragmentation for very small faces during camera pans (more duplicate detections to review) | open |
| Dev | Editing migration 0600 after a worktree applied it causes checksum errors in that worktree's private DB (rebuild the private DB) | note |
| Signing | HSM/PKCS#11, Indian DSC and CCA eSign are documented integration points only; dev key is self-signed | UNVERIFIED (external) |
| Export | Legal acceptance of the export package and the pre-filled BSA s.63 certificate template not established — aids only | UNVERIFIED (legal) |
| Export | PDF documents use standard fonts: Kannada/non-Latin text not rendered | open |
| Sharing | A locked external share cannot be unlocked; sender must revoke and re-share | open |
| Tooling | tsc occasionally crashes (exit 134/139, no TS errors) when launched via npm/npx on this host; retry passes | environment |
| Web | React 19 was hoisted at the root alongside the app's React 18 (possible duplicate React in bundles, broken component tests) — fixed: React 18 pinned at root + Vite dedupe; component render tests can now be added | fixed |
| Alerts | E-mail channel not implemented (deliveries recorded as FAILED "not implemented"); webhook tested only against a local server | open / UNVERIFIED |
| Reports | Scheduled (recurring) reports not implemented | open |
| Monitoring | AI-worker metrics/heartbeat hooks documented but not wired | open |
| Monitoring | Availability SLO probe and Prometheus alert rules defined in docs, not deployed | UNVERIFIED |
| Dev | Test runs across many agent environments filled the local S3 store (~17 GB of 10-year-locked test objects); cleared on disk 2026-09-25; test env now uses 1-day locks | fixed |
| DevOps | Container images, compose and Kubernetes never built/run (no Docker on host); validated statically + runtime layout simulated (`scripts/ci/simulate-image.sh`) | UNVERIFIED |
| DevOps | GitHub Actions workflows (ci/release) never executed; versitygw release tarball name in the CI DR step is assumed | UNVERIFIED |
| DevOps | Base image digests resolved 2026-09-25; must be refreshed monthly (no Renovate/Dependabot config yet) | open |
| DR | 2-hour restoration at production scale not demonstrated; local drill (29 MB objects, 14.5 MB DB) restores in ~4 s. CNPG failover, PITR, native replication untested | UNVERIFIED |
| DR | `s3-replicate.ts` copies get new version IDs → `--repoint` required after failover (native replication avoids it); full re-hash is O(bytes) — use `--trust-marker` inside the RTO and full fixity afterwards | by design |
| DR | Disposal is not propagated to the DR store (copies there persist until their own lock expires) — a DR disposal sweep is needed | open |
| Security | `DATA_ENCRYPTION_KEY` has no key versioning: rotating it requires re-encrypting MFA secrets (not implemented); it must be restored together with the DB | open |
| Capacity | CPU transcoding of the full HLS ladder for state-wide volume (~40 000 footage-hours/day) needs ~1 100 4-vCPU workers — capacity decision (proxy-only default / GPU / on-demand HLS) pending | open |
| npm audit | 4 moderate advisories (react-router 6.x, @vitest/mocker dev-only); 0 high/critical (`npm audit --audit-level=high --omit=dev` passes) | open |
| Dev host | Intermittent node/tsc/eslint segfaults (exit 139) under concurrent load; single-threaded `eslint .` crashes reliably → lint uses `--concurrency=auto` | environment |
| Storage | Staging-bucket lifecycle (abort incomplete multipart uploads) is applied by `ensure-buckets.mjs` where supported; versitygw returns NotImplemented | open (deployment) |
| Security | SEC-08: npm advisories — react-router 6.x (moderate), vitest/@vitest/mocker (dev only); 0 high/critical | open |
| Security | SEC-09: `system:monitor` holders can trigger reprocess for any evidence id and learn whether it exists outside their jurisdiction | open (decide) |
| Security | Not yet tested: full data-driven IDOR matrix across all `:id` routes, mass-assignment/`.strict()`, approval race conditions, JWT alg-confusion tests, login timing, rate limits in production config, media-token tampering/path-traversal/Range tests, upload chunk abuse, CRLF/filename header injection, zip-slip/zip-bomb on `/exports/verify`, PDF/log injection, production HSTS/Secure cookies, browser XSS, containers (Trivy) | UNVERIFIED |
| Security | Residual: FFmpeg demuxer/decoder memory-safety bugs; media tokens are bearer secrets for their TTL; DB superuser can bypass triggers (detected by hash chain, not prevented); Object Lock GOVERNANCE is bypassable by privileged credentials (use COMPLIANCE in production); keys not in HSM | accepted / external |
| DR | Replicated copies have different S3 version ids → `s3-replicate.ts --repoint` needed after failover; native store replication is the primary DR path | by design |
| DR | Disposed evidence persists in the DR store until its own lock expires (no DR disposal sweep yet) | open |
| Capacity | CPU transcoding of the full HLS ladder at state-wide volume needs ~1,100 worker instances — hardware/GPU transcoding decision required (see INFRASTRUCTURE.md) | open (decision) |
| Environment | Dev host shows intermittent node/tsc/eslint segfaults and one in-memory data corruption → possible RAM/hardware fault; run memtest; re-verify results on another machine | open |
| E2E | Suite runs in Chrome only; Firefox/Safari/Edge, screen readers, zoom/forced-colours untested (see ACCESSIBILITY.md) | UNVERIFIED |
| E2E | API runs with NODE_ENV=test semantics during E2E (relaxed rate limits only); production rate limits are not exercised in the browser | by design |
| Accessibility | Region annotations are pointer-only (no keyboard alternative); remaining items listed in ACCESSIBILITY.md | open |
| Roles | Default role matrix: EVIDENCE_CUSTODIAN has no `export:approve` (only SUPERVISOR); the E2E brief expected the custodian to approve exports — product decision needed | open (decide) |
| Auth | TOTP codes are not replay-protected within their validity window (same code can complete two logins) | open (security) |
| Auth | During a lockout, the 423 "locked" message is only returned when the password is correct (wrong passwords still get the generic 401) — an attacker can confirm a password while the account is locked | open (security) |
| Dev host | During E2E work PostgreSQL parallel workers, Vite/esbuild/rollup and Node repeatedly segfaulted (14+ PG crashes in 30 min; corrupted Vite pre-bundles) under load average 10–30; a host reboot fixed it temporarily. The app now survives DB connection drops (pool/client error listeners) but in-flight requests fail | environment |
