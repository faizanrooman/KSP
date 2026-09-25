/**
 * Media pipeline tests with real FFmpeg, real Postgres and real S3 (versitygw).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, enqueue, loadConfig, logger, runProcess, stopQueue, Storage, type Database } from '@ksp/core';
import { QUEUES } from '@ksp/shared';
import { createMediaEvidence, type MediaKind } from '../../api/test/fixtures/media-evidence.js';
import { processMedia, type MediaDeps } from '../src/jobs/media/process.js';
import { analyseSource, buildSpriteVtt, planLadder, planRate, planSprite } from '../src/jobs/media/plan.js';

let db: Database;
let storage: Storage;
let deps: MediaDeps;
let tmp: string;
const timings: Array<{ kind: string; durationMs: number; elapsedMs: number }> = [];

beforeAll(async () => {
  const cfg = loadConfig();
  db = createDb(cfg.DATABASE_URL, 8).db;
  storage = new Storage();
  deps = { db, storage, cfg, log: logger().child({ test: 'media' }) };
  tmp = await mkdtemp(join(tmpdir(), 'ksp-media-test-'));
});
afterAll(async () => {
  // eslint-disable-next-line no-console
  console.log('media processing timings', JSON.stringify(timings));
  await stopQueue();
  await db.destroy();
  await rm(tmp, { recursive: true, force: true });
});

async function derivatives(id: string) {
  return db.selectFrom('evidence_derivatives').selectAll().where('evidence_id', '=', id).orderBy('object_key').execute();
}
async function fetchTo(bucket: string, key: string, name: string): Promise<string> {
  const p = join(tmp, name);
  await writeFile(p, await storage.getBuffer(bucket, key));
  return p;
}
async function ffprobeJson(path: string, extra: string[]): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const r = await runProcess(loadConfig().FFPROBE_PATH, ['-v', 'error', '-print_format', 'json', ...extra, path]);
  expect(r.code).toBe(0);
  return JSON.parse(r.stdout);
}
/** Top-level MP4 atom order. */
function atoms(buf: Buffer): string[] {
  const out: string[] = [];
  let off = 0;
  while (off + 8 <= buf.length) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    if (size === 1) size = Number(buf.readBigUInt64BE(off + 8));
    out.push(type);
    if (size < 8) break;
    off += size;
  }
  return out;
}

async function run(kind: MediaKind) {
  const ev = await createMediaEvidence(db, storage, { kind });
  const t0 = Date.now();
  const outcome = await processMedia(deps, { evidenceId: ev.id });
  const row = await db.selectFrom('evidence').select(['media_status', 'media_error', 'duration_ms']).where('id', '=', ev.id).executeTakeFirstOrThrow();
  if (outcome.status === 'READY') timings.push({ kind, durationMs: outcome.durationMs, elapsedMs: Date.now() - t0 });
  return { ev, outcome, row };
}

describe('plan helpers', () => {
  it('computes ladder, GOP and sprite layout', () => {
    const src = analyseSource({ format: { format_name: 'mp4', duration: '10.0' }, streams: [{ index: 0, codec_type: 'video', width: 1920, height: 1080, r_frame_rate: '30000/1001', avg_frame_rate: '30000/1001' }] })!;
    expect(planLadder(src).map((r) => r.name)).toEqual(['360p', '720p', '1080p']);
    expect(planLadder(src)[0]).toMatchObject({ width: 640, height: 360 });
    const rate = planRate(src);
    expect(rate.rate).toBe('30000/1001');
    expect(rate.gop).toBe(29); // 29 frames = 0.967 s <= 1 s
    const sp = planSprite(1_200_000, 1280, 720);
    expect(sp).toMatchObject({ intervalSec: 2, tiles: 600, sheets: 6, tileWidth: 160, tileHeight: 90 });
    const vtt = buildSpriteVtt(sp, 1_200_000, 6);
    expect(vtt.startsWith('WEBVTT')).toBe(true);
    expect(vtt).toContain('00:00:02.000 --> 00:00:04.000\nsprite_000.jpg#xywh=160,0,160,90');
    expect(vtt).toContain('sprite_005.jpg#xywh=');
    const rotated = analyseSource({ format: { format_name: 'mp4', duration: '1' }, streams: [{ index: 0, codec_type: 'video', width: 1920, height: 1080, r_frame_rate: '30/1', avg_frame_rate: '30/1', side_data_list: [{ rotation: -90 }] }] })!;
    expect([rotated.displayWidth, rotated.displayHeight]).toEqual([1080, 1920]);
    expect(analyseSource({ format: { format_name: 'mp4' }, streams: [{ index: 0, codec_type: 'audio' }] })).toBeNull();
  });
});

describe('media pipeline', () => {
  it('H.264/AAC MP4: all derivatives, faststart proxy with <=1 s GOP, HLS, VTT, original untouched', async () => {
    const ev = await createMediaEvidence(db, storage, { kind: 'h264' });
    const seen = new Set<string>();
    const poll = setInterval(() => {
      void db.selectFrom('evidence').select('media_status').where('id', '=', ev.id).executeTakeFirst().then((r) => r && seen.add(r.media_status));
    }, 20);
    const t0 = Date.now();
    const outcome = await processMedia(deps, { evidenceId: ev.id }, { queueJobId: `test-${ev.id}` });
    clearInterval(poll);
    expect(outcome.status).toBe('READY');
    if (outcome.status === 'READY') timings.push({ kind: 'h264', durationMs: outcome.durationMs, elapsedMs: Date.now() - t0 });
    expect(seen.has('PROCESSING')).toBe(true);
    const row = await db.selectFrom('evidence').select(['media_status', 'media_error']).where('id', '=', ev.id).executeTakeFirstOrThrow();
    expect(row).toEqual({ media_status: 'READY', media_error: null });

    const ds = await derivatives(ev.id);
    const kinds = [...new Set(ds.map((d) => d.kind))].sort();
    expect(kinds).toEqual(['HLS', 'POSTER', 'PROXY_MP4', 'SPRITE', 'THUMBNAIL']);
    const derived = storage.bucket('derived');
    for (const d of ds) {
      expect(d.bucket).toBe(derived);
      expect(d.object_key.startsWith(`evidence/${ev.id}/`)).toBe(true);
      if (d.kind !== 'HLS') {
        const head = await storage.head(d.bucket, d.object_key);
        expect(Number(head?.ContentLength)).toBe(Number(d.size_bytes));
        expect(d.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
    }

    // proxy: H.264 + AAC, faststart, keyframe every <= 1 s, CFR 25
    const proxy = ds.find((d) => d.kind === 'PROXY_MP4')!;
    expect(proxy.object_key).toBe(`evidence/${ev.id}/proxy/proxy.mp4`);
    const proxyBuf = await storage.getBuffer(proxy.bucket, proxy.object_key);
    const order = atoms(proxyBuf);
    expect(order.indexOf('moov')).toBeGreaterThan(-1);
    expect(order.indexOf('moov')).toBeLessThan(order.indexOf('mdat'));
    const proxyPath = join(tmp, `${ev.id}.mp4`);
    await writeFile(proxyPath, proxyBuf);
    const info = await ffprobeJson(proxyPath, ['-show_streams']);
    const v = info.streams.find((s: { codec_type: string }) => s.codec_type === 'video');
    expect(v.codec_name).toBe('h264');
    expect(v.pix_fmt).toBe('yuv420p');
    expect([v.width, v.height]).toEqual([640, 360]);
    expect(v.r_frame_rate).toBe('25/1');
    expect(info.streams.find((s: { codec_type: string }) => s.codec_type === 'audio')?.codec_name).toBe('aac');
    const kf = await ffprobeJson(proxyPath, ['-select_streams', 'v:0', '-skip_frame', 'nokey', '-show_entries', 'frame=pts_time']);
    const times = kf.frames.map((f: { pts_time: string }) => Number(f.pts_time));
    expect(times.length).toBeGreaterThanOrEqual(6);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeLessThanOrEqual(1.0001);
    expect(proxy.meta).toMatchObject({ fps: 25, gop: 25, faststart: true });

    // HLS master lists renditions; rendition playlists + segments exist
    const hls = ds.find((d) => d.kind === 'HLS')!;
    expect(hls.object_key).toBe(`evidence/${ev.id}/hls/`);
    const master = (await storage.getBuffer(derived, `${hls.object_key}master.m3u8`)).toString();
    expect(master).toContain('#EXT-X-STREAM-INF');
    expect(master).toContain('360p/index.m3u8');
    const meta = hls.meta as { renditions: Array<{ name: string; playlist: string }> };
    expect(meta.renditions.map((r) => r.name)).toEqual(['360p']);
    const pl = (await storage.getBuffer(derived, `${hls.object_key}360p/index.m3u8`)).toString();
    expect(pl).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
    expect(pl).toContain('#EXT-X-ENDLIST');
    const segs = pl.split('\n').filter((l) => l.endsWith('.ts'));
    expect(segs.length).toBeGreaterThanOrEqual(2);
    for (const s of segs) expect(await storage.head(derived, `${hls.object_key}360p/${s}`)).not.toBeNull();

    // sprite VTT parses and references existing sheets
    const vttRow = ds.find((d) => d.kind === 'SPRITE' && d.mime_type === 'text/vtt')!;
    const vtt = (await storage.getBuffer(derived, vttRow.object_key)).toString();
    expect(vtt.split('\n')[0]).toBe('WEBVTT');
    const cues = [...vtt.matchAll(/(\d{2}:\d{2}:\d{2}\.\d{3}) --> (\d{2}:\d{2}:\d{2}\.\d{3})\n(sprite_\d{3}\.jpg)#xywh=(\d+),(\d+),(\d+),(\d+)/g)];
    expect(cues.length).toBe(Math.ceil((proxy.meta as { durationMs: number }).durationMs / 1000));
    for (const c of cues) expect(ds.some((d) => d.object_key === `evidence/${ev.id}/sprite/${c[3]}`)).toBe(true);
    const thumb = ds.find((d) => d.kind === 'THUMBNAIL')!;
    expect(thumb.width).toBe(320);

    // original never modified
    const h = await storage.hashObject(ev.bucket, ev.key, ev.versionId ?? undefined);
    expect(h.sha256).toBe(ev.sha256);
    expect(h.size).toBe(ev.size);

    const job = await db.selectFrom('processing_jobs').selectAll().where('evidence_id', '=', ev.id).executeTakeFirstOrThrow();
    expect(job).toMatchObject({ kind: 'MEDIA_PROCESS', status: 'COMPLETED', progress: 1 });
    const audits = await db.selectFrom('audit_events').select('action').where('evidence_id', '=', ev.id).orderBy('seq').execute();
    expect(audits.map((a) => a.action)).toEqual(['MEDIA_PROCESSING_STARTED', 'MEDIA_PROCESSING_COMPLETED']);

    // idempotent: second run is skipped; force rebuilds and keeps user snapshots
    expect((await processMedia(deps, { evidenceId: ev.id })).status).toBe('SKIPPED');
    await db.insertInto('evidence_derivatives').values({ evidence_id: ev.id, kind: 'SNAPSHOT', bucket: derived, object_key: `evidence/${ev.id}/snapshot/keep.png`, mime_type: 'image/png' }).execute();
    await storage.put(derived, `evidence/${ev.id}/snapshot/keep.png`, Buffer.from('x'));
    const again = await processMedia(deps, { evidenceId: ev.id, force: true });
    expect(again.status).toBe('READY');
    const ds2 = await derivatives(ev.id);
    expect(ds2.length).toBe(ds.length + 1);
    expect(ds2.some((d) => d.kind === 'SNAPSHOT')).toBe(true);
    expect(await storage.head(derived, `evidence/${ev.id}/snapshot/keep.png`)).not.toBeNull();
    expect((await storage.list(derived, `evidence/${ev.id}/proxy/`)).length).toBe(1);
  });

  it.each([
    ['hevc_mkv', 320, 240, ['240p']],
    ['mjpeg_avi', 320, 240, ['240p']],
    ['portrait', 360, 640, ['360p']],
    ['p1080', 1280, 720, ['360p', '720p', '1080p']],
  ] as const)('%s → READY with expected geometry', async (kind, w, h, rungs) => {
    const { outcome, row, ev } = await run(kind);
    expect(outcome.status, row.media_error ?? '').toBe('READY');
    const ds = await derivatives(ev.id);
    const proxy = ds.find((d) => d.kind === 'PROXY_MP4')!;
    expect([proxy.width, proxy.height]).toEqual([w, h]);
    const hls = ds.find((d) => d.kind === 'HLS')!;
    const renditions = (hls.meta as { renditions: Array<{ name: string; width: number; height: number }> }).renditions;
    expect(renditions.map((r) => r.name)).toEqual(rungs);
    const master = (await storage.getBuffer(hls.bucket, `${hls.object_key}master.m3u8`)).toString();
    for (const r of rungs) expect(master).toContain(`${r}/index.m3u8`);
    if (kind === 'p1080') expect(renditions[2]).toMatchObject({ width: 1920, height: 1080 });
  });

  it('VFR source → CFR proxy (avg rate) and documented meta', async () => {
    const { outcome, ev } = await run('vfr');
    expect(outcome.status).toBe('READY');
    const proxy = (await derivatives(ev.id)).find((d) => d.kind === 'PROXY_MP4')!;
    expect((proxy.meta as { sourceVfr: boolean }).sourceVfr).toBe(true);
    const p = await fetchTo(proxy.bucket, proxy.object_key, `${ev.id}-vfr.mp4`);
    const info = await ffprobeJson(p, ['-show_streams', '-select_streams', 'v:0']);
    const [n, d] = info.streams[0].avg_frame_rate.split('/').map(Number);
    const [rn, rd] = info.streams[0].r_frame_rate.split('/').map(Number);
    expect(Math.abs(n / d - rn / rd)).toBeLessThan(0.05);
  });

  it('huge duration (20 min low-res) processes within a proportional time budget', async () => {
    const { outcome, ev } = await run('long_lowres');
    expect(outcome.status).toBe('READY');
    if (outcome.status !== 'READY') return;
    expect(outcome.durationMs).toBeGreaterThan(1_199_000);
    const ds = await derivatives(ev.id);
    const sheets = ds.filter((d) => d.kind === 'SPRITE' && d.mime_type === 'image/jpeg');
    expect(sheets.length).toBe(6);
    const hls = ds.find((d) => d.kind === 'HLS')!;
    expect((hls.meta as { segments: number }).segments).toBeGreaterThanOrEqual(290);
    expect(outcome.elapsedMs).toBeLessThan(outcome.durationMs); // faster than real time
  });

  it.each(['truncated', 'garbled', 'audio_only'] as const)('%s → UNSUPPORTED with media_error, no derivatives', async (kind) => {
    const { outcome, row, ev } = await run(kind);
    expect(outcome.status).toBe('UNSUPPORTED');
    expect(row.media_status).toBe('UNSUPPORTED');
    expect(row.media_error).toBeTruthy();
    expect(await derivatives(ev.id)).toHaveLength(0);
    expect(await storage.list(storage.bucket('derived'), `evidence/${ev.id}/`)).toHaveLength(0);
    const audits = await db.selectFrom('audit_events').select(['action', 'outcome']).where('evidence_id', '=', ev.id).orderBy('seq').execute();
    expect(audits.at(-1)).toEqual({ action: 'MEDIA_PROCESSING_FAILED', outcome: 'FAILURE' });
    const h = await storage.hashObject(ev.bucket, ev.key, ev.versionId ?? undefined);
    expect(h.sha256).toBe(ev.sha256);
  });

  it('consumes QUEUES.MEDIA_PROCESS through pg-boss (worker module)', async () => {
    const { startWorker } = await import('../src/main.js');
    await startWorker(['media']);
    const ev = await createMediaEvidence(db, storage, { kind: 'h264' });
    await enqueue(QUEUES.MEDIA_PROCESS, { evidenceId: ev.id });
    const deadline = Date.now() + 120_000;
    let status = 'PENDING';
    while (Date.now() < deadline && status !== 'READY') {
      await new Promise((r) => setTimeout(r, 500));
      status = (await db.selectFrom('evidence').select('media_status').where('id', '=', ev.id).executeTakeFirstOrThrow()).media_status;
    }
    expect(status).toBe('READY');
    const job = await db.selectFrom('processing_jobs').select(['status', 'queue_job_id']).where('evidence_id', '=', ev.id).executeTakeFirstOrThrow();
    expect(job.status).toBe('COMPLETED');
    expect(job.queue_job_id).toBeTruthy();
  });
});
