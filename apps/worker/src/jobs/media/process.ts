/**
 * MEDIA_PROCESS: build playback/analysis derivatives for a registered evidence item.
 *
 *   original (evidence bucket, object-locked, read-only via an INTERNAL presigned URL)
 *     ├─► PROXY_MP4  evidence/<id>/proxy/proxy.mp4            H.264/AAC, CFR, GOP <= 1 s, +faststart, long side <= 1280
 *     └─► HLS        evidence/<id>/hls/master.m3u8 + <rung>/index.m3u8 + <rung>/seg_NNNNN.ts
 *   proxy (local temp file)
 *     ├─► POSTER     evidence/<id>/poster/poster.jpg          frame at ~10 % of duration
 *     ├─► THUMBNAIL  evidence/<id>/thumbnail/thumb.jpg        320 px wide
 *     └─► SPRITE     evidence/<id>/sprite/sprite_NNN.jpg (10x10 tiles, 160 px) + evidence/<id>/sprite/thumbnails.vtt
 *
 * The original is never written to. Idempotent: pipeline derivatives are rebuilt from scratch on every
 * non-skipped run (a READY item is skipped unless `force`). User-created SNAPSHOT derivatives are never
 * touched. See docs/VIDEO-PIPELINE.md.
 */
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { sql } from 'kysely';
import type { Logger } from 'pino';
import { appendAudit, ffmpeg, MEDIA_FORMAT_WHITELIST, MediaError, probe, systemActor, type AppConfig, type Database, type ProbeResult, type Storage } from '@ksp/core';
import type { MediaProcessPayload } from '@ksp/shared';
import { ProcessingTracker } from '../../lib/processing.js';
import {
  analyseSource,
  buildSpriteVtt,
  fitLongSide,
  fitWidth,
  HLS_SEGMENT_SECONDS,
  looksUndecodable,
  planLadder,
  planRate,
  planSprite,
  PROXY_MAX_LONG_SIDE,
  spriteSheetName,
  THUMB_WIDTH,
  timeoutFor,
  type SourceInfo,
} from './plan.js';

export const PIPELINE_KINDS = ['PROXY_MP4', 'HLS', 'POSTER', 'THUMBNAIL', 'SPRITE'] as const;
const PIPELINE_DIRS = ['proxy', 'hls', 'poster', 'thumbnail', 'sprite'];
const ACTOR = systemActor('media-worker');

export interface MediaDeps {
  db: Database;
  storage: Storage;
  cfg: AppConfig;
  log: Logger;
}
export interface MediaJobMeta {
  queueJobId?: string;
  /** true when pg-boss will not retry this job again (last attempt). */
  finalAttempt?: boolean;
}
export type MediaOutcome =
  | { status: 'READY'; derivatives: number; elapsedMs: number; durationMs: number; phases: Record<string, number> }
  | { status: 'SKIPPED'; reason: string }
  | { status: 'UNSUPPORTED'; error: string };

/** Transient failure: rethrown so pg-boss retries with backoff. */
export class RetryableMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableMediaError';
  }
}
class UnsupportedMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedMediaError';
  }
}

export async function processMedia(deps: MediaDeps, payload: MediaProcessPayload, meta: MediaJobMeta = {}): Promise<MediaOutcome> {
  const { db } = deps;
  const { evidenceId } = payload;
  if (!/^[0-9a-f-]{36}$/i.test(evidenceId)) return { status: 'SKIPPED', reason: 'invalid evidence id' };
  // One pipeline per evidence item at a time (session advisory lock on a dedicated connection).
  return db.connection().execute(async (conn) => {
    const key = `media:${evidenceId}`;
    const { rows } = await sql<{ ok: boolean }>`SELECT pg_try_advisory_lock(hashtextextended(${key}, 0)) AS ok`.execute(conn);
    if (!rows[0]?.ok) throw new RetryableMediaError(`media processing already running for ${evidenceId}`);
    try {
      return await runLocked(deps, payload, meta);
    } finally {
      await sql`SELECT pg_advisory_unlock(hashtextextended(${key}, 0))`.execute(conn);
    }
  });
}

async function runLocked(deps: MediaDeps, payload: MediaProcessPayload, meta: MediaJobMeta): Promise<MediaOutcome> {
  const { db, storage, cfg, log } = deps;
  const { evidenceId, force = false } = payload;
  const ev = await db
    .selectFrom('evidence')
    .select(['id', 'status', 'org_unit_id', 'media_status', 'storage_bucket', 'storage_key', 'storage_version_id', 'duration_ms'])
    .where('id', '=', evidenceId)
    .executeTakeFirst();
  if (!ev) return { status: 'SKIPPED', reason: 'evidence not found' };
  if (!['REGISTERED', 'DISPOSAL_PENDING'].includes(ev.status) || !ev.storage_bucket || !ev.storage_key) {
    return { status: 'SKIPPED', reason: `evidence status ${ev.status}` };
  }
  if (!force && ev.media_status === 'READY') {
    const proxy = await db.selectFrom('evidence_derivatives').select('id').where('evidence_id', '=', evidenceId).where('kind', '=', 'PROXY_MP4').executeTakeFirst();
    if (proxy) return { status: 'SKIPPED', reason: 'already processed' };
  }

  const tracker = await ProcessingTracker.start(db, { kind: 'MEDIA_PROCESS', evidenceId, queueJobId: meta.queueJobId });
  const started = Date.now();
  await db.transaction().execute(async (tx) => {
    await tx.updateTable('evidence').set({ media_status: 'PROCESSING', media_error: null }).where('id', '=', evidenceId).execute();
    await appendAudit(tx, ACTOR, { action: 'MEDIA_PROCESSING_STARTED', resourceType: 'evidence', resourceId: evidenceId, evidenceId, orgUnitId: ev.org_unit_id, details: { force, processingJobId: tracker.id } });
  });

  const work = join(cfg.WORK_DIR, `media-${evidenceId}-${randomUUID().slice(0, 8)}`);
  try {
    await mkdir(work, { recursive: true });
    await clearPipelineDerivatives(deps, evidenceId);

    const expectedMs = Number(ev.duration_ms ?? 0);
    const url = await storage.internalUrl(ev.storage_bucket, ev.storage_key, Math.min(7 * 86400, Math.max(3600, Math.ceil(timeoutFor(expectedMs, 12) / 1000))), ev.storage_version_id ?? undefined);

    let probed: ProbeResult;
    try {
      probed = await probe(url, 120_000);
    } catch (err) {
      // Distinguish "object unreachable" (transient) from "not a media file".
      if (!(await storage.head(ev.storage_bucket, ev.storage_key).catch(() => null))) throw new RetryableMediaError(`original not reachable: ${(err as Error).message}`);
      throw new UnsupportedMediaError(`Could not read media container: ${firstLine((err as Error).message)}`);
    }
    const src = analyseSource(probed, expectedMs);
    if (!src) throw new UnsupportedMediaError('No decodable video stream (audio-only or data file)');
    if (!src.durationMs) throw new UnsupportedMediaError('Media duration could not be determined');

    const rate = planRate(src);
    const outputs: DerivativeRow[] = [];
    const progress = (base: number, span: number) => (f: number) => void tracker.progress(base + span * f).catch(() => undefined);

    const phases: Record<string, number> = {};
    let mark = Date.now();
    const phase = (name: string) => {
      phases[name] = Date.now() - mark;
      mark = Date.now();
    };
    // 1. Proxy MP4 (from the original)
    const proxyPath = join(work, 'proxy.mp4');
    const pdim = fitLongSide(src.displayWidth, src.displayHeight, PROXY_MAX_LONG_SIDE);
    await runFfmpeg(proxyArgs(url, src, rate, pdim, proxyPath), src.durationMs, 4, progress(0.02, 0.43));
    const proxyProbe = await probe(proxyPath);
    const proxyDur = Math.round(Number(proxyProbe.format.duration ?? src.durationMs / 1000) * 1000);
    outputs.push(await uploadFile(deps, evidenceId, proxyPath, 'proxy/proxy.mp4', 'PROXY_MP4', 'video/mp4', pdim, {
      fps: rate.fps, rate: rate.rate, gop: rate.gop, keyframeIntervalSec: rate.gop / rate.fps, crf: 23, preset: 'veryfast', videoCodec: 'h264', pixFmt: 'yuv420p',
      audio: !!src.audio, faststart: true, durationMs: proxyDur, sourceVfr: src.vfr, sourceFps: src.rFps, sourceAvgFps: src.avgFps, rotation: src.rotation,
    }));

    phase('proxyMs');
    // 2. HLS ladder (from the original, so the 1080p rung is not limited by the proxy resolution)
    const hlsDir = join(work, 'hls');
    const ladder = planLadder(src);
    for (const r of ladder) await mkdir(join(hlsDir, r.name), { recursive: true });
    await runFfmpeg(hlsArgs(url, src, rate, ladder, hlsDir), src.durationMs, 6, progress(0.45, 0.43));
    outputs.push(await uploadHls(deps, evidenceId, hlsDir, ladder, rate));

    phase('hlsMs');
    // 3. Poster + thumbnail (from the proxy)
    const at = Math.max(0, (proxyDur * 0.1) / 1000);
    const posterPath = join(work, 'poster.jpg');
    await runFfmpeg(['-ss', at.toFixed(3), '-i', proxyPath, '-frames:v', '1', '-q:v', '2', posterPath], 0, 0);
    outputs.push(await uploadFile(deps, evidenceId, posterPath, 'poster/poster.jpg', 'POSTER', 'image/jpeg', pdim, { timeMs: Math.round(at * 1000) }));
    const tdim = fitWidth(pdim.width, pdim.height, THUMB_WIDTH);
    const thumbPath = join(work, 'thumb.jpg');
    await runFfmpeg(['-ss', at.toFixed(3), '-i', proxyPath, '-frames:v', '1', '-vf', `scale=${tdim.width}:${tdim.height}`, '-q:v', '3', thumbPath], 0, 0);
    outputs.push(await uploadFile(deps, evidenceId, thumbPath, 'thumbnail/thumb.jpg', 'THUMBNAIL', 'image/jpeg', tdim, { timeMs: Math.round(at * 1000) }));
    await tracker.progress(0.9);
    phase('stillsMs');

    // 4. Sprite sheets + WebVTT thumbnail track (keyframes only: the proxy has one every <= 1 s)
    const sp = planSprite(proxyDur, pdim.width, pdim.height);
    const spriteDir = join(work, 'sprite');
    await mkdir(spriteDir, { recursive: true });
    await runFfmpeg(
      ['-skip_frame', 'nokey', '-i', proxyPath, '-an', '-vf', `fps=1/${sp.intervalSec}:round=near,scale=${sp.tileWidth}:${sp.tileHeight},tile=${sp.columns}x${sp.rows}`, '-fps_mode', 'passthrough', '-q:v', '5', '-start_number', '0', join(spriteDir, 'sprite_%03d.jpg')],
      proxyDur, 1, progress(0.9, 0.08),
    );
    const sheets = (await readdir(spriteDir)).filter((f) => /^sprite_\d{3}\.jpg$/.test(f)).sort();
    if (!sheets.length) throw new UnsupportedMediaError('No frames could be decoded for the sprite sheet');
    for (let i = 0; i < sheets.length; i++) {
      outputs.push(await uploadFile(deps, evidenceId, join(spriteDir, spriteSheetName(i)), `sprite/${spriteSheetName(i)}`, 'SPRITE', 'image/jpeg',
        { width: sp.tileWidth * sp.columns, height: sp.tileHeight * sp.rows }, { role: 'sheet', index: i, ...spriteMeta(sp) }));
    }
    const vttPath = join(spriteDir, 'thumbnails.vtt');
    await writeFile(vttPath, buildSpriteVtt(sp, proxyDur, sheets.length));
    outputs.push(await uploadFile(deps, evidenceId, vttPath, 'sprite/thumbnails.vtt', 'SPRITE', 'text/vtt', null, { role: 'vtt', sheets: sheets.length, ...spriteMeta(sp) }));

    phase('spriteMs');
    const elapsedMs = Date.now() - started;
    await db.transaction().execute(async (tx) => {
      await tx.insertInto('evidence_derivatives').values(outputs.map((o) => ({ ...o, evidence_id: evidenceId, meta: JSON.stringify(o.meta) }))).execute();
      await tx.updateTable('evidence').set({ media_status: 'READY', media_error: null }).where('id', '=', evidenceId).execute();
      await appendAudit(tx, ACTOR, {
        action: 'MEDIA_PROCESSING_COMPLETED', resourceType: 'evidence', resourceId: evidenceId, evidenceId, orgUnitId: ev.org_unit_id,
        details: { force, derivatives: outputs.length, kinds: [...new Set(outputs.map((o) => o.kind))], durationMs: proxyDur, elapsedMs, renditions: ladder.map((r) => r.name), phases, processingJobId: tracker.id },
      });
    });
    await tracker.complete({ derivatives: outputs.length, elapsedMs, durationMs: proxyDur, phases, realtimeFactor: Math.round((proxyDur / Math.max(1, elapsedMs)) * 100) / 100 });
    log.info({ evidenceId, elapsedMs, durationMs: proxyDur }, 'media processed');
    return { status: 'READY', derivatives: outputs.length, elapsedMs, durationMs: proxyDur, phases };
  } catch (err) {
    await clearPipelineDerivatives(deps, evidenceId).catch(() => undefined);
    const unsupported = err instanceof UnsupportedMediaError;
    const message = (err as Error).message.slice(0, 2000);
    const final = unsupported || !!meta.finalAttempt;
    const status = unsupported ? 'UNSUPPORTED' : final ? 'FAILED' : 'PENDING';
    await db.transaction().execute(async (tx) => {
      await tx.updateTable('evidence').set({ media_status: status, media_error: final ? message : `Processing attempt failed, will retry: ${message}`.slice(0, 2000) }).where('id', '=', evidenceId).execute();
      await appendAudit(tx, ACTOR, {
        action: 'MEDIA_PROCESSING_FAILED', outcome: 'FAILURE', resourceType: 'evidence', resourceId: evidenceId, evidenceId, orgUnitId: ev.org_unit_id,
        details: { force, unsupported, final, error: message.slice(0, 500), processingJobId: tracker.id },
      });
    });
    await tracker.fail(err);
    if (unsupported) {
      log.warn({ evidenceId, err: message }, 'media unsupported');
      return { status: 'UNSUPPORTED', error: message };
    }
    log.error({ evidenceId, err: message, final }, 'media processing failed');
    throw err;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

function spriteMeta(sp: ReturnType<typeof planSprite>) {
  return { intervalSec: sp.intervalSec, tileWidth: sp.tileWidth, tileHeight: sp.tileHeight, columns: sp.columns, rows: sp.rows, tiles: sp.tiles };
}

function firstLine(s: string): string {
  return s.split('\n').map((l) => l.trim()).filter(Boolean).slice(-1)[0]?.slice(0, 300) ?? 'unknown error';
}

// ---------------------------------------------------------------------------------------------
const HTTP_IN = ['-reconnect', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '10'];
const inputArgs = (url: string) => [...(/^https?:/.test(url) ? HTTP_IN : []), '-format_whitelist', MEDIA_FORMAT_WHITELIST, '-i', url];

function audioArgs(src: SourceInfo): string[] {
  if (!src.audio) return [];
  // Keep the source sample rate when AAC supports it (resampling long low-rate body-cam audio to 48 kHz
  // dominated processing time); downmix only above stereo.
  const ch = src.audio.channels ?? 2;
  const sr = Number(src.audio.sample_rate ?? 0);
  const keepRate = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000].includes(sr);
  const outCh = ch > 2 || ch < 1 ? 2 : ch;
  return ['-c:a', 'aac', '-b:a', outCh === 1 ? '64k' : '128k', ...(keepRate ? [] : ['-ar', '48000']), ...(outCh !== ch ? ['-ac', '2'] : [])];
}

const x264 = (gop: number) => ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0'];

export function proxyArgs(url: string, src: SourceInfo, rate: { rate: string; gop: number }, dim: { width: number; height: number }, out: string): string[] {
  return [
    ...inputArgs(url),
    '-map', '0:v:0', ...(src.audio ? ['-map', '0:a:0'] : []), '-sn', '-dn',
    '-vf', `fps=${rate.rate},scale=${dim.width}:${dim.height}:flags=bicubic,setsar=1,format=yuv420p`,
    ...x264(rate.gop), ...audioArgs(src),
    '-movflags', '+faststart', '-max_muxing_queue_size', '4096', out,
  ];
}

export function hlsArgs(url: string, src: SourceInfo, rate: { rate: string; gop: number }, ladder: ReturnType<typeof planLadder>, dir: string): string[] {
  const n = ladder.length;
  const labels = ladder.map((_, i) => `[s${i}]`).join('');
  const chains = ladder.map((r, i) => `[s${i}]scale=${r.width}:${r.height}:flags=bicubic,setsar=1,format=yuv420p[v${i}]`).join(';');
  const graph = `[0:v:0]fps=${rate.rate},split=${n}${labels};${chains}`;
  const maps = ladder.flatMap((_, i) => ['-map', `[v${i}]`, ...(src.audio ? ['-map', '0:a:0'] : [])]);
  const rates = ladder.flatMap((r, i) => [`-maxrate:v:${i}`, `${r.maxrateKbps}k`, `-bufsize:v:${i}`, `${r.maxrateKbps * 2}k`]);
  const varMap = ladder.map((r, i) => (src.audio ? `v:${i},a:${i},name:${r.name}` : `v:${i},name:${r.name}`)).join(' ');
  return [
    ...inputArgs(url), '-filter_complex', graph, ...maps, ...x264(rate.gop), ...rates, ...audioArgs(src),
    '-f', 'hls', '-hls_time', String(HLS_SEGMENT_SECONDS), '-hls_playlist_type', 'vod', '-hls_flags', 'independent_segments', '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', join(dir, '%v', 'seg_%05d.ts'), '-master_pl_name', 'master.m3u8', '-var_stream_map', varMap, join(dir, '%v', 'index.m3u8'),
  ];
}

/** Run ffmpeg with a duration-proportional timeout; classify failures as unsupported vs transient. */
async function runFfmpeg(args: string[], durationMs: number, factor: number, onProgress?: (f: number) => void): Promise<void> {
  const timeoutMs = timeoutFor(durationMs, factor);
  const t0 = Date.now();
  try {
    await ffmpeg(args, { timeoutMs, durationMs: durationMs || undefined, onProgress });
  } catch (err) {
    if (Date.now() - t0 >= timeoutMs - 100) throw new RetryableMediaError(`ffmpeg timed out after ${timeoutMs} ms`);
    const msg = (err as Error).message;
    if (err instanceof MediaError && looksUndecodable(msg)) throw new UnsupportedMediaError(`Media could not be decoded: ${firstLine(msg)}`);
    throw new RetryableMediaError(`ffmpeg failed: ${msg.slice(-1500)}`);
  }
}

// ---------------------------------------------------------------------------------------------
interface DerivativeRow {
  kind: (typeof PIPELINE_KINDS)[number];
  bucket: string;
  object_key: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  width: number | null;
  height: number | null;
  meta: Record<string, unknown>;
}

const SINGLE_PUT_MAX = 16 * 1024 * 1024;
const UPLOAD_CONCURRENCY = 8;

async function fileSha256(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const c of createReadStream(path)) h.update(c as Buffer);
  return h.digest('hex');
}

async function putFile(deps: MediaDeps, key: string, path: string, contentType: string): Promise<{ size: number; sha256: string }> {
  const { size } = await stat(path);
  const sha256 = await fileSha256(path);
  const bucket = deps.storage.bucket('derived');
  // Small objects (HLS segments, images, playlists) go up in a single PUT; large ones stream multipart.
  const body = size <= SINGLE_PUT_MAX ? await readFile(path) : createReadStream(path);
  await deps.storage.put(bucket, key, body, { contentType, metadata: { sha256 }, contentLength: size <= SINGLE_PUT_MAX ? size : undefined });
  return { size, sha256 };
}

async function uploadFile(
  deps: MediaDeps, evidenceId: string, path: string, rel: string, kind: DerivativeRow['kind'], mime: string,
  dim: { width: number; height: number } | null, meta: Record<string, unknown>,
): Promise<DerivativeRow> {
  const key = `evidence/${evidenceId}/${rel}`;
  const { size, sha256 } = await putFile(deps, key, path, mime);
  return { kind, bucket: deps.storage.bucket('derived'), object_key: key, mime_type: mime, size_bytes: size, sha256, width: dim?.width ?? null, height: dim?.height ?? null, meta };
}

const HLS_MIME: Record<string, string> = { m3u8: 'application/vnd.apple.mpegurl', ts: 'video/mp2t' };

async function uploadHls(deps: MediaDeps, evidenceId: string, dir: string, ladder: ReturnType<typeof planLadder>, rate: { fps: number; gop: number }): Promise<DerivativeRow> {
  const prefix = `evidence/${evidenceId}/hls/`;
  let total = 0;
  let segments = 0;
  const renditions: Array<Record<string, unknown>> = [];
  for (const r of ladder) {
    const files = (await readdir(join(dir, r.name))).filter((f) => /^(index\.m3u8|seg_\d{5}\.ts)$/.test(f)).sort();
    if (!files.includes('index.m3u8')) throw new RetryableMediaError(`HLS rendition ${r.name} has no playlist`);
    let bytes = 0;
    const queue = [...files];
    await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, queue.length) }, async () => {
      for (let f = queue.shift(); f !== undefined; f = queue.shift()) {
        const { size } = await putFile(deps, `${prefix}${r.name}/${f}`, join(dir, r.name, f), HLS_MIME[f.split('.').pop()!]!);
        bytes += size;
        if (f.endsWith('.ts')) segments++;
      }
    }));
    total += bytes;
    renditions.push({ name: r.name, width: r.width, height: r.height, maxrateKbps: r.maxrateKbps, playlist: `${r.name}/index.m3u8`, segments: files.length - 1, bytes });
  }
  const master = await putFile(deps, `${prefix}master.m3u8`, join(dir, 'master.m3u8'), HLS_MIME.m3u8!);
  total += master.size;
  const top = ladder[ladder.length - 1]!;
  return {
    kind: 'HLS', bucket: deps.storage.bucket('derived'), object_key: prefix, mime_type: 'application/vnd.apple.mpegurl', size_bytes: total, sha256: master.sha256,
    width: top.width, height: top.height,
    meta: { master: 'master.m3u8', segmentSeconds: HLS_SEGMENT_SECONDS, segments, fps: rate.fps, gop: rate.gop, segmentType: 'mpegts', renditions },
  };
}

/** Remove pipeline derivatives (rows + objects under evidence/<id>/<kind-dir>/ in the DERIVED bucket only). */
export async function clearPipelineDerivatives(deps: MediaDeps, evidenceId: string): Promise<void> {
  const bucket = deps.storage.bucket('derived');
  for (const d of PIPELINE_DIRS) await deps.storage.deletePrefix(bucket, `evidence/${evidenceId}/${d}/`);
  await deps.db.deleteFrom('evidence_derivatives').where('evidence_id', '=', evidenceId).where('kind', 'in', [...PIPELINE_KINDS]).execute();
}
