# KSP Video Evidence Management System

Evidence management and AI-assisted analysis platform for Karnataka State Police body-worn camera footage:
tamper-evident ingestion and storage, playback, human-reviewed AI analysis, search, investigation workspaces,
cases/FIR linking, chain of custody, court export, secure sharing, dashboards/alerts, audit and DR.

**Status (2026-09-27):** all 20 specification modules are implemented and covered by automated tests that pass on
the development host (API, worker, AI worker, web, station client, 48 Playwright E2E tests). Container images,
Kubernetes and CI have **never been run** (no Docker on the host), and legal/external blockers remain. Verdict:
ready for a staging/UAT deployment once the images are built and verified there; **not production-ready**. See
[docs/FINAL-AUDIT.md](docs/FINAL-AUDIT.md).

## Architecture in one paragraph

A React SPA (`apps/web`) and a station upload CLI (`tools/station-client`) talk to a Fastify REST API
(`apps/api`, `/api/v1`). A pg-boss worker (`apps/worker`, FFmpeg) handles ingestion, transcoding, lifecycle,
exports, reports and alerts; an isolated AI worker (`apps/ai-worker`, ONNX Runtime, DB role `ksp_ai`, derived
bucket only) produces detections that stay pending until a human approves them. State lives in PostgreSQL 16
(schema, queues, hash-chained append-only audit ledger) and S3-compatible storage with Object Lock for originals.
Media is always streamed through the API with short-lived tokens; storage URLs never reach clients. Details:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quick start (development host, no Docker)

```bash
source scripts/dev/env.sh            # Node 22, ffmpeg, versitygw from the main checkout's .local/
scripts/dev/services.sh start        # PostgreSQL :5433, S3 (versitygw) :7480
scripts/dev/init-env.sh              # main checkout, once: secrets + .env/.env.test
# (in a git worktree instead: scripts/dev/agent-env.sh <name> <port-offset>)
npm ci
npm run db:migrate && npm run db:seed
npm run fetch-models -w @ksp/ai-worker
npm run dev:api & npm run dev:worker & npm run dev:ai & npm run dev:web
```

Dev users and the shared dev password are listed in [docs/CONTRACTS.md](docs/CONTRACTS.md) §2.

Checks: `npm run build`, `npm run typecheck`, `npm run lint`, `npm test -w @ksp/api` (likewise `@ksp/worker`,
`@ksp/ai-worker`, `@ksp/web`, `@ksp/station-client`), E2E: [docs/E2E-TESTS.md](docs/E2E-TESTS.md).

## Repository layout

`packages/shared` (contracts) · `packages/core` (platform) · `apps/api` · `apps/worker` · `apps/ai-worker` ·
`apps/web` · `tools/station-client` · `db/migrations` · `deploy/` (Docker, compose, k8s, monitoring — UNVERIFIED at
runtime) · `scripts/` (dev, backup, ops, CI) · `tests/` (e2e, dr, perf) · `docs/`.

## Documentation index

| Topic | Documents |
|---|---|
| Start here | [CONTRACTS](docs/CONTRACTS.md) (mandatory conventions) · [PROJECT-STATUS](docs/PROJECT-STATUS.md) · [FINAL-AUDIT](docs/FINAL-AUDIT.md) · [REQUIREMENTS-TRACEABILITY](docs/REQUIREMENTS-TRACEABILITY.md) · [KNOWN-ISSUES](docs/KNOWN-ISSUES.md) |
| Architecture | [ARCHITECTURE](docs/ARCHITECTURE.md) · [DECISIONS](docs/DECISIONS.md) · [INFRASTRUCTURE](docs/INFRASTRUCTURE.md) · [STORAGE](docs/STORAGE.md) · [AI-ARCHITECTURE](docs/AI-ARCHITECTURE.md) |
| Users | [USER-GUIDE](docs/USER-GUIDE.md) · [ADMIN-GUIDE](docs/ADMIN-GUIDE.md) · [UI-GUIDELINES](docs/UI-GUIDELINES.md) · [ACCESSIBILITY](docs/ACCESSIBILITY.md) |
| Modules | [AUTHENTICATION](docs/AUTHENTICATION.md) · [AUTHORIZATION](docs/AUTHORIZATION.md) · [INGESTION](docs/INGESTION.md) · [EVIDENCE-LIFECYCLE](docs/EVIDENCE-LIFECYCLE.md) · [VIDEO-PIPELINE](docs/VIDEO-PIPELINE.md) · [AI-MODEL-LIFECYCLE](docs/AI-MODEL-LIFECYCLE.md) · [SEARCH](docs/SEARCH.md) · [INVESTIGATION](docs/INVESTIGATION.md) · [CASES](docs/CASES.md) · [INTEGRATIONS](docs/INTEGRATIONS.md) · [CHAIN-OF-CUSTODY](docs/CHAIN-OF-CUSTODY.md) · [COURT-EXPORT](docs/COURT-EXPORT.md) · [SECURE-SHARING](docs/SECURE-SHARING.md) · [DASHBOARDS-REPORTS-ALERTS](docs/DASHBOARDS-REPORTS-ALERTS.md) · [AUDIT](docs/AUDIT.md) |
| Security | [SECURITY-ARCHITECTURE](docs/SECURITY-ARCHITECTURE.md) · [THREAT-MODEL](docs/THREAT-MODEL.md) · [SECURITY-TEST-REPORT](docs/SECURITY-TEST-REPORT.md) · [SECRETS](docs/SECRETS.md) |
| Operations | [DEPLOYMENT](docs/DEPLOYMENT.md) · [OPERATIONS](docs/OPERATIONS.md) · [RUNBOOK](docs/RUNBOOK.md) · [MONITORING](docs/MONITORING.md) · [BACKUP-RESTORE-RUNBOOK](docs/BACKUP-RESTORE-RUNBOOK.md) · [DISASTER-RECOVERY](docs/DISASTER-RECOVERY.md) · [TROUBLESHOOTING](docs/TROUBLESHOOTING.md) |
| Quality | [E2E-TESTS](docs/E2E-TESTS.md) · [PERFORMANCE](docs/PERFORMANCE.md) |
| Process | [AGENT-ORCHESTRATION](docs/AGENT-ORCHESTRATION.md) |
