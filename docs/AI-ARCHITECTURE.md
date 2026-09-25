# AI analysis & human review — architecture (spec modules 8 and 9)

AI output is **advisory**. Every detection is stored `PENDING`; nothing becomes authoritative (an evidence tag,
a confirmed watchlist match, training data) until a human reviewer acts on it. Face-recognition matches need
**two approvals by different reviewers**.

## Components

```
 web (AI tab, /review, /ai/models, /ai/watchlists)
   │  REST /api/v1/ai/*, /api/v1/review/*
   ▼
 API (ksp_app) ── validates, authorises (loadEvidenceFor / evidenceVisibleSql), snapshots proxy location
   │  INSERT ai_jobs (QUEUED) + audit AI_ANALYSIS_REQUESTED + pg_notify('ksp_ai_jobs', jobId)   [one tx]
   ▼
 ai-worker (separate process, role ksp_ai, S3 AI identity)        apps/ai-worker
   │  LISTEN ksp_ai_jobs (+15 s poll) → claim: UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)
   │  read ONLY input.derivativeKey (PROXY_MP4) from the DERIVED bucket
   │  ffmpeg fps filter → raw RGB24 frames → ONNX Runtime (CPU) detectors → NMS → tracker/dedupe
   │  crops → derived bucket evidence/<evidenceId>/ai/<jobId>/<detectionId>.jpg
   │  INSERT ai_detections (PENDING) · UPDATE ai_jobs progress/stats/heartbeat · audit_append()
   ▼
 reviewers (/review) ── ai_review_events (append-only) + detection review columns + custody audit
   └─ approved CLASSIFICATION → evidence_tags (source AI_APPROVED)

 worker (ksp_app, pg-boss queue ai.training_export) ── reviewed detections → reports bucket dataset
```

The API never runs inference; the worker never sees the evidence table, original objects, users or the audit ledger.

## Isolation

### Database privileges of `ksp_ai` (0004 + 0500)

| Object | Privilege | Why |
|---|---|---|
| `ai_models`, `ai_watchlists` | SELECT | load registered models; resolve watchlist kind |
| `ai_watchlist_entries` | SELECT; UPDATE (`embedding`, `model_id`, `embedding_error`, `embedded_at`) | gallery for matching; compute reference embeddings (0500). Cannot change label/image/list. |
| `ai_jobs` | SELECT (`id, evidence_id, tasks, status, input, params, model_ids, created_at, progress, stats, error, started_at, finished_at`); UPDATE (`status, progress, stats, error, started_at, finished_at`) | claim/progress/heartbeat/finish; `requested_by` is **not** readable (0500 adds the progress/stats columns for heartbeat + stale-job reaping) |
| `ai_detections` | INSERT on machine columns only (0500 narrows 0004's table-wide INSERT); SELECT (`id, job_id`) | write results; **cannot** set or change `review_status, reviewed_by, reviewed_at, review_comment, corrected_label`, cannot DELETE |
| `audit_append()` | EXECUTE (0002) | STARTED / COMPLETED / FAILED / WATCHLIST_EMBEDDED events, actor `SYSTEM ai-worker@<host>` |
| everything else (`evidence`, `evidence_derivatives`, `users`, `sessions`, `cases`, `audit_events`, `evidence_tags`, `ai_review_events`, …) | none | |

`ai_detection_guard` (0500, BEFORE INSERT, SECURITY DEFINER) additionally enforces: the job exists, is `RUNNING`, belongs to
the same evidence id, and the detection's model is one of the job's `model_ids`; `model_code/model_version/task` are
**copied from the registry** (a worker cannot forge provenance) and review columns are forced to `PENDING`/NULL.
Consequence: once the API sets a job `CANCELLED`, further inserts fail — cancellation is enforced by the database.

Tests: `apps/ai-worker/test/pipeline.test.ts` › "ksp_ai least privilege" (SELECT on evidence/users/sessions/cases/audit/
derivatives/requested_by/review_status denied; UPDATE review columns, models, job ownership, watchlist labels denied;
INSERT review_status / non-running job / foreign evidence denied; provenance overwritten).

### Storage

The worker's S3 client uses `S3_AI_ACCESS_KEY/S3_AI_SECRET_KEY` (falls back to the main credentials in development;
**required in production** — the worker refuses to start without them). Production: an IAM identity limited to
`GetObject` on `derived/evidence/*/proxy/*` + `derived/ai/watchlists/*` and `PutObject` on `derived/evidence/*/ai/*`.
Defence in depth in code: the worker refuses jobs whose `input.derivativeBucket` is not the derived bucket or whose key
is not under `evidence/<job.evidence_id>/`. **UNVERIFIED locally:** versitygw runs single-account, so bucket-level
isolation of the AI identity could not be exercised on the dev host.

### Input snapshot

`ai_jobs.input = {derivativeBucket, derivativeKey, durationMs, frameRate, width, height, orgUnitId}` is written by the
API from `evidence_derivatives` (latest `PROXY_MP4`) + `evidence`. `orgUnitId` is included only so the worker's audit
events carry the jurisdiction. The original is never read, so AI can never modify original evidence (and the
`evidence_guard` trigger / Object Lock would prevent it anyway).

## Pipeline (apps/ai-worker/src/pipeline.ts)

1. **Claim** oldest `QUEUED` job (`FOR UPDATE SKIP LOCKED`), set `RUNNING`, audit `AI_ANALYSIS_STARTED` (same tx).
2. **Models**: rows for `model_ids`; artefacts resolved under `AI_MODELS_DIR` (`models://file`) and **SHA-256 verified
   before first load** (mismatch → job FAILED). Dependencies run internally without storing output
   (FACE_RECOGNITION ← FACE_DETECTION; CLASSIFICATION ← OBJECT_DETECTION). Detectors sharing an artefact (PERSON +
   OBJECT on YOLOX-S; face detection shared with recognition) run **one** inference per frame (`MemoDetector`).
3. **Frames**: proxy downloaded to `WORK_DIR/ai/<job>/`, `ffprobe`, then `ffmpeg -vf fps=<sampleFps>,scale=…
   -f rawvideo -pix_fmt rgb24 pipe:1` (argument array, no shell; back-pressured async iterator). Analysis resolution
   long side ≤ 1280. `frame_time_ms = index·1000/fps`, `frame_number = round(t·frameRate)`. (Core's `ffmpeg()` buffers
   stdout as text, so this one streaming call spawns `FFMPEG_PATH` directly.)
4. **Detect** per task with the job threshold (`params.thresholds[task]`) or the model default; class-wise NMS.
5. **Track + dedupe** (`tracker.ts`): greedy association per track class (label / watchlist entry / `plate`) by IoU on a
   constant-velocity prediction, with a centre-distance fallback for small fast objects; tracks close after 2 missed
   samples. Per track the best detection of every `keepEveryMs` window (default 10 s) is stored, with
   `attributes.observations`. Crops (10 % margin, JPEG q85) only for stored detections.
6. **Attributes**: dominant colour (k-means k=3 on torso / vehicle centre → `dominantColor #rrggbb`, `colorName`,
   `colorShare`); ANPR `plateText` (A-Z0-9), `plateConfidence` (min per-character probability), `watchlistHit`;
   face recognition `watchlistEntryId`, `similarity` (cosine) — unmatched faces are **not** emitted as recognitions.
7. **Classification** (rules model `ksp-evidence-tagger`): evidence-level suggestions `person`, `vehicle`,
   `weapon:<label>`, `crowd` (≥ `crowdMinPersons` persons in one frame), each with the supporting crop/time.
8. **Progress/heartbeat** every 1.5 s: `UPDATE … WHERE status='RUNNING'`; zero rows ⇒ cancelled ⇒ stop (ffmpeg killed).
9. **Finish**: `COMPLETED` + stats (`framesProcessed, msPerFrame, detections{task:n}, rawDetections, wallMs`) + audit
   `AI_ANALYSIS_COMPLETED`; on error `FAILED` + `error` (`PROXY_NOT_FOUND`, `MODEL_MISSING`, artefact mismatch …) +
   `AI_ANALYSIS_FAILED`. Jobs without a heartbeat for 10 min are failed (`WORKER_LOST`) by any worker.

Watchlist embeddings (`watchlist.ts`): FACE entries whose embedding is missing or from a different recognition model
are embedded by the worker (largest face, YuNet → 5-point alignment → SFace). No face → `embedding_error NO_FACE_FOUND`.
Recognition compares only against entries embedded with the job's recognition model.

## API

| Method & path | Permission | Notes |
|---|---|---|
| `GET /ai/tasks` | ai:request / ai:review / ai:models_manage | `{items:[{task,label,description,available,models:[{id,code,name,version,defaultThreshold,labels,licence}]}]}` |
| `POST /ai/evidence/:id/jobs` | ai:request (+ `loadEvidenceFor`) | body `{tasks[], sampleFps?, thresholds?, watchlistIds?, keepEveryMs?, crowdMinPersons?}` → 202 `AiJobDto`. 409 `MEDIA_NOT_READY` / `NO_PROXY`; 422 unavailable tasks / non-applicable watchlists / FACE_RECOGNITION without FACE list |
| `GET /ai/evidence/:id/jobs`, `GET /ai/jobs/:id` | ai:request or ai:review | |
| `POST /ai/jobs/:id/cancel` | ai:request | 409 when already final; audit `AI_ANALYSIS_CANCELLED` |
| `GET /ai/evidence/:id/watchlists` | ai:request | lists whose org unit covers the evidence org path |
| `GET /ai/evidence/:id/detections` | ai:request or ai:review | filters `task,reviewStatus,minConfidence,label,jobId`; `AiDetectionDto` with `cropUrl`; custody `AI_RESULTS_VIEWED` (throttled 10 min) |
| `GET /ai/crops/:detectionId?t=` | public, media token (scope `image`, ref `ai:<id>`, bound to evidence, live session) | 401 bad/expired token, 403 token for another item |
| `GET/POST /ai/models`, `PATCH /ai/models/:id`, `POST /ai/models/:id/activate`, `…/retire` | ai:models_manage | see AI-MODEL-LIFECYCLE.md |
| `GET/POST /ai/watchlists`, `GET/PATCH/DELETE /ai/watchlists/:id`, `POST /ai/watchlists/:id/entries`, `DELETE …/entries/:entryId`, `POST …/entries/:entryId/reembed`, `GET …/entries/:entryId/image` | ai:watchlist_manage, org-scoped (other jurisdiction → 404) | FACE: `imageBase64` JPEG/PNG ≤ 2 MB (magic-byte checked) stored at `derived/ai/watchlists/<list>/<entry>.<ext>`; VEHICLE: `plate` normalised A-Z0-9. Embeddings are never returned |
| `POST/GET /ai/training-exports`, `GET /ai/training-exports/:id`, `GET …/:id/files/<manifest.json|dataset.jsonl|coco.json|crops/<id>.jpg>` | ai:models_manage (own exports) | |
| `GET /review/queue` | ai:review | only evidence the reviewer may see **and** review (`evidenceVisibleSql` + ai:review scope); filters `task,status,label,minConfidence,maxConfidence,evidenceId,orgUnitId,jobId`; sort `±confidence, ±created_at, frame_time`; items add `reviewedByMe, dualApproval` |
| `GET /review/summary` | ai:review | open items by task/status |
| `POST /review/detections/:id` | ai:review (+ `loadEvidenceFor 'ai:review'`) | `{action: APPROVE|REJECT|REQUEST_SECOND_REVIEW|COMMENT|CORRECT_LABEL, comment?, correctedLabel?}` |
| `POST /review/detections/bulk` | ai:review | `{items:[{id,action,comment?}]}` (≤100) → `{results:[{id,ok,status|error}], succeeded, failed}` |
| `GET /review/detections/:id/history` | ai:review or ai:request | `{detection, events[]}` |

### Review rules

* `REJECT` and `COMMENT` need a comment (≥ 3 chars). `APPROVED`/`REJECTED` are final (further decisions → 409).
* `FACE_RECOGNITION`: first approval → `NEEDS_SECOND_REVIEW`; the same reviewer cannot approve again
  (409 `SECOND_REVIEWER_REQUIRED`); a different reviewer → `APPROVED`.
* An item escalated with `REQUEST_SECOND_REVIEW` must be approved by someone other than the escalating reviewer.
* `CORRECT_LABEL` records `corrected_label` (status unchanged); for CLASSIFICATION the corrected tag must be a valid tag.
* Approved `CLASSIFICATION` → `evidence_tags(tag, source='AI_APPROVED')` + `EVIDENCE_TAGGED` custody event.
* Every action: `ai_review_events` row (append-only for ksp_app: UPDATE/DELETE revoked), detection review columns,
  custody audit `AI_RESULT_APPROVED | REJECTED | ESCALATED | COMMENTED | LABEL_CORRECTED` with `evidenceId`, model
  code@version, confidence, threshold.

## Audit codes added

`AI_RESULT_LABEL_CORRECTED`, `AI_RESULTS_VIEWED`, `AI_ANALYSIS_CANCELLED` (custody); `AI_MODEL_UPDATED`,
`AI_TRAINING_EXPORT_REQUESTED`, `AI_WATCHLIST_EMBEDDED` (non-custody). Existing codes used: `AI_ANALYSIS_*`,
`AI_RESULT_*`, `AI_MODEL_REGISTERED/ACTIVATED/RETIRED`, `AI_TRAINING_EXPORTED` (also once per evidence item included,
with `evidenceId`), `AI_WATCHLIST_CHANGED`.

## Web

* Evidence tab **AI analysis** (order 30; `ai:request` gated by the per-evidence `canRequestAi` flag, or `ai:review`):
  request form (only tasks with ACTIVE models; per-task threshold; sample fps; applicable watchlists), jobs with live
  progress (2 s polling while running) and cancel, detections grouped by task with confidence bar (threshold tick +
  numeric %), review badge, colour/plate/watchlist attributes, a per-task timeline strip, optional player with bbox
  overlays/markers (`EvidencePlayer`), click → `/evidence/:id?tab=playback&t=<ms>`.
* `/review` queue: crop cards, model/version, threshold, evidence number + time link; keyboard J/K/A/R/S/X/H; URL
  filters; bulk approve/reject/second-review with per-item results; history drawer.
* `/ai/models`: versions, licence, SHA-256, metrics, activate/retire (confirm), threshold/metrics editor, training exports.
* `/ai/watchlists`: lists by jurisdiction, FACE entries with reference images and embedding status (retry), VEHICLE plates.

## Operations

* `npm run fetch-models -w @ksp/ai-worker` — download + verify + register + activate the pinned models (uses
  `DATABASE_URL`; `--no-db` to only download, `--no-activate` to register STAGED).
* `npm run dev:ai` / `scripts/dev/run.sh start ai` — worker; env `AI_WORKER_CONCURRENCY` (default 1),
  `AI_INTRA_OP_THREADS` (default 4). CPU only (onnxruntime-node).
* Measured on the dev host (8 vCPU, shared with other agents' processes): YOLOX-S 640 on a 1280×720 frame
  ≈ 107–190 ms; all six tasks together 190–420 ms per sampled frame; a 20 s clip at 2 fps (40 frames) completes in
  ≈ 15–22 s wall (≈ real time at 2 fps). GPU execution providers are not configured (UNVERIFIED).
