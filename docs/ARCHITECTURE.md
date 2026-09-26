# Architecture

System-level overview of the KSP Video Evidence Management System. Detailed per-area design lives in the
linked documents; binding conventions are in [CONTRACTS.md](CONTRACTS.md). Status markers follow the project
rule: anything not actually run is **UNVERIFIED**.

## 1. Components

```mermaid
flowchart LR
  subgraph Clients
    B[Browser SPA<br/>apps/web React 18 + Vite]
    SC[Station upload CLI<br/>tools/station-client]
    EXT[External systems<br/>CCTNS / courts / API clients]
    PUB[External share recipient<br/>/s/:token portal]
  end
  subgraph App tier
    API[API - Fastify 5<br/>apps/api /api/v1]
    W[Worker - pg-boss consumers + cron<br/>apps/worker, FFmpeg]
    AIW[AI worker - ONNX Runtime CPU<br/>apps/ai-worker, isolated]
  end
  subgraph Data tier
    PG[(PostgreSQL 16<br/>schema, pg-boss queues,<br/>hash-chained audit ledger)]
    S3[(S3 object store<br/>staging / evidence / archive / longterm<br/>= Object Lock WORM;<br/>derived / exports / reports)]
  end
  B -- HTTPS cookies + CSRF --> API
  SC -- chunked resumable upload --> API
  EXT -- Basic/mTLS API clients --> API
  PUB -- access code + token --> API
  API -- role ksp_app --> PG
  API --> S3
  W -- role ksp_app --> PG
  W --> S3
  AIW -- role ksp_ai<br/>column-level grants --> PG
  AIW -- derived bucket only --> S3
  API -. outbound, SSRF-guarded .-> EXT
```

| Component | Code | Responsibilities | Details |
|---|---|---|---|
| Shared contracts | `packages/shared` | permissions + default roles, audit action codes, queue names/payloads, settings, enums | [AUTHORIZATION.md](AUTHORIZATION.md) |
| Core platform | `packages/core` | config, Kysely DB + generated types, migration runner, storage (S3, Object Lock), pg-boss, audit writer, FFmpeg wrappers, signer, custody/PDF, ingest pipeline, seed | [CONTRACTS.md](CONTRACTS.md) |
| API | `apps/api/src/modules/*` (29 auto-mounted modules) | authentication, RBAC + jurisdiction, all REST resources, tokenised media streaming, share portal, integration API, metrics | [AUTHENTICATION.md](AUTHENTICATION.md) |
| Worker | `apps/worker/src/jobs/*` (10 job modules) | ingest finalize, media processing, lifecycle (tiering, retention, disposal, fixity), exports, reports, alerts, storage snapshots, audit checkpoints, share watermarking/expiry, AI training export | [VIDEO-PIPELINE.md](VIDEO-PIPELINE.md), [EVIDENCE-LIFECYCLE.md](EVIDENCE-LIFECYCLE.md) |
| AI worker | `apps/ai-worker` | object/person/face detection, face recognition vs watchlists, ANPR, colour, rule-based tagging; results are always PENDING human review | [AI-ARCHITECTURE.md](AI-ARCHITECTURE.md) |
| Web | `apps/web/src/modules/*` (17 modules) | role-aware SPA; evidence tabs/actions contributed by modules | [UI-GUIDELINES.md](UI-GUIDELINES.md), [USER-GUIDE.md](USER-GUIDE.md) |
| Station client | `tools/station-client` | bulk/resumable uploads from police stations | [INGESTION.md](INGESTION.md) |
| Database | `db/migrations` (18 migrations) | schema, `evidence_guard` + jurisdiction triggers, append-only audit ledger with hash chain, least-privilege roles | [AUDIT.md](AUDIT.md) |
| Deployment | `deploy/` | Dockerfile (5 targets), compose, kustomize (staging/production), monitoring, S3 IAM policies — **UNVERIFIED at runtime** | [DEPLOYMENT.md](DEPLOYMENT.md), [INFRASTRUCTURE.md](INFRASTRUCTURE.md) |

## 2. Evidence data flow

```mermaid
sequenceDiagram
  autonumber
  participant C as Browser / station CLI
  participant A as API
  participant S as S3
  participant D as PostgreSQL (+ pg-boss)
  participant W as Worker
  participant AI as AI worker
  C->>A: POST /uploads, PUT parts (SHA-256 per chunk), complete
  A->>S: multipart upload to staging bucket
  A->>D: evidence RECEIVED + custody audit, enqueue ingest.finalize
  W->>S: read staging, SHA-256/512, ffprobe + decode check
  alt problem (corrupt, duplicate, bad type)
    W->>D: QUARANTINED (reviewer releases or rejects)
  else valid
    W->>S: WORM copy to evidence bucket (Object Lock, If-None-Match), re-hash
    W->>D: REGISTERED + evidence number + audit, enqueue media.process
  end
  W->>S: proxy MP4, HLS ladder, poster, thumbnails, sprites (derived bucket)
  C->>A: play / snapshot / download (permission + jurisdiction check, custody event)
  A-->>C: bytes streamed by API (short-lived HMAC media token, never a storage URL)
  C->>A: request AI analysis
  A->>D: ai_jobs QUEUED + pg_notify
  AI->>S: read proxy from derived bucket only
  AI->>D: ai_detections PENDING
  C->>A: human review (two-person rule for face matches)
  C->>A: link to case, workspace, court export (dual approval), secure share
```

## 3. Cross-cutting controls

* **Authorization** — permission codes (`packages/shared/src/permissions.ts`) granted per role at an org unit and
  applying to its ltree subtree. Evidence queries use `evidenceVisibleSql` / `loadEvidenceFor`; out-of-scope
  resources answer 404. See [AUTHORIZATION.md](AUTHORIZATION.md).
* **Integrity** — originals are written once to Object Lock buckets; SHA-256 + SHA-512 recorded at registration;
  scheduled + on-demand fixity; DB trigger forbids changes to immutable columns and deletes. See
  [STORAGE.md](STORAGE.md), [EVIDENCE-LIFECYCLE.md](EVIDENCE-LIFECYCLE.md).
* **Audit / custody** — every evidence touch appends to `audit_events` (append-only, hash chain, signed hourly
  checkpoints); per-item custody verification and signed custody PDF. See [AUDIT.md](AUDIT.md),
  [CHAIN-OF-CUSTODY.md](CHAIN-OF-CUSTODY.md).
* **Separation of duties** — requester ≠ approver for disposals and court exports (API + DB CHECK constraints);
  conflicting permission pairs cannot be combined in one role.
* **AI isolation** — separate process and DB role with column-level grants and a guard trigger; it can read only
  the proxy derivative and cannot write review decisions.
* **Queues** — pg-boss inside PostgreSQL (no separate broker); idempotent handlers; dead-letter queues.

## 4. Deployment topology

Target topology (Kubernetes, CloudNativePG, S3 with Object Lock, DR site with replicated buckets) is described
in [INFRASTRUCTURE.md](INFRASTRUCTURE.md). Only the application processes have been run (on a single development
host, without Docker); container images, compose and Kubernetes are **UNVERIFIED**. Backup/DR:
[BACKUP-RESTORE-RUNBOOK.md](BACKUP-RESTORE-RUNBOOK.md), [DISASTER-RECOVERY.md](DISASTER-RECOVERY.md).
