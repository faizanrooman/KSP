# Evidence ingestion

How video gets from a camera, browser or station terminal into immutable, registered evidence.

```
client ──chunks (SHA-256 each)──▶ API /uploads ──S3 multipart──▶ staging bucket
          complete ─▶ evidence row (RECEIVED) + custody events ─▶ queue ingest.finalize
worker:  hash SHA-256/512 → ffprobe + decode check → metadata/GPS → duplicate check
          ├─ problem ─▶ QUARANTINED (<CODE>: message) ─▶ reviewer: release | reject
          └─ valid ───▶ WORM copy (Object Lock, If-None-Match) → re-hash → REGISTERED + evidence number
                         → staging object deleted → queue media.process {evidenceId}
```

Code: API `apps/api/src/modules/uploads/`, pipeline `packages/core/src/ingest/` (shared by the worker and
the quarantine-release API), worker `apps/worker/src/jobs/ingest/`, web `apps/web/src/modules/upload/`,
CLI `tools/station-client/`, contracts `packages/shared/src/ingest.ts`, migration `db/migrations/0200_ingest_pipeline.sql`.

## Upload API (`/api/v1/uploads`, requires `evidence:upload`)

| Method & path | Request | Response |
|---|---|---|
| `POST /uploads/batches` | `{orgUnitId, label?, clientInfo?}` | 201 `{id, orgUnitId, orgUnitName, label, clientInfo, createdAt}` |
| `GET /uploads/batches/:id` | — | batch + `summary{total,registered,quarantined,processing,uploading,failed}` + `items[]` (session views) |
| `POST /uploads` | `{batchId?, orgUnitId, filename, size, mimeType?, sha256?, chunkSize?, metadata?}` | 201 `{id, chunkSize, totalChunks, expiresAt, status}` |
| `PUT /uploads/:id/parts/:n` | `application/octet-stream` body, header `x-chunk-sha256` | `{partNumber, size, sha256, receivedBytes, receivedParts, totalChunks}` |
| `GET /uploads/:id` | — | session view incl. `receivedParts[]` (for resume) and `evidence{id,evidenceNumber,status,statusReason,reasonCode,sha256}` |
| `POST /uploads/:id/complete` | — | session view (status `COMPLETED`, evidence `RECEIVED`). Idempotent |
| `DELETE /uploads/:id` | — | `{id, status:'ABORTED'}` |
| `GET /uploads` | `?scope=mine\|station&orgUnitId&batchId&status&page&pageSize` | `{items, total, page, pageSize}` |

`metadata`: `title, description, category, officerBadge | officerId, deviceSerial, recordedAt, incidentAt,
locationText, latitude+longitude, notes` (strict; unknown keys rejected). Officer is resolved by id or badge;
the device by serial, and its assigned officer is used when no officer is declared. Unknown officer/device →
400 `UNKNOWN_OFFICER` / `UNKNOWN_DEVICE` before any data is transferred.

Rules and errors:

* Station (`orgUnitId`, unit type STATION or UNIT) must be covered by the caller's `evidence:upload` grant
  (`hasPermissionAt`); otherwise **404**. API clients (no user) → 403: uploads are attributable to a person.
* Extension must be in `ALLOWED_UPLOAD_EXTENSIONS` → else 400 `UNSUPPORTED_FILE_TYPE`. Size >
  `uploadPolicy.maxFileSizeBytes` → 413 `FILE_TOO_LARGE`. More than `maxConcurrentSessionsPerUser` open
  sessions → 429 `UPLOAD_LIMIT`. Sessions expire after `sessionTtlHours` (410 `GONE` afterwards).
* Chunk size = client hint or `uploadPolicy.chunkSizeBytes`, clamped to 5–64 MiB and raised so that
  `totalChunks ≤ 10 000`. Every part except the last must be exactly `chunkSize` → else 400
  `CHUNK_SIZE_MISMATCH`. SHA-256 of the body must equal `x-chunk-sha256` → else 400 `CHUNK_HASH_MISMATCH`
  (transit corruption: resend). Parts may arrive in any order and concurrently; re-sending a part replaces it.
* Only the creator may send parts / complete / abort (others: 404). The creator or anyone with
  `evidence:read` over the station may read a session.
* `complete` requires every part and `Σ sizes == declared size` → else 400 `UPLOAD_INCOMPLETE` with
  `details.missingParts`. It completes the S3 multipart upload, creates the `evidence` row (status
  `RECEIVED`, tier `STAGING`, `org_unit_id` + `org_path` of the station, declared metadata), writes
  `UPLOAD_COMPLETED` and `EVIDENCE_RECEIVED` custody events and enqueues `ingest.finalize {uploadSessionId}`.

Staging key: `uploads/<yyyy>/<mm>/<sessionId>` in the staging bucket.

## Finalize (queue `ingest.finalize`, processing_jobs kind `VALIDATE_REGISTER`)

Implemented in `finalizeUpload()` (`packages/core/src/ingest/pipeline.ts`); the worker wraps it with
`ProcessingTracker`, final-failure handling and alerts. All steps are idempotent: terminal states are NOOP,
the destination key is content-addressed, the counter/registration update runs under a row lock.

1. Evidence → `VALIDATING`. Stream the staged object once → SHA-256 + SHA-512 (`EVIDENCE_HASHED`).
   Declared SHA-256 differs → **`HASH_MISMATCH`**.
2. `ffprobe` through an internal presigned URL (never client-visible; tool output is scrubbed of URLs
   before it is stored), protocol whitelist `file,http,https,tcp,tls`, 180 s time limits. Checks: readable +
   a real video stream (not an image/cover art) → else **`NOT_VIDEO`**; container in
   `SUPPORTED_CONTAINERS` → else **`UNSUPPORTED_FORMAT`**; codec in `SUPPORTED_VIDEO_CODECS` → else
   **`UNSUPPORTED_CODEC`**; duration > 0 and a clean decode (`ffmpeg -v error -xerror`) of the first and
   last 5 s (whole stream when ≤ 10 s) → else **`CORRUPT`**. Extension and declared MIME are never trusted.
3. Metadata (`EVIDENCE_METADATA_EXTRACTED`): `duration_ms, container_format, video_codec, audio_codec,
   width, height, frame_rate (avg), bit_rate, mime_type` (from the container), `recorded_at` = declared,
   else container `creation_time` (epoch defaults ignored), `recorded_end_at`, GPS from ISO-6709 tags
   (`com.apple.quicktime.location.ISO6709`, `location`, `location-eng`, …) → `gps_source CONTAINER_TAG`,
   else declared → `DECLARED`, else station coordinates → `STATION`; `device_metadata` = make/model/
   serial/firmware/encoder/software tags; `probe` = full ffprobe JSON. Stored for quarantined items too.
4. Duplicate: an **earlier** evidence item (not DISPOSED/REJECTED) with the same SHA-256 →
   `duplicate_of` + **`DUPLICATE`** (`EVIDENCE_DUPLICATE_DETECTED`). "Earlier" makes concurrent identical
   uploads deterministic (the first registers, the second is the duplicate).
5. Register (`registerEvidence()`): server-side multipart copy (UploadPartCopy, 512 MiB parts) into the
   evidence bucket at `originals/<yyyy>/<mm>/<evidenceId>/<sha256>` with Object Lock
   (`OBJECT_LOCK_MODE`, `OBJECT_LOCK_DAYS`) on CreateMultipartUpload and `If-None-Match: *` on completion
   (an existing original can never be overwritten; an existing identical key from a crashed attempt is
   reused and re-verified). The stored object is **re-hashed** and compared (SHA-256 + SHA-512 + size;
   mismatch → `integrity_checks ok=false`, `EVIDENCE_INTEGRITY_FAILED`, retry). Then, in one transaction:
   evidence number `KSP-<STATIONCODE>-<YYYY>-<NNNNNN>` (station code upper-cased, non-alphanumerics removed;
   per station per IST year via `evidence_number_counters` row lock), default retention policy +
   `retain_until`, `storage_bucket/key/version_id`, tier `ACTIVE`, `object_lock_until`, `registered_at`,
   `last_verified_at`, status `REGISTERED`, `evidence_storage_copies` CURRENT row, `integrity_checks` row (trigger `REGISTRATION`),
   `EVIDENCE_STORED` + `EVIDENCE_REGISTERED`. After commit: staging object deleted, `media.process
   {evidenceId}` enqueued with a deterministic job id (sent at most once per evidence item).
6. Final failure (last pg-boss retry, or a permanent error): the item is quarantined as
   **`PROCESSING_FAILED`**, the session `error` is set, `UPLOAD_FAILED` is audited and an `alerts` row
   (`UPLOAD_FAILED`, `dedupe_key UPLOAD_FAILED:<sessionId>`) is raised. Nothing is deleted.

`status_reason` format: `<CODE>: <message>` (`parseStatusReason()` in `@ksp/shared`); codes in
`QUARANTINE_REASONS`.

Cron `uploads.expire` (every 10 min): unfinished sessions past `expires_at` → `EXPIRED`, S3 multipart
aborted, `UPLOAD_ABORTED {reason: EXPIRED}`; completed sessions whose evidence is still `RECEIVED` after
10 min get `ingest.finalize` re-enqueued (lost enqueue after commit).

## Quarantine (`evidence:quarantine_manage`, jurisdiction-scoped)

| Method & path | Request | Response |
|---|---|---|
| `GET /uploads/quarantine` | `?orgUnitId&reason&page&pageSize` | `{items[{id,title,originalFilename,sizeBytes,sha256,statusReason,reasonCode,reasonMessage,duplicateOf,orgUnitName,uploadedBy,containerFormat,videoCodec,durationMs,createdAt,quarantinedAt}], total, page, pageSize}` |
| `POST /uploads/quarantine/:evidenceId/release` | `{reason}` (5–2000 chars) | **202** `{requestId, id, status:'QUEUED', statusUrl}`; 409 while a release of the item is pending |
| `GET /uploads/quarantine/releases/:requestId` | — | `{status: QUEUED|RUNNING|COMPLETED|FAILED, outcome, error, evidenceStatus, evidenceNumber}` (requester or quarantine manager in scope; else 404) |
| `POST /uploads/quarantine/:evidenceId/reject` | `{reason}` | `{id, status:'REJECTED'}` |

* Lists apply `orgScopeSql(evidence:quarantine_manage)` **and** `evidenceVisibleSql`. Decisions go through
  `loadEvidenceFor` (invisible → 404) and additionally require the permission at the evidence's org path.
* Separation of duties: the uploader cannot release or reject their own upload (403 `SEPARATION_OF_DUTIES`).
* Release is **asynchronous** (FN-4): the API validates the decision (scope, SoD, status), records a
  `quarantine_releases` row with the releasing user's audit actor snapshot and queues `ingest.release`; the worker
  re-hashes if needed (multi-GB files no longer block an HTTP request), stores and registers through the same
  `registerEvidence()` path — the `EVIDENCE_QUARANTINE_RELEASED` event (actor = releasing user) commits in the
  registration transaction. Permanent failures mark the request FAILED with the reason; transient errors are
  retried by pg-boss. The Quarantine page polls the request and shows progress / result.
* Reject: status `REJECTED`, staged object deleted, storage fields cleared, record kept,
  `EVIDENCE_REJECTED` with reason. Non-quarantined items → 409.

## Web (`apps/web/src/modules/upload/`)

* **Upload evidence** (`/upload`): station selector (defaults to the user's home station), batch label,
  drag-and-drop of files **and folders**, file/folder pickers, default metadata with "Apply to all",
  per-file details. Engine (`engine.ts`): 3 files × 3 chunks, per-chunk SHA-256 with WebCrypto, retry with
  exponential backoff + jitter (network, 5xx, 429, `CHUNK_HASH_MISMATCH`), pause/resume/cancel per file and
  for all, speed from a 5 s window. Resume after reload: session ids in `localStorage`
  (`ksp-upload:<name>|<size>|<lastModified>`); re-adding the same file asks the server for received parts.
  Final states: Registered (link `/evidence/:id`), Quarantined (reason), Failed (error).
  The browser does not pre-hash whole files (WebCrypto has no streaming digest); the server's hash plus
  per-chunk verification provide the integrity guarantee.
* **Upload history** (`/uploads`): mine / jurisdiction, status filter, pagination, auto-polling.
* **Quarantine** (`/uploads/quarantine`): reason filter, Release / Reject with `ConfirmDialog requireReason`.

## Station client

`tools/station-client` (`ksp-upload`), see its README: bearer login (+TOTP), auto refresh, recursive folders,
sidecar `<file>.json` metadata, whole-file + per-chunk SHA-256, concurrency, resumable state file, waits
for results, summary table, exit codes.

## Tests

* `apps/api/test/uploads.test.ts` — E2E (out-of-order concurrent chunks → finalize → REGISTERED; hashes =
  Node crypto; WORM object + retention; metadata + GPS; MEDIA_PROCESS once; custody trail; integrity row),
  chunk hash/size/header errors, missing parts, abort, resume, DUPLICATE, CORRUPT (truncated MP4),
  NOT_VIDEO (renamed file), UNSUPPORTED_CODEC (FFV1/MKV), HASH_MISMATCH, oversize, bad extension, unknown
  officer/device, session limit, other user 404, out-of-jurisdiction 404, 401/403, quarantine list scope,
  release/reject + authz + SoD, DB immutability as `ksp_app`, locked object cannot be deleted, no storage
  URLs in reasons/audit.
* `apps/api/test/uploads.large.test.ts` — ≈218 MiB file, 16 MiB chunks, multi-part WORM copy, full re-hash.
* `apps/worker/test/ingest.test.ts` — real pg-boss consumer, sequential evidence numbers, retry vs final
  failure (quarantine + audit + alert), expiry cron, malformed payloads.
* `tools/station-client/test/station-client.test.ts` — API on an ephemeral port + real worker; folder
  upload with sidecar, wait for registration, idempotent rerun, interrupted upload resume, token refresh,
  login/usage errors.
