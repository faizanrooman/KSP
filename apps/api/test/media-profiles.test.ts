/**
 * Transcoding capacity options (EXT-9): MEDIA_PROFILE=proxy-only (no HLS; the player gets the proxy MP4),
 * on-demand-hls (first playback queues media.hls, "PREPARING" until built, then HLS; one audit per request),
 * and MEDIA_ENCODER hardware selection with automatic libx264 fallback. Real FFmpeg, S3, pg-boss.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { getQueue, logger, type AppConfig } from '@ksp/core';
import { QUEUES } from '@ksp/shared';
import { closeApp, getApp, login, type Agent } from './helpers.js';
import { createMediaEvidence } from './fixtures/media-evidence.js';
import { buildHlsOnDemand, hlsArgs, processMedia, proxyArgs } from '../../worker/src/jobs/media/process.js';
import { encoderArgs, encoderFormatFilter, probeEncoder, resolveEncoder, resetEncoderCache } from '../../worker/src/jobs/media/encoder.js';
import { analyseSource, planLadder, planRate } from '../../worker/src/jobs/media/plan.js';

let app: FastifyInstance;
let io: Agent;
let saved: Pick<AppConfig, 'MEDIA_PROFILE' | 'MEDIA_ENCODER'>;
const deps = () => ({ db: app.db, storage: app.storage, cfg: app.cfg, log: logger().child({ test: 'media-profiles' }) });
const kinds = async (id: string) => (await app.db.selectFrom('evidence_derivatives').select('kind').where('evidence_id', '=', id).execute()).map((r) => r.kind).sort();

beforeAll(async () => {
  app = await getApp();
  saved = { MEDIA_PROFILE: app.cfg.MEDIA_PROFILE, MEDIA_ENCODER: app.cfg.MEDIA_ENCODER };
  io = await login('io.meera');
}, 120_000);
afterAll(async () => {
  Object.assign(app.cfg, saved);
  await closeApp();
});

describe('MEDIA_PROFILE', () => {
  it('proxy-only: proxy + stills + sprites, no HLS; playback serves the MP4 only', async () => {
    app.cfg.MEDIA_PROFILE = 'proxy-only';
    const ev = await createMediaEvidence(app.db, app.storage, { kind: 'h264', org: 'ps_cubbonpark', uploadedBy: 'io.meera' });
    const r = await processMedia(deps(), { evidenceId: ev.id });
    expect(r.status).toBe('READY');
    expect(await kinds(ev.id)).not.toContain('HLS');
    expect(await kinds(ev.id)).toEqual(expect.arrayContaining(['POSTER', 'PROXY_MP4', 'SPRITE', 'THUMBNAIL']));
    const pb = await io.get(`/api/v1/media/evidence/${ev.id}/playback`);
    expect(pb.status).toBe(200);
    expect(pb.body).toMatchObject({ mediaProfile: 'proxy-only', hlsStatus: 'NOT_BUILT', hlsUrl: null });
    expect(pb.body.mp4Url).toMatch(/\?t=/);
    // Range requests on the proxy (seeking without HLS).
    const part = await io.get(pb.body.mp4Url.replace(/^.*\/api\/v1/, '/api/v1'), { range: 'bytes=0-1023' });
    expect(part.status).toBe(206);
    const done = await app.db.selectFrom('audit_events').select('details').where('evidence_id', '=', ev.id).where('action', '=', 'MEDIA_PROCESSING_COMPLETED').executeTakeFirstOrThrow();
    expect(done.details).toMatchObject({ mediaProfile: 'proxy-only', renditions: [], encoder: 'libx264' });
  }, 180_000);

  it('on-demand-hls: first playback queues the ladder (PREPARING, audited once), the worker builds it, then HLS is served', async () => {
    app.cfg.MEDIA_PROFILE = 'on-demand-hls';
    const ev = await createMediaEvidence(app.db, app.storage, { kind: 'h264', org: 'ps_cubbonpark', uploadedBy: 'io.meera' });
    expect((await processMedia(deps(), { evidenceId: ev.id })).status).toBe('READY');
    expect(await kinds(ev.id)).not.toContain('HLS');
    const first = await io.get(`/api/v1/media/evidence/${ev.id}/playback`);
    expect(first.body).toMatchObject({ hlsStatus: 'PREPARING', hlsUrl: null });
    expect(first.body.mp4Url).toBeTruthy(); // plays immediately
    const second = await io.get(`/api/v1/media/evidence/${ev.id}/playback`);
    expect(second.body.hlsStatus).toBe('PREPARING');
    const req = await app.db.selectFrom('audit_events').select(['details']).where('evidence_id', '=', ev.id).where('action', '=', 'MEDIA_STREAM_REQUESTED').execute();
    expect(req).toHaveLength(1); // singletonKey: one queued job, one custody event
    const boss = await getQueue();
    const queued = await boss.fetch<{ evidenceId: string }>(QUEUES.MEDIA_HLS, { batchSize: 10 });
    const mine = (queued ?? []).filter((j) => j.data.evidenceId === ev.id);
    expect(mine).toHaveLength(1);
    for (const j of queued ?? []) await boss.complete(QUEUES.MEDIA_HLS, j.id);
    // The worker handler (called directly with the queued payload).
    const built = await buildHlsOnDemand(deps(), mine[0]!.data, { queueJobId: mine[0]!.id });
    expect(built.status).toBe('READY');
    expect(await buildHlsOnDemand(deps(), { evidenceId: ev.id })).toMatchObject({ status: 'SKIPPED' });
    const hls = await app.db.selectFrom('evidence_derivatives').select(['object_key', 'meta']).where('evidence_id', '=', ev.id).where('kind', '=', 'HLS').executeTakeFirstOrThrow();
    expect(hls.meta).toMatchObject({ onDemand: true, master: 'master.m3u8' });
    const third = await io.get(`/api/v1/media/evidence/${ev.id}/playback`);
    expect(third.body).toMatchObject({ hlsStatus: 'READY' });
    const master = await io.get(third.body.hlsUrl.replace(/^.*\/api\/v1/, '/api/v1'));
    expect(master.status).toBe(200);
    expect(master.raw).toContain('#EXTM3U');
    const job = await app.db.selectFrom('processing_jobs').select(['status']).where('evidence_id', '=', ev.id).where('kind', '=', 'MEDIA_HLS').executeTakeFirstOrThrow();
    expect(job.status).toBe('COMPLETED');
  }, 180_000);

  it('full (default) still produces the HLS ladder at ingest', async () => {
    app.cfg.MEDIA_PROFILE = 'full';
    const ev = await createMediaEvidence(app.db, app.storage, { kind: 'h264', org: 'ps_cubbonpark', uploadedBy: 'io.meera' });
    expect((await processMedia(deps(), { evidenceId: ev.id })).status).toBe('READY');
    expect(await kinds(ev.id)).toContain('HLS');
  }, 180_000);
});

describe('MEDIA_ENCODER', () => {
  it('falls back to libx264 when the hardware encoder is missing or cannot open its device', async () => {
    for (const e of ['h264_nvenc', 'h264_qsv', 'h264_vaapi'] as const) {
      const c = await probeEncoder(e, '/dev/dri/renderD128');
      expect(c.requested).toBe(e);
      // This host has no NVIDIA/QSV/VAAPI-enabled FFmpeg build: every hardware request must fall back (never fail).
      if (c.encoder !== e) expect(c).toMatchObject({ encoder: 'libx264', fallbackReason: expect.stringMatching(/not compiled|test encode failed/) });
    }
    resetEncoderCache();
    const warned: string[] = [];
    const c = await resolveEncoder({ MEDIA_ENCODER: 'h264_nvenc', MEDIA_HW_DEVICE: '/dev/dri/renderD128' }, { warn: (_o, m) => warned.push(m), info: () => undefined });
    if (c.encoder === 'libx264') expect(warned.join()).toMatch(/unavailable, using libx264/);
    expect(await probeEncoder('libx264', '')).toMatchObject({ encoder: 'libx264', fallbackReason: null });
  });

  it('builds equivalent argument sets per encoder (GOP, pixel format, device upload)', () => {
    const src = analyseSource({ format: { duration: '10' }, streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, r_frame_rate: '30/1', avg_frame_rate: '30/1' }] } as never)!;
    const rate = planRate(src);
    const vaapi = { requested: 'h264_vaapi' as const, encoder: 'h264_vaapi' as const, fallbackReason: null, hwDevice: '/dev/dri/renderD128' };
    const h = hlsArgs('in.mp4', src, rate, planLadder(src), '/tmp/x', vaapi);
    expect(h.slice(0, 2)).toEqual(['-vaapi_device', '/dev/dri/renderD128']);
    expect(h.join(' ')).toContain('format=nv12,hwupload');
    expect(h).toEqual(expect.arrayContaining(['-c:v', 'h264_vaapi', '-g', '30']));
    const p = proxyArgs('in.mp4', src, rate, { width: 1280, height: 720 }, 'o.mp4');
    expect(p).toEqual(expect.arrayContaining(['-c:v', 'libx264', '-sc_threshold', '0', '-g', '30']));
    expect(encoderArgs({ encoder: 'h264_nvenc' }, 25)).toEqual(expect.arrayContaining(['-c:v', 'h264_nvenc', '-no-scenecut', '1', '-g', '25']));
    expect(encoderFormatFilter({ encoder: 'h264_qsv' })).toBe('format=nv12');
  });
});
