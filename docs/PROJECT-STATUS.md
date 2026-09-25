# Project Status

_Last updated: 2026-09-25 (orchestrator)._

## Overall
REAL IMPLEMENTATION STATUS: **IN PROGRESS — core evidence path implemented and verified end-to-end on the development host; many modules still in progress; not production-ready.**

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
| End-to-end integration (orchestrator): station CLI upload → REGISTERED → media READY → HLS playable via token; other-jurisdiction IO gets 404; audit chain intact | manual run 2026-09-25 |

Test totals on `main` at last merge: API 69 · worker 22 · web 3 · station client 3 — all passing; root typecheck and web build green.

## In Progress
Identity & administration · AI analysis & human review · Cases/FIR & integration REST API.

## Queued
Search & investigation workspace · Chain-of-custody viewer, audit viewer, court export, secure sharing · Dashboards, reports, alerts, monitoring · DevOps (containers, CI/CD, k8s), backup & DR · Security testing, E2E, performance, accessibility · Final documentation & production audit.

## Blocked / external
CCTNS/FIR/case-diary API contracts (not in spec) · CERT-In VAPT · HSM/DSC signing key · production S3 IAM separation.

## Unverified
Docker/compose/k8s (no Docker access on host) · behaviour on AWS S3/MinIO/Ceph (only versitygw tested) · uploads > 5 GiB · Safari native HLS · real 1080p30 long-footage throughput · 99.5% availability and 2-hour restoration targets (not yet tested).

## Tests
See totals above. Commands: `npm run typecheck`; `(cd apps/api && npx vitest run)`; `(cd apps/worker && npx vitest run)`; `(cd apps/web && npx vitest run && npx vite build)`; `(cd tools/station-client && npx vitest run)`.

## Security
Implemented: RBAC + jurisdiction scoping (404 for out-of-scope), least-privilege DB roles, CSRF, rate limiting, security headers/CSP, tokenised media, no storage URLs to clients, audit of every evidence touch. Not yet done: SAST/dependency/container scanning, full security test suite, threat model document.

## Deployment
Not started (queued).

## Known Issues
See `docs/KNOWN-ISSUES.md`.

## Next Actions
Merge identity/AI/cases when green → launch search+investigation, custody/export/sharing, dashboards/alerts, DevOps/DR → security/E2E/performance → final audit.
