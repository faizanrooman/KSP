# Known Issues & Limitations

| Area | Issue | Status |
|---|---|---|
| Environment | Docker socket not accessible on the development host; container builds untested | UNVERIFIED |
| Environment | System PostgreSQL (5432) credentials unavailable; project uses its own cluster on 5433 | by design for dev |
| Storage | versitygw runs single-account: per-service S3 credential isolation (AI worker → derived bucket only) cannot be demonstrated locally | UNVERIFIED |
| Signing | Dev signing key is a self-signed RSA-3072 certificate; production requires an HSM / DSC-backed key and CA-issued certificate | external dependency |
| Integrations | CCTNS/FIR/case-diary API contracts are not defined in the specification; adapters are interface + fixture only | external dependency |
| Compliance | No CERT-In empanelled VAPT has been performed | external dependency |
