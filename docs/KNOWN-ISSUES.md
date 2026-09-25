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
