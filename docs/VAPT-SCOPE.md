# VAPT scope (CERT-In empanelled assessment)

Gate B1 / EXT-1 in [GO-LIVE-CHECKLIST.md](GO-LIVE-CHECKLIST.md). Internal assessments so far:
[SECURITY-TEST-REPORT.md](SECURITY-TEST-REPORT.md) (two rounds + final audit). This document is the brief for the
external auditor.

## Target and environments

| Item | Detail |
|---|---|
| Application | KSP Video Evidence Management System: React SPA, REST API `/api/v1` (OpenAPI at `/api/docs`, authenticated in production), external share portal `/share/*`, integration API `/api/v1/integration/*` (API clients, Basic / mTLS) |
| Environment | **Staging only** (`KSP_ENVIRONMENT=staging`), production-configured: `NODE_ENV=production`, TLS, secure cookies, rate limits, preflight passing except the documented staging waivers |
| Infrastructure in scope | Kubernetes namespace `ksp-vms-staging` (ingress, NetworkPolicies, pods, service accounts), container images (api, worker, ai-worker, web, backup), PostgreSQL (roles `ksp_app`, `ksp_ai`, `ksp_backup`), S3 object store identities and bucket policies (`deploy/s3/policies`), backup / DR jobs |
| Out of scope | Production; the CCTNS / NCRB systems themselves; physical security; body-camera firmware and docking stations; denial-of-service at volumes that affect shared infrastructure (agree a window first) |

## Test accounts (provided on day 1 through a secure channel)

One account per role (FIELD_OFFICER, STATION_OPERATOR, INVESTIGATING_OFFICER × 2 in different stations, SUPERVISOR,
FORENSIC_ANALYST, EVIDENCE_CUSTODIAN, AUDITOR, SYSTEM_ADMINISTRATOR) created with `ops:bootstrap-org`; MFA seeds for
roles requiring MFA; one API client (Basic) and one mTLS client certificate; one external share link with access code;
read-only kubectl access to the namespace for configuration review; synthetic media only.

## Focus areas (from the internal reports' residual risks and "not covered" lists)

1. **Object-level authorization** across every resource (`:id` routes, jurisdiction subtrees, 404 vs 403), share portal
   and integration API scopes.
2. **Media pipeline**: crafted containers / codecs against FFmpeg demuxers and decoders (fuzzing corpus), upload chunk
   protocol, ZIP handling in export verification, HLS playlist rewriting, media-token (bearer, TTL 5 min) theft and
   replay, Range abuse.
3. **Browser-side**: XSS / DOM injection (filenames, titles, notes, AI labels, Kannada text), CSP effectiveness,
   clickjacking, CSRF double-submit.
4. **Authentication**: brute force incl. distributed attempts on the share portal, MFA bypass, session fixation,
   refresh-token reuse detection, lockout behaviour (known accepted: SEC-R13 locked account reveals existence).
5. **Cryptography and integrity**: export manifest / custody report signatures, audit hash chain and checkpoints,
   PKCS#11 signer configuration (HSM session handling), backup manifest signatures.
6. **Isolation**: AI worker (`ksp_ai` DB role, derived-bucket-only S3 identity), NetworkPolicies, container runtime
   (non-root, read-only root filesystem), secrets exposure in ConfigMaps / environment / logs.
7. **Integrations**: SSRF through integration base URLs (egress allow-list), mTLS client path.
8. **Configuration**: verify the production preflight cannot be bypassed without an explicit, logged waiver
   (`npm run preflight`), and that staging waivers are the documented ones only.

## Rules of engagement

* Window: agreed dates, 09:00–19:00 IST unless a night window is agreed for load tests; daily stand-up with the
  security officer.
* Source IPs of the testers are declared in advance and allow-listed where the ingress restricts access.
* No destruction of evidence: disposal / legal-hold / export approval tests only on items the testers created.
  Object Lock and the database guards will refuse deletion of originals — reporting that is in scope, bypass attempts
  must stop at proof (no data exfiltration beyond a single synthetic item).
* Credentials, tokens and data obtained are used only for the test and reported; no pivoting outside the namespace.
* Critical findings are reported immediately to the security officer (phone + e-mail), not only in the final report.
* Deliverables: report with CVSS 3.1 scores, reproduction steps, evidence; re-test of fixed HIGH/CRITICAL findings;
  a signed letter stating the re-test result.

## Contacts
Security officer: ____________ · DevOps on call: ____________ · Product owner: ____________
