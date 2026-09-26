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
| Web | Admin, cases/FIR, integrations and API-client UIs not yet exercised in a browser | UNVERIFIED (pending E2E) |
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
| Security | SEC-08 / SEC-18: npm + Trivy advisories — react-router 6.30.x CVE-2026-53666 / CVE-2026-53669 (MEDIUM, fix only in 7.18 = major upgrade), vitest (dev only); 0 high/critical | open |
| Security | SEC-09 fixed in round 2 (reprocess scoped to the system:monitor jurisdiction) | fixed |
| Security | Round 2 closed the IDOR/mass-assignment/race/JWT/rate-limit/media-token/upload/zip/injection/production-header gaps (SEC-10..SEC-16). Still not tested: browser XSS, container images (no Docker), FFmpeg fuzzing, mTLS/CCTNS, distributed share-portal brute force, real-cluster k8s policies | UNVERIFIED |
| Security | Trivy k8s notes: ksp-ai-config carries inert key-shaped placeholders (make those settings optional for the AI worker); container UIDs/GIDs ≤ 10000 (LOW) — DevOps workstream | open |
| Security | Residual: FFmpeg demuxer/decoder memory-safety bugs; media tokens are bearer secrets for their TTL; DB superuser can bypass triggers (detected by hash chain, not prevented); Object Lock GOVERNANCE is bypassable by privileged credentials (use COMPLIANCE in production); keys not in HSM | accepted / external |
| DR | Replicated copies have different S3 version ids → `s3-replicate.ts --repoint` needed after failover; native store replication is the primary DR path | by design |
| DR | Disposed evidence persists in the DR store until its own lock expires (no DR disposal sweep yet) | open |
| Capacity | CPU transcoding of the full HLS ladder at state-wide volume needs ~1,100 worker instances — hardware/GPU transcoding decision required (see INFRASTRUCTURE.md) | open (decision) |
| Environment | Dev host shows intermittent node/tsc/eslint segfaults and one in-memory data corruption → possible RAM/hardware fault; run memtest; re-verify results on another machine | open |
| Performance | Single-host measurements only (docs/PERFORMANCE.md). Remaining bottlenecks: full-text search count/rank over large match sets (~0.2–0.3 s per state-wide query), facets (~0.2–0.35 s), custody view returns every event unpaginated (1 000 events ≈ 0.6 MB, ~50 rps), login throughput bound by argon2 on the libuv pool (≈ 80/s per API process), finalize concurrency = WORKER_CONCURRENCY | open |
| Environment | The development host showed hardware-level memory corruption (PostgreSQL SIGSEGVs, non-reproducible hash mismatches, one audit row altered after write — detected by audit_verify at seq 1 024 318 in the perf DB). Do not use this host for production-like data; run memtest | open (host) |
