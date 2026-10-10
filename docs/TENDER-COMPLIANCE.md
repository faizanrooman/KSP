# Tender compliance — KSP/2026-27/IND0597/CALL-3, Appendix 1 (Specifications, 78 points)

_Prepared 2026-10-08 against `main`. Status legend: **C** compliant and verifiable in this repository (tests / docs
cited) · **C-cfg** compliant, realised by deployment configuration documented here · **C-ops** the software provides
the mechanism; the measured value depends on KSPDC infrastructure or operations and is evidenced at UAT/operation ·
**EXT** an external deliverable (legal, audit, contract) outside the software._

Companion documents: [REQUIREMENTS-TRACEABILITY.md](REQUIREMENTS-TRACEABILITY.md) (module-level evidence),
[GO-LIVE-CHECKLIST.md](GO-LIVE-CHECKLIST.md) (gates), [KNOWN-ISSUES.md](KNOWN-ISSUES.md) (open items),
[PERFORMANCE.md](PERFORMANCE.md) (measurements), [SECURITY-TEST-REPORT.md](SECURITY-TEST-REPORT.md).

## Summary

| Status | Points |
|---|---|
| C | 1–5, 7–14, 16–30, 32, 35–42, 44–58, 60, 63–71, 78 |
| C-cfg | 6 (TLS + S3 server-side encryption), 31 (object-storage scale-out), 59 (on-premise manifests) |
| C-ops | 15 (KSP-footage accuracy figures), 33/34 (HA, scale), 72–77 (SLA values; 75 has an open state-dashboard load finding) |
| EXT | 43 (legal confirmation), 61 (CERT-In VAPT), 62 (CERT-In compliance attestation) |

Counts: C 63 · C-cfg 3 · C-ops 9 · EXT 3 — 78 points.

_Corrected 2026-10-10 after an internal code audit: references now point to existing tests, permissions and tables;
performance points state the development-laptop measurements as measured._

No point is unaddressed by the software. The items that remain are measured values that can only be produced on the
department's infrastructure (availability, SLA timings, accuracy on KSP footage) and third-party attestations.

## Point-by-point

| # | Requirement (abridged) | Status | How it is met / evidence |
|---|---|---|---|
| 1 | Secure, centralised video evidence management & AI analysis platform | C | Single platform: API, worker, isolated AI worker, web ([ARCHITECTURE.md](ARCHITECTURE.md)); 20 specification modules ([PROJECT-STATUS.md](PROJECT-STATUS.md)) |
| 2 | Bulk and individual upload from police stations via a client application | C | Resumable chunked upload API; **station client** CLI for bulk/folder ingestion (`tools/station-client`) and browser uploader with folder drop ([INGESTION.md](INGESTION.md)); 217 MiB / 1 GB uploads tested |
| 3 | Device-agnostic upload without body-camera lock-in | C | Any file from any camera; no vendor SDK; container/codec whitelist is format-based (point 30) |
| 4 | Automatic association of officer ID, device ID, date/time, GPS (EXIF), station, jurisdiction | C | `finalize` extracts creation time/GPS from container metadata (ffprobe), device → assigned officer default, station = uploading unit, jurisdiction = unit path (`org_path`) ([INGESTION.md](INGESTION.md), `ingest.test.ts`) |
| 5 | Secure ingestion of high-resolution formats without loss of evidentiary integrity | C | Original stored byte-identical in WORM storage with SHA-256 + SHA-512 registered at ingest; chunks hash-verified; derivatives are separate objects ([EVIDENCE-LIFECYCLE.md](EVIDENCE-LIFECYCLE.md)) |
| 6 | End-to-end encryption during upload, storage, processing, retrieval | C-cfg | With `NODE_ENV=production` the startup preflight (`packages/core/src/preflight.ts`) refuses to start on these TLS findings — they are preflight check codes, not environment variables: `APP_BASE_URL_HTTPS` (`APP_BASE_URL` must be https), `COOKIE_SECURE`, `CORS_HTTPS`, `DB_TLS` (database `sslmode` require/verify-ca/verify-full, unless waived by `DATABASE_TLS_WAIVED`, which is logged as a warning). `S3_TLS` is only a warning (an `http:` `S3_ENDPOINT` is accepted for a trusted cluster network), so TLS to object storage is a deployment-configuration item, not enforced by the software; object storage server-side encryption and encrypted (age) backups ([STORAGE.md](STORAGE.md), [SECRETS.md](SECRETS.md), [DEPLOYMENT.md](DEPLOYMENT.md)); media served only through tokenised, authenticated API streams |
| 7 | Tamper-proof storage: originals cannot be altered/deleted/overwritten without authorised approval | C | S3 versioning + Object Lock, conditional writes (overwrite → PreconditionFailed); deletion only through two-officer disposal workflow with legal-hold block ([STORAGE.md](STORAGE.md), `apps/api/test/uploads.test.ts` — "stored original cannot be deleted (object lock)", `apps/worker/test/lifecycle.test.ts` (tier moves with object lock, legal hold, disposal), `apps/api/test/evidence.test.ts` (`runDisposal` tests)) |
| 8 | Originals and derived analytical outputs separate but linked (chain of custody) | C | `evidence` ↔ `evidence_derivatives` (snapshots are kind `SNAPSHOT`), `ai_detections`, `snapshot_requests`; derived bucket separate from evidence bucket; every derivative carries evidence id and hash ([CHAIN-OF-CUSTODY.md](CHAIN-OF-CUSTODY.md)) |
| 9 | RBAC for upload, view, search, analyse, export, administer | C | 46 granular permissions in `packages/shared/src/permissions.ts` (`evidence:upload`, `evidence:read` / `evidence:play`, `search:use`, `ai:request`, `export:create`, `users:manage` / `roles:manage` / `org:manage` / `settings:manage` / `integrations:manage` …) ([AUTHORIZATION.md](AUTHORIZATION.md)); IDOR matrix 115 routes × 3 users |
| 10 | Configurable role profiles incl. field officer, IO, supervisor, forensic analyst, system administrator | C | 8 built-in roles (those five + station operator, evidence custodian, auditor) and custom roles with separation-of-duties checks (Roles admin, `apps/api/test/admin-roles.test.ts`) |
| 11 | Jurisdiction-based access by station, unit, district, Commissionerate | C | Org-unit tree (state › zone/commissionerate › district › sub-division › circle › station) as `ltree`; every evidence query goes through `evidenceVisibleSql` (out-of-scope = 404) ([AUTHORIZATION.md](AUTHORIZATION.md)) |
| 12 | On-demand AI face detection and recognition on uploaded videos | C | YuNet detection + SFace recognition against watchlists, every face embedded; legally gated per [GO-LIVE A1](GO-LIVE-CHECKLIST.md) ([AI-ARCHITECTURE.md](AI-ARCHITECTURE.md), `pipeline.test.ts` real inference) |
| 13 | On-demand ANPR for vehicle identification and indexing | C | Plate detector + OCR, approved plates become searchable attributes and watchlist hits (ANPR model `apps/ai-worker/src/models/anpr.ts`; real-inference test in `apps/ai-worker/test/inference.test.ts`, skipped when the model files are absent); Indian-plate accuracy to be declared per point 16 |
| 14 | AI object detection (weapons, vehicles, suspicious objects) | C | YOLOX-S (80 COCO classes incl. knife, vehicles, bags); configurable label sets and thresholds; weapon/vehicle rules feed classification tags |
| 15 | High accuracy in all AI analytics | C-ops | Upstream benchmark figures declared per model; **accuracy on KSP footage is measured with the evaluation harness on a reviewed dataset at UAT** (go-live gate E6). Human review (point 18) bounds the operational effect of model error |
| 16 | Bidder specifies precision, recall, FPR, FNR per AI module | C | Per-model metrics in the registry (`GET /ai/models`, AI models page) + `npm run evaluate -w @ksp/ai-worker` reporting precision / recall / false-positive rate / false-negative rate per threshold, verification metrics for face recognition and read accuracy for ANPR ([AI-MODEL-LIFECYCLE.md § Accuracy evaluation](AI-MODEL-LIFECYCLE.md)); declared upstream values: YOLOX-S COCO mAP50-95 0.405; SFace LFW 99.40 %; plate detector P 0.942 / R 0.863 |
| 17 | Confidence scores and match thresholds for all detections | C | Every detection stores `confidence` and the `threshold` in force; thresholds configurable per model and per request; similarity shown for face matches |
| 18 | Human-in-the-loop review/validation/approval/rejection | C | Review queue with approve / reject / correct label / second review; two-person rule for face matches; results advisory until approved ([AI-ARCHITECTURE.md § Review rules](AI-ARCHITECTURE.md)) |
| 19 | AI processing logically isolated from evidence storage | C | Separate `ai-worker` process and DB role `ksp_ai` (column grants, trigger guard, cannot read `evidence`), derived-bucket-only credentials, NetworkPolicy ([AI-ARCHITECTURE.md § Isolation](AI-ARCHITECTURE.md), `security-db-privileges.test.ts`) |
| 20 | Person / colour / object / tag search across repositories; suspect match < 1 minute at 1 lakh | C | Search by approved AI labels, colour, plate, tags; **repository-wide face search** of every stored face embedding: 1 00 013 faces in 7.8–8.2 s ([PERFORMANCE.md § face search](PERFORMANCE.md), `face-search-bench.mts`, `face-search.test.ts` real inference) |
| 21 | Automatic extraction of duration, frame rate, resolution … | C | ffprobe at finalize: duration, fps (incl. VFR flag), resolution, codecs, bit rate, container; shown on *Technical metadata* |
| 22 | Geo-tagging from camera GPS or external sources | C | GPS parsed from media metadata; location editable/importable; map and radius/bbox search |
| 23 | AI-based tagging and classification for indexing/search | C | CLASSIFICATION task (rule-based over detections: vehicles, weapons, crowd, …) produces reviewable tags that become search facets |
| 24 | Manual tagging, annotations, bookmarks, notes | C | Tags, workspace bookmarks, region annotations, notes, case diary ([INVESTIGATION.md](INVESTIGATION.md)) |
| 25 | Advanced search: jurisdiction, station, officer, date range, location, tags, AI attributes | C | `POST /search/evidence` with all listed criteria, facets, saved searches ([SEARCH.md](SEARCH.md), 33 tests) |
| 26 | Federated search across repositories and storage tiers | C | Index independent of tier (ACTIVE / ARCHIVE / LONG_TERM always searchable); imported external-repository items indexed identically ([SEARCH.md § Federated](SEARCH.md)) |
| 27 | Search queries and results securely stored and retrievable for audit | C | Every search audited (`SEARCH_PERFORMED`: sanitised criteria, result count, paging) in the tamper-evident ledger; saved searches; face-search probes and results stored per search |
| 28 | Fast preview and adaptive streaming without full download | C | Proxy MP4 + HLS ladder, poster/thumbnails/sprites, tokenised Range streaming ([VIDEO-PIPELINE.md](VIDEO-PIPELINE.md)) |
| 29 | Frame-level navigation, slow motion, zoom, snapshot extraction, bookmark highlighting | C | Frame step, 0.25×–2× rates, zoom, exact-frame snapshots (hash recorded), bookmarks/highlights (E2E `03-evidence`) |
| 30 | Multiple codecs and container formats | C | MP4, MOV, M4V, MKV, WEBM, AVI, TS/MTS/M2TS, 3GP, WMV/ASF, FLV, MPG; H.264/H.265/VP9/AV1/MPEG-4 decode via FFmpeg ([INGESTION.md](INGESTION.md)) |
| 31 | Tiered storage (active/archive/long-term); petabyte-scale architecture | C-cfg | Three tiers with hash-verified moves; S3-compatible object storage scales horizontally (Ceph/MinIO/vendor arrays at KSPDC); capacity model in [INFRASTRUCTURE.md](INFRASTRUCTURE.md) |
| 32 | Configurable retention policies (case type, severity, statute) | C | Retention policies (retain / archive-after / long-term-after), default policy, per-item assignment, legal holds override ([EVIDENCE-LIFECYCLE.md](EVIDENCE-LIFECYCLE.md)) |
| 33 | High availability and fault tolerance | C-ops | Stateless API/worker replicas, CloudNativePG HA, S3 replication, health probes, kustomize manifests ([DEPLOYMENT.md](DEPLOYMENT.md), [DISASTER-RECOVERY.md](DISASTER-RECOVERY.md)); availability measured on KSPDC (point 72) |
| 34 | Scalability for concurrent uploads and analytics | C-ops | Horizontal workers, queue-based processing; measured 4 concurrent 1 GB uploads, 100 k-evidence query times ([PERFORMANCE.md](PERFORMANCE.md)); sizing in INFRASTRUCTURE.md |
| 35 | Complete, immutable audit trail of uploads, views, searches, analysis, exports, deletions | C | Hash-chained append-only ledger; app role cannot UPDATE/DELETE ([AUDIT.md](AUDIT.md)) |
| 36 | Audit logs time-stamped, user-attributed, protected from modification | C | Timestamp, actor, IP, session per event; hourly signed checkpoints; `audit_verify()` detects superuser tampering |
| 37 | Digital chain of custody for every item across its lifecycle | C | Custody view per item, signed custody PDF, every touch (view/play/download/export/share/AI) is a custody event ([CHAIN-OF-CUSTODY.md](CHAIN-OF-CUSTODY.md)) |
| 38 | Controlled export with watermarking, hashing, integrity verification for court | C | Dual-approval export, watermarked copies, re-hash before packaging, manifest + signature, offline `VERIFY.txt`, verify-package page ([COURT-EXPORT.md](COURT-EXPORT.md)) |
| 39 | SHA-256 / SHA-512 integrity | C | Both registered at ingest; SHA-256 for chunks, derivatives, manifests; nightly fixity |
| 40 | Fact Sheet with evidence, hash, timestamp, location, station, FIR details | C | `FACT_SHEET.pdf` in every export, incl. BSA s.63 certificate template |
| 41 | Exports include metadata, audit trail, digital signatures | C | Package: metadata JSON, custody/audit extract, signed manifest, certificate; PKCS#11/HSM signer available (go-live B2) |
| 42 | Secure sharing with internal and external stakeholders | C | Internal shares; external portal with access code, expiry, max views, watermark, lockout, access log, revocation ([SECURE-SHARING.md](SECURE-SHARING.md)) |
| 43 | Compliance with Indian IT laws, data protection, evidence handling guidelines | EXT | Technical controls in place (DPIA input, BSA s.63 template, consent-free lawful-basis gating for biometrics, audit retention); legal confirmation is the department's / legal counsel's ([DPIA-INPUT.md](DPIA-INPUT.md), go-live A1–A5) |
| 44 | Integration with CCTNS, FIR systems, case diaries, evidence repositories | C | Integration adapters (fixture + HTTP/JSON with SSRF guard, mTLS), FIR import, case diary push, API clients + REST API ([INTEGRATIONS.md](INTEGRATIONS.md)); live CCTNS contract to be supplied by KSP ([CCTNS-INTEGRATION-REQUEST.md](CCTNS-INTEGRATION-REQUEST.md)) |
| 45 | Multilingual user interface | C | English + Kannada, 100 % string coverage, instant switch, Kannada fonts in UI and PDFs ([I18N.md](I18N.md)) |
| 46 | Dashboards: upload status, analytics progress, storage utilisation, system health | C | Dashboard KPIs/charts, System health page, storage snapshots ([DASHBOARDS-REPORTS-ALERTS.md](DASHBOARDS-REPORTS-ALERTS.md)) |
| 47 | Standard and configurable reports (usage, analytics, compliance) | C | 9 report types with filters, CSV/JSON/PDF, scheduling, hashed outputs |
| 48 | Alerts for failed uploads, processing errors, storage thresholds, policy violations | C | 10 alert rules incl. UPLOAD_FAILED, PROCESSING_FAILED, STORAGE_THRESHOLD, POLICY_VIOLATION, INTEGRITY_FAILURE; in-app, e-mail, webhook |
| 49 | Strong authentication: password policies, MFA | C | Complexity/history/expiry policy, lockout, TOTP MFA + recovery codes, session limits ([AUTHENTICATION.md](AUTHENTICATION.md)) |
| 50 | Secure access from web browsers and authorised internal networks only | C | HTTPS/CSP/HSTS; `ALLOWED_NETWORKS` CIDR allow-list enforced in the API (403 + audit) with the external share portal exempt ([SECURITY-ARCHITECTURE.md § Authorised-network access](SECURITY-ARCHITECTURE.md), `security-network.test.ts`) |
| 51 | Separation of duties between creators, reviewers, administrators | C | Requester ≠ approver for exports/disposal, reviewer ≠ second reviewer, admins have no evidence access by default, SoD conflict checks on custom roles |
| 52 | AI model updates and retraining without disrupting operations | C | Model registry: STAGED → ACTIVE atomic switch, running jobs keep their model, rollback by re-activation; training-dataset exports ([AI-MODEL-LIFECYCLE.md](AI-MODEL-LIFECYCLE.md)) |
| 53 | Configuration controls to enable/disable analytics modules | C | `AI_TASKS_ENABLED`, legal approvals per task, per-model activate/retire; UI hides disabled tasks with reason |
| 54 | Evidentiary bookmarking of critical moments | C | Bookmarks and highlights with time codes, recorded in custody, exportable |
| 55 | Performance logs and system metrics | C | Prometheus metrics (API, worker, AI worker), request logs, heartbeats, `/system/health` ([MONITORING.md](MONITORING.md)) |
| 56 | Disaster recovery and backup | C | Encrypted backups with verification, S3 replication, restore + DR drill scripts ([BACKUP-RESTORE-RUNBOOK.md](BACKUP-RESTORE-RUNBOOK.md), [DISASTER-RECOVERY.md](DISASTER-RECOVERY.md)) |
| 57 | Secure deletion aligned with retention policies and legal approvals | C | Disposal candidates only after retention end, no hold, no open case; two-officer approval with authority reference; objects destroyed, record + custody retained |
| 58 | Time-synchronised multi-video playback for reconstruction | C | Workspace synchronised player (up to 4 videos, offsets, aligned by recording time) |
| 59 | Deployable on-premise at KSPDC | C-cfg | No cloud dependency: Kubernetes (kustomize) and compose manifests, S3-compatible storage, PostgreSQL 16, CPU inference; preflight validates production configuration ([DEPLOYMENT.md](DEPLOYMENT.md), [INFRASTRUCTURE.md](INFRASTRUCTURE.md)) |
| 60 | Ease of use, intuitive workflows | C | Role-based navigation, two UI/UX audits (56 fixes), WCAG checks (0 axe violations), user guide; UAT plan ([USER-GUIDE.md](USER-GUIDE.md), [UAT-PLAN.md](UAT-PLAN.md)) |
| 61 | OWASP Top 10 compliance; VAPT by CERT-In empanelled auditor | EXT | OWASP controls implemented and tested internally (two assessment rounds, 19 security suites, [SECURITY-TEST-REPORT.md](SECURITY-TEST-REPORT.md)); VAPT scope prepared ([VAPT-SCOPE.md](VAPT-SCOPE.md)) — audit to be commissioned (go-live B1) |
| 62 | National cybersecurity / CERT-In guidelines | EXT | Logging, MFA, patch process, incident runbooks in place; formal attestation external |
| 63 | Strict RBAC — explicit authorisation only | C | Deny-by-default permissions; privilege-escalation guard on role grants |
| 64 | Centralised audit log of access, modification, sharing, administrative actions | C | Single ledger covers users and system actors; audit viewer with export |
| 65 | Immutable logs, configurable retention | C | Ledger is never pruned (append-only, permanent) — any configured retention floor is met; checkpoints exportable to external WORM/notary ([AUDIT.md](AUDIT.md)) |
| 66 | MFA for all admin users, optional for others | C | `requireMfaForRoles` setting (production seed forces administrators; supervisors, auditors, custodians by default); any user may enrol |
| 67 | Automatic logout after configurable inactivity | C | `idleTimeoutMinutes` (default 30) and absolute session lifetime in System settings |
| 68 | Configurable retention and disposal policies, secure deletion | C | As 32 and 57 |
| 69 | PII access tightly controlled, visible only to authorised roles | C | Jurisdiction + permission gating, data minimisation in responses, face/plate analytics behind legal gates, external shares watermarked and logged |
| 70 | Export controls: only authorised users download/print/share, fully tracked | C | `evidence:download_original` (originals), `export:download` (court exports) and the other `export:*`, `share:*` permissions; every download/print/share is a custody event; watermarks name the recipient |
| 71 | Secure, encrypted backup and DR | C | As 56 (age-encrypted, verified backups) |
| 72 | 99.5 % monthly availability | C-ops | HA design (33), synthetic availability probe and alerting in monitoring stack; measured in operation at KSPDC |
| 73 | Upload initiation ≤ 5 s under concurrent load | C-ops | Initiation is one request (`POST /uploads`: scope and limit checks, an S3 multipart initiation, one transaction writing the session row and its audit event). Its latency was **not separately measured**: [PERFORMANCE.md § Ingestion](PERFORMANCE.md) measures whole 1 GB uploads on a single development laptop (1 file uploaded in 5.2 s; 4 concurrent users 81 MB/s aggregate). Initiation ≤ 5 s under concurrent load to be measured at the UAT load test on KSPDC hardware |
| 74 | Registration within 2 minutes of upload completion | C-ops | Measured on a single development laptop, not production-scale ([PERFORMANCE.md § Host](PERFORMANCE.md)): 1 GB file REGISTERED 17.6 s after the first byte; at 4 concurrent 1 GB files finalize took 52–140 s each with two worker slots (`WORKER_CONCURRENCY=2`, files queue), so the slowest exceeded 2 minutes on that laptop. Capacity is sized by `WORKER_CONCURRENCY` / worker replicas; re-measure on KSPDC hardware ([PERFORMANCE.md § Ingestion](PERFORMANCE.md)) |
| 75 | Dashboards and reports load ≤ 5 s | C-ops | Development laptop, 100 k evidence ([PERFORMANCE.md](PERFORMANCE.md)): `GET /dashboard/summary` 33–79 ms for a single request (station / district / state), but at 100 concurrent requests p95 was 3.4 s (station), 4.9 s (district), 9.6 s (state) — **the state-level dashboard exceeds the 5 s target at 100 concurrent users on that laptop**. Reports run asynchronously with notification. Re-measure on KSPDC hardware; state dashboard needs optimisation/caching (open) |
| 76 | MTTR ≤ 2 h for critical failures | C-ops | Runbooks, health probes, restore drill (RTO target 2 h documented) ([RUNBOOK.md](RUNBOOK.md)); support process is contractual |
| 77 | Non-critical issues resolved within 4 h | C-ops | Alerting + runbooks support the process; SLA is contractual |
| 78 | REST APIs for video search and retrieval | C | `/api/v1/integration/*` with OAuth-style client credentials, scopes, jurisdiction, tokenised retrieval; OpenAPI (Swagger UI) at `/api/docs` ([INTEGRATIONS.md](INTEGRATIONS.md)) |

## Items closed in the October 2026 completion pass

| Point | Previously | Now |
|---|---|---|
| 16 | upstream figures only | evaluation harness (P/R/FPR/FNR per threshold, face verification, ANPR read accuracy) recording `kspEvaluation` on the model; smoke-tested with real inference |
| 20 | watchlist matching only | repository-wide face search over every stored face; 1 lakh in ~8 s, audited, visibility-filtered |
| 45 | English only | English + Kannada (1 735 translations, 100 % of UI strings), language switch, locale-aware formatting |
| 50 | perimeter only | application-layer `ALLOWED_NETWORKS` allow-list with audit and preflight warning |

## What the department must still provide or commission

CERT-In VAPT (61), legal confirmations (43, A1–A5), CCTNS contract (44), KSPDC infrastructure for availability and
SLA measurement (33, 72–77), a reviewed KSP footage dataset for declared accuracy (15/16, gate E6), and a Kannada
language review (45, gate E7).
