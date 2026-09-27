# Video processing & playback (spec module 7)

Owner: video workstream. Code: `apps/worker/src/jobs/media/`, `apps/api/src/modules/media/`,
`apps/web/src/modules/video/`. Tests: `apps/worker/test/media.test.ts`, `apps/api/test/media.test.ts`,
`apps/web/src/modules/video/video.test.ts`. Fixture: `apps/api/test/fixtures/media-evidence.ts`.

## 1. Pipeline (worker, queue `media.process`)

Payload `{ evidenceId, force? }` (`MediaProcessPayload`). Producers: ingestion (after registration) and
`POST /media/evidence/:id/reprocess` (force).

```
original (evidence/archive/longterm bucket, object-locked; read ONLY via an internal presigned URL)
  ├─ PROXY_MP4  evidence/<id>/proxy/proxy.mp4
  └─ HLS        evidence/<id>/hls/master.m3u8, <rung>/index.m3u8, <rung>/seg_NNNNN.ts
proxy (local temp copy under WORK_DIR)
  ├─ POSTER     evidence/<id>/poster/poster.jpg          (frame at 10 % of duration, proxy resolution)
  ├─ THUMBNAIL  evidence/<id>/thumbnail/thumb.jpg        (320 px wide)
  └─ SPRITE     evidence/<id>/sprite/sprite_NNN.jpg      (10x10 tiles, 160 px wide each)
                evidence/<id>/sprite/thumbnails.vtt      (kind SPRITE, mime text/vtt, `#xywh=` cues)
user snapshots  evidence/<id>/snapshot/<uuid>.png        (kind SNAPSHOT, extracted by the worker job media.snapshot)
```

All outputs go to the **derived** bucket and get one `evidence_derivatives` row each (kind, bucket, key,
mime, size, sha256, width/height, meta). HLS has ONE row whose `object_key` is the prefix
`evidence/<id>/hls/`; `meta.renditions` lists `{name,width,height,maxrateKbps,playlist,segments,bytes}`.
Sprite sheets have one row each (`meta.role='sheet'`, index, interval, tile geometry); the VTT is a SPRITE
row with `meta.role='vtt'`.

### Encoding parameters
| Output | Parameters |
|---|---|
| Proxy | libx264 `-preset veryfast -crf 23`, yuv420p, `fps=<rate>` (CFR), `-g N -keyint_min N -sc_threshold 0` with N = floor(fps) (keyframe interval always <= 1 s; 29.97 fps -> 29), AAC (source sample rate kept when AAC-legal, 64k mono / 128k stereo, >2 ch downmixed), `+faststart`. Long side <= 1280 (landscape: max 1280 wide; portrait: max 1280 tall), never upscaled, rotation and non-square SAR applied. |
| HLS | one FFmpeg pass from the original: `fps` + `split` + per-rung scale; rungs by short side 360p, 720p (if source >= 720), 1080p (if source >= 1080, capped: 4K sources top out at 1080p). Capped CRF 23 (`maxrate` 900k / 3000k / 6000k, bufsize 2x), same GOP as the proxy, `-hls_time 4 -hls_playlist_type vod -hls_flags independent_segments`, MPEG-TS segments, `master.m3u8`. A source smaller than 360p gets one native rung named by its short side (e.g. `240p`). |
| Poster / thumbnail | JPEG from the proxy at 10 % of duration. |
| Sprite | `-skip_frame nokey` on the proxy (keyframes every <= 1 s) + `fps=1/I,scale=160:h,tile=10x10`; interval I = max(1, ceil(duration / 1000 tiles)) s — 20 min -> 2 s, 600 tiles, 6 sheets. |

**VFR handling.** A source is VFR when `r_frame_rate` and `avg_frame_rate` differ by > 2 %. VFR sources are
resampled to CFR at the average rate (3 decimals, cap 60 fps) — frames are duplicated/dropped by the `fps`
filter so that frame numbers in the proxy are well defined. `meta.sourceVfr=true` is recorded and shown in the
UI. Timestamps (not frame numbers) are the authoritative link back to the original for VFR material.

### Status, idempotency, failures
* `media_status`: PENDING -> PROCESSING -> READY | FAILED | UNSUPPORTED; `processing_jobs` row kind
  `MEDIA_PROCESS` (progress: proxy 2–45 %, HLS 45–88 %, stills 90 %, sprite 90–98 %).
* Audit (custody, `evidenceId` set, actor `SYSTEM media-worker`): `MEDIA_PROCESSING_STARTED`,
  `MEDIA_PROCESSING_COMPLETED` (kinds, renditions, per-phase timings), `MEDIA_PROCESSING_FAILED`.
* One pipeline per evidence item (Postgres session advisory lock on `media:<id>`; a concurrent job throws a
  retryable error). READY items are skipped unless `force`. A first build writes to
  `evidence/<id>/{proxy,hls,poster,thumbnail,sprite}/` (stale objects of a crashed first attempt are removed
  first). **A rebuild (FN-7)** writes the new set under a generation prefix `evidence/<id>/r<gen>/<kind-dir>/…`
  while the old set stays playable (media_status stays READY), switches rows in one transaction (old rows deleted,
  new rows inserted, `MEDIA_PROCESSING_COMPLETED` with `rebuild`, `generation`, `replaced`), and only then deletes the
  old objects. A failed rebuild deletes its own generation and keeps the old derivatives (READY, `media_error`
  "Reprocessing failed … previous derivatives kept"). SNAPSHOT rows/objects are never touched.
* **UNSUPPORTED** (no retry): container unreadable while the object exists (garbled / truncated MP4 without
  moov), no video stream (audio-only, cover-art only), undecodable stream (FFmpeg stderr patterns in
  `plan.ts#looksUndecodable`). `media_error` holds the reason.
* **Transient** (thrown -> pg-boss retry with backoff, `retryLimit` 3): object unreachable, network/S3 errors,
  timeouts. Intermediate attempts leave `media_status=PENDING` with "will retry" in `media_error`; the final
  attempt sets `FAILED`.
* Timeouts are proportional to duration: `120 s + factor x duration` (proxy 4x, HLS 6x, sprite 1x).
* Temp files live in `WORK_DIR/media-<id>-<rand>/` and are always removed. The original is never written;
  tests assert its SHA-256 is unchanged after processing.

### Profiles (MEDIA_PROFILE) {#profiles}

The HLS ladder is ~73 % of the transcoding CPU (see the capacity table in
[INFRASTRUCTURE.md](INFRASTRUCTURE.md#transcoding-capacity)), so the deployment chooses (EXT-9):

| `MEDIA_PROFILE` | At ingest | Playback |
|---|---|---|
| `full` (default) | proxy MP4 + HLS ladder + poster/thumbnail + sprites | HLS (adaptive) or proxy MP4 |
| `proxy-only` | proxy MP4 + poster/thumbnail + sprites | proxy MP4 with HTTP Range (seeking, frame stepping, snapshots and sync-play all work on the MP4) |
| `on-demand-hls` | as `proxy-only` | the first `GET /media/evidence/:id/playback` of a READY item without HLS enqueues `media.hls` and answers `hlsStatus: "PREPARING"` (the MP4 plays at once; the player shows "Preparing adaptive stream…"); the worker's `buildHlsOnDemand` builds the ladder from the original under a fresh generation prefix `evidence/<id>/h<gen>/hls/`, inserts the HLS row (`meta.onDemand=true`) and audits `MEDIA_PROCESSING_STARTED/COMPLETED` (`onDemand: true`); later playbacks get `hlsStatus: "READY"` + `hlsUrl`. The request is a custody event `MEDIA_STREAM_REQUESTED` (once per request window: a request in the last 2 h without a job row counts as queued). A failed build answers `FAILED` for an hour, then a playback re-queues it. `processing_jobs.kind = MEDIA_HLS`. Idempotent (existing HLS → SKIPPED) and race-safe (row insert under `FOR UPDATE`; a loser deletes its objects). |

`GET /media/evidence/:id/playback` returns `mediaProfile` and `hlsStatus` (`READY` / `PREPARING` / `FAILED` /
`NOT_BUILT`). Switching profile affects new ingests; existing HLS derivatives stay.

### Encoders (MEDIA_ENCODER) {#encoders}

`libx264` (default) or a hardware H.264 encoder: `h264_nvenc` (NVIDIA), `h264_qsv` (Intel Quick Sync), `h264_vaapi`
(VA-API, device `MEDIA_HW_DEVICE`, default `/dev/dri/renderD128`). The worker probes the choice once per process
(`apps/worker/src/jobs/media/encoder.ts`): the encoder must be listed by `ffmpeg -encoders` **and** a two-frame test
encode on the device must succeed; otherwise it falls back to libx264 and logs the reason (warn). Output settings are
kept equivalent: CFR, GOP = floor(fps) (keyframe ≤ 1 s), no scene-cut keyframes, no B-frames on hardware encoders,
~CRF 23 constant quality (`-cq 23` / `-global_quality 23` / `-qp 23`), nv12 + `hwupload` for VA-API. Proxy metadata
records `encoder` and `encoderFallback`; `MEDIA_PROCESSING_COMPLETED` records `encoder` and `mediaProfile`.
**UNVERIFIED on real GPUs**: the development host's FFmpeg has no NVENC/QSV/VA-API encoders — only the probe, the
fallback and the argument sets are tested (`apps/api/test/media-profiles.test.ts`). The static FFmpeg in the worker
image (`mwader/static-ffmpeg`) has no hardware encoders either; a GPU worker image needs an FFmpeg build with them.

### Measured processing time (this dev host, shared with other agents' workloads)
| Fixture | Duration | Wall time |
|---|---|---|
| H.264/AAC 640x360 25 fps | 6.0 s | 0.6–2.1 s |
| HEVC MKV 320x240 | 3.0 s | 0.3–0.8 s |
| MJPEG AVI 320x240 | 3.0 s | 0.3–0.7 s |
| Portrait 360x640 | 3.0 s | 0.4–1.2 s |
| 1080p (3 HLS rungs) | 2.0 s | 1.2–2.7 s |
| VFR 30->15 fps | 6.0 s | 0.2–0.7 s |
| 160x90 5 fps "huge duration" | 20 min | 18–30 s (e.g. proxy 8.5 s, HLS 9.1 s, sprite 0.4 s) |

Ranges reflect host load. A 5-minute 1080p30 benchmark (`npm run media:benchmark -w @ksp/worker -- --file <clip>`,
2026-09-27) is in [INFRASTRUCTURE.md § Transcoding capacity](INFRASTRUCTURE.md#transcoding-capacity): proxy 1.2–1.9
CPU-s and HLS ladder 3.2–5.0 CPU-s per footage-second with libx264 on this host. Real body-camera footage was not
available — synthetic clips bracket it (clean `testsrc2` vs. with heavy temporal noise).

## 2. API (`/api/v1/media`)

Storage URLs are never returned. Browser media requests carry `?t=<media token>` (HMAC, core
`signMediaToken`), bound to one evidence item and one scope.

| Route | Auth | Result |
|---|---|---|
| `GET /evidence/:id/playback` | session + `loadEvidenceFor('evidence:play')` | `{evidenceId, mediaStatus, mediaError, progress, durationMs, frameRate (proxy CFR), sourceFrameRate, sourceVfr, width, height (proxy), sourceWidth, sourceHeight, renditions[], hlsUrl, mp4Url, posterUrl, thumbnailUrl, spriteVttUrl, expiresAt}`. URLs `/api/v1/media/stream/<id>/<rel>?t=<USER/stream token>` (TTL `MEDIA_TOKEN_TTL_SECONDS`, default 300 s). |
| `GET /stream/:evidenceId/*` | public; token scope `stream`, `eid` = path id | Derived object with single-range support (206, `Content-Range`, `Accept-Ranges`, 416), `Cache-Control: private, no-store`. `.m3u8` rewritten so every URI carries the token; `thumbnails.vtt` rewritten to `sprite_NNN.jpg?t=…#xywh=…`. Only keys `evidence/<id>/…` that equal a PROXY/POSTER/THUMBNAIL/SPRITE object key or are playlists/segments under the HLS prefix; strict path regex, `..` rejected. |
| `GET /image/:derivativeId?t=` | public; token scope `image`, `ref` = derivativeId, `eid` = derivative's evidence | THUMBNAIL/POSTER/SNAPSHOT/SPRITE/AI_FRAME/AI_CROP images; `&download=1` adds `Content-Disposition: attachment`. Token shape used by the evidence list: `signMediaToken({typ:'USER', sub, sid, eid, scope:'image', ref})`. |
| `GET /evidence/:id/original` | `loadEvidenceFor('evidence:download_original')` | `{url:/api/v1/media/download/<id>?t=…, expiresAt, filename, sha256, sizeBytes}` (60 s token, scope `download`). |
| `GET /download/:evidenceId?t=` | public; token scope `download` | Streams the ORIGINAL (bucket/key/**version**) as `application/octet-stream`, `Content-Disposition: attachment; filename="<evidenceNumber>_<original>"`, `X-Evidence-SHA256`, Range. Custody `EVIDENCE_DOWNLOADED` (sha256, size, range, tier). |
| `POST /evidence/:id/snapshots` `{timeMs, source:'proxy'\|'original'}` | `evidence:snapshot` | The API validates, stores a `snapshot_requests` row (source object, frame, fps, actor) and queues **`media.snapshot`**; FFmpeg runs in the worker (FN-8). The API waits up to `SNAPSHOT_WAIT_SECONDS` (default 20): 201 snapshot `{id, timeMs, frameNumber, frameTimeMs, fps, source, sha256, width, height, sizeBytes, createdAt, createdBy, url, downloadUrl}`; custody `EVIDENCE_SNAPSHOT_CREATED` (actor = requester, written by the job with the derivative); otherwise **202** `{requestId, statusUrl}` (the web client polls). 409 if media not ready, 422 beyond the end or undecodable. |
| `GET /snapshot-requests/:id` | requester + `evidence:snapshot` | `{status QUEUED\|RUNNING\|COMPLETED\|FAILED, error, snapshot}` |
| `GET /evidence/:id/snapshots` | `evidence:play` | `{items: Snapshot[], total}` with 15-min image tokens. |
| `POST /evidence/:id/reprocess` `{reason?}` | `evidence:edit_metadata` (jurisdiction) or `system:monitor` (system-wide) | 202 `{queued, jobId}`; **409** while a MEDIA_PROCESS job is queued/running or media_status is PROCESSING (checked under a per-item advisory lock; the job is tracked in `processing_jobs` from enqueue); items without derivatives go to PENDING, processed items stay READY until replaced; custody `MEDIA_REPROCESS_REQUESTED`. |

Token checks: missing/invalid/tampered/expired -> 401; valid token for another evidence item, scope or
ref -> 403; USER tokens re-check on EVERY request that the issuing session is not revoked/expired and the
user is ACTIVE (-> 401); SHARE tokens (`sub` = share id) require an ACTIVE unexpired share containing the
item, and `allow_download` for downloads. Out-of-jurisdiction on session routes -> 404 (`loadEvidenceFor`).

**EVIDENCE_PLAYED throttling.** Written when the playback endpoint issues stream URLs, at most once per user
+ evidence item per 10 minutes (`PLAY_AUDIT_WINDOW_MINUTES`). The player refreshes its token every ~4 min;
without throttling each refresh would add a custody event. A new viewing session after 10 idle minutes is
recorded again.

**Download audit.** One `EVIDENCE_DOWNLOADED` per download: requests without `Range` or with a range starting
at byte 0 are audited; continuation ranges of the same download are not.

**Exact-frame snapshots.** Frame n occupies [n/fps, (n+1)/fps); the frame at time t is floor(t*fps + 1e-6).
FFmpeg input-seeks (accurate seek) to (n - 0.5)/fps and takes the first decoded frame, which is therefore
frame n regardless of keyframe position or timestamp rounding; output is lossless PNG. Tests compare the
snapshot's decoded RGB (MD5) with an FFmpeg `select=eq(n,N)` reference frame for non-keyframes on both the
proxy and the original and assert the neighbouring frames differ. For `source:'original'` the evidence's
nominal frame rate is used; for VFR originals the frame number is nominal.

## 3. Web (`apps/web/src/modules/video`)

* `EvidencePlayer` (exported from `modules/video/index.ts`): props `{evidenceId, onTimeUpdate?, onReady?,
  overlays?, markers?, initialTimeMs?, hideControls?, muted?, maxHeight?, className?}`; ref
  `{seek(ms), play(), pause(), setRate(r), getTime(), stepFrame(n), getDuration(), getFrameRate(), isPaused()}`.
  `overlays` render in an `absolute inset-0` box that exactly covers the video frame INSIDE the zoom/pan
  layer — position children in percentages or an `<svg viewBox="0 0 1 1" preserveAspectRatio="none">`.
  Sources: hls.js (every request re-signed with the current token in `xhrSetup`), native HLS on Safari, or
  proxy MP4 (selector). Token refresh ~60 s before expiry; native/MP4 sources swap `src` and restore time,
  rate and play state. States: loading, processing (polls every 3 s, progress bar), FAILED, UNSUPPORTED,
  playback error (retry / switch to MP4).
  Controls & shortcuts: Space/K play-pause, ←/→ frame, Shift+←/→ ±5 s, `[`/`]` rate (0.1–2x), `+`/`-` zoom
  (1–8x, also wheel at cursor, drag to pan), `0` reset, `S` snapshot (exact current time), `F` fullscreen,
  `?` help. Seek bar shows sprite previews (parsed VTT) and clickable markers; timecode `mm:ss.mmm` + frame.
* `SyncPlayer` `{items: [{evidenceId, offsetMs, label}], onOffsetsChange?}`: 1–4 players in a grid, wall-
  clock master timeline (item local time = master − offset), shared play/pause/seek/frame-step/rate,
  per-item offset ±1 frame / ±100 ms, drift check every 250 ms, re-seek when |drift| > 1 frame (1 s
  cool-down per item).
* Evidence page contributions: tabs "Playback" (order 10; honours `?t=<ms>`) and "Snapshots" (order 20);
  actions "Download original" (shown only when `evidence.permissions.canDownloadOriginal === true`) and
  "Reprocess media" (reason required). Route `/evidence/:id/player?t=<ms>` (full page, copyable deep link).

## 4. Verification status
* Worker tests (real FFmpeg/S3/Postgres) and API tests: see the test files; all green at commit time.
* Browser smoke (headless Google Chrome via CDP against the dev API + Vite, UNAUTOMATED — script not
  committed): HLS playback through hls.js, `?t=` initial seek, frame stepping (F numbers), zoom, sprite hover
  preview, `S` snapshot, playback continuing after the stream token expired (TTL 75 s, seek to 10:00 then
  play), MP4 source switch keeping position and src swap on token rotation keeping position; SyncPlayer via
  a temporary route (2 items, offsets 0/500 ms: measured delta 495–500 ms while playing, +100 ms offset
  adjust, shared frame step, item parked at its end when shorter). Safari/iOS native HLS, mouse-driven
  drag-pan/wheel zoom and fullscreen: **UNVERIFIED** in a browser.

## 5. Known issues / follow-ups
* HLS segments are MPEG-TS; fMP4/CMAF would allow sharing segments with DASH — not needed now.
* After a rebuild switch the old proxy is deleted at once; an AI job that is reading it at that moment fails and
  must be re-requested. A future FK from AI tables to `evidence_derivatives` would block the row delete — AI
  results should reference derivatives by key/meta or use ON DELETE SET NULL.
* Snapshot extraction runs inside the API process (bounded by a 90 s FFmpeg timeout and a 60/min rate limit);
  move to a worker queue if snapshot load grows.
* Share (external) playback uses the same `/stream` endpoint with `typ:'SHARE'` tokens. Watermark burn-in is done
  by the sharing module (worker queue `share.watermark`, one watermarked MP4 per share + evidence); see
  [SECURE-SHARING.md](SECURE-SHARING.md).
