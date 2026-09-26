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
user snapshots  evidence/<id>/snapshot/<uuid>.png        (kind SNAPSHOT, created by the API)
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
  retryable error). READY items are skipped unless `force`. Every non-skipped run first removes the pipeline
  derivatives (rows of kinds PROXY_MP4/HLS/POSTER/THUMBNAIL/SPRITE and objects under
  `evidence/<id>/{proxy,hls,poster,thumbnail,sprite}/` in the derived bucket only). SNAPSHOT rows/objects are
  never touched. On failure partial outputs are removed again.
* **UNSUPPORTED** (no retry): container unreadable while the object exists (garbled / truncated MP4 without
  moov), no video stream (audio-only, cover-art only), undecodable stream (FFmpeg stderr patterns in
  `plan.ts#looksUndecodable`). `media_error` holds the reason.
* **Transient** (thrown -> pg-boss retry with backoff, `retryLimit` 3): object unreachable, network/S3 errors,
  timeouts. Intermediate attempts leave `media_status=PENDING` with "will retry" in `media_error`; the final
  attempt sets `FAILED`.
* Timeouts are proportional to duration: `120 s + factor x duration` (proxy 4x, HLS 6x, sprite 1x).
* Temp files live in `WORK_DIR/media-<id>-<rand>/` and are always removed. The original is never written;
  tests assert its SHA-256 is unchanged after processing.

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

Ranges reflect host load. Real body-camera footage (1080p30, 20–60 min) is dominated by x264 time; plan
roughly 3–6x faster than real time per worker at `WORKER_CONCURRENCY=2` on 4 cores — **UNVERIFIED** (no
real-resolution long clip was benchmarked).

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
| `POST /evidence/:id/snapshots` `{timeMs, source:'proxy'\|'original'}` | `evidence:snapshot` | 201 snapshot `{id, timeMs, frameNumber, frameTimeMs, fps, source, sha256, width, height, sizeBytes, createdAt, createdBy, url, downloadUrl}`; custody `EVIDENCE_SNAPSHOT_CREATED`. 409 if media not ready, 422 beyond the end. |
| `GET /evidence/:id/snapshots` | `evidence:play` | `{items: Snapshot[], total}` with 15-min image tokens. |
| `POST /evidence/:id/reprocess` `{reason?}` | `evidence:edit_metadata` (jurisdiction) or `system:monitor` (system-wide) | 202 `{queued, jobId}`; sets PENDING; custody `MEDIA_REPROCESS_REQUESTED`. |

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
* Reprocessing deletes the old derivatives before the new ones exist (playback unavailable while
  re-processing). A future FK from AI tables to `evidence_derivatives` would block the delete — AI results
  should reference derivatives by key/meta or use ON DELETE SET NULL.
* Snapshot extraction runs inside the API process (bounded by a 90 s FFmpeg timeout and a 60/min rate limit);
  move to a worker queue if snapshot load grows.
* Share (external) playback uses the same `/stream` endpoint with `typ:'SHARE'` tokens. Watermark burn-in is done
  by the sharing module (worker queue `share.watermark`, one watermarked MP4 per share + evidence); see
  [SECURE-SHARING.md](SECURE-SHARING.md).
