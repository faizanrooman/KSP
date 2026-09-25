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
