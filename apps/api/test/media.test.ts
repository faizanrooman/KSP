/**
 * Video playback API: tokenised streaming (HLS/MP4 + Range), images, original download (custody), exact-frame
 * snapshots, reprocess, token security and IDOR. Real FFmpeg / Postgres / S3; derivatives are produced by the
 * real media worker pipeline.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger, runProcess, signMediaToken, stopQueue } from '@ksp/core';
import type { FastifyInstance } from 'fastify';
import { invalidateSettings } from '../src/lib/settings.js';
import { Agent, closeApp, createUser, getApp, login } from './helpers.js';
import { createMediaEvidence, type MediaEvidence } from './fixtures/media-evidence.js';
import { processMedia } from '../../worker/src/jobs/media/process.js';

let app: FastifyInstance;
let meera: Agent; // IO, ps_cubbonpark: play, snapshot, edit_metadata (no download_original)
let arjun: Agent; // IO, ps_indiranagar: other jurisdiction
let operator: Agent; // station operator, ps_cubbonpark: evidence:read only
let supervisor: Agent; // supervisor, ps_cubbonpark: download_original
let admin: Agent; // system:monitor
let clip: MediaEvidence; // h264 6 s 640x360 25 fps
let frames: MediaEvidence; // testsrc 4 s 320x240 25 fps, GOP 50
let audio: MediaEvidence; // audio only -> UNSUPPORTED
let tmp: string;
let meeraId: string;

async function processed(kind: 'h264' | 'frames' | 'audio_only'): Promise<MediaEvidence> {
  const ev = await createMediaEvidence(app.db, app.storage, { kind, org: 'ps_cubbonpark', uploadedBy: 'io.meera' });
  await processMedia({ db: app.db, storage: app.storage, cfg: app.cfg, log: logger().child({ test: 'media-api' }) }, { evidenceId: ev.id });
  return ev;
}

beforeAll(async () => {
  app = await getApp();
  await app.db
    .insertInto('system_settings')
    .values({ key: 'sessionPolicy', value: JSON.stringify({ requireMfaForRoles: [] }) })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value: JSON.stringify({ requireMfaForRoles: [] }) }))
    .execute();
  invalidateSettings();
  tmp = await mkdtemp(join(process.env.KSP_TEST_TMP ?? tmpdir(), 'ksp-media-api-'));
  [clip, frames, audio] = await Promise.all([processed('h264'), processed('frames'), processed('audio_only')]);
  meera = await login('io.meera');
  arjun = await login('io.arjun');
  operator = await login((await createUser({ role: 'STATION_OPERATOR', org: 'ps_cubbonpark' })).username);
  supervisor = await login((await createUser({ role: 'SUPERVISOR', org: 'ps_cubbonpark' })).username);
  admin = await login('admin');
  meeraId = (await app.db.selectFrom('users').select('id').where('username', '=', 'io.meera').executeTakeFirstOrThrow()).id;
}, 300_000);

afterAll(async () => {
  await app.db.deleteFrom('system_settings').where('key', '=', 'sessionPolicy').execute();
  invalidateSettings();
  await stopQueue();
  await closeApp();
  await rm(tmp, { recursive: true, force: true });
});

const anon = () => new Agent(app);
const md5Frame = async (path: string) => {
  const r = await runProcess(app.cfg.FFMPEG_PATH, ['-v', 'error', '-i', path, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'md5', '-']);
  expect(r.code).toBe(0);
  return r.stdout.trim();
};
const tokenOf = (url: string) => new URL(url, 'http://x').searchParams.get('t')!;
const auditCount = async (evidenceId: string, action: string) =>
  Number((await app.db.selectFrom('audit_events').select((eb) => eb.fn.countAll().as('n')).where('evidence_id', '=', evidenceId).where('action', '=', action).executeTakeFirstOrThrow()).n);

describe('playback descriptor', () => {
  it('authz: 401 unauthenticated, 403 without evidence:play, 404 other jurisdiction', async () => {
    expect((await anon().get(`/api/v1/media/evidence/${clip.id}/playback`)).status).toBe(401);
    expect((await operator.get(`/api/v1/media/evidence/${clip.id}/playback`)).status).toBe(403);
    expect((await arjun.get(`/api/v1/media/evidence/${clip.id}/playback`)).status).toBe(404);
    expect((await meera.get(`/api/v1/media/evidence/00000000-0000-4000-8000-000000000000/playback`)).status).toBe(404);
  });

  it('returns tokenised URLs only (never storage URLs) and audits EVIDENCE_PLAYED once per window', async () => {
    const before = await auditCount(clip.id, 'EVIDENCE_PLAYED');
    const r = await meera.get(`/api/v1/media/evidence/${clip.id}/playback`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ mediaStatus: 'READY', progress: 1, frameRate: 25, width: 640, height: 360 });
    expect(r.body.durationMs).toBeGreaterThan(5900);
    for (const k of ['hlsUrl', 'mp4Url', 'posterUrl', 'spriteVttUrl', 'thumbnailUrl']) {
      expect(r.body[k]).toMatch(new RegExp(`^/api/v1/media/stream/${clip.id}/.+\\?t=`));
    }
    expect(r.raw).not.toContain(app.cfg.S3_ENDPOINT ?? 'http://127.0.0.1:7480');
    expect(r.raw).not.toContain('X-Amz');
    expect(new Date(r.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    await meera.get(`/api/v1/media/evidence/${clip.id}/playback`);
    expect(await auditCount(clip.id, 'EVIDENCE_PLAYED')).toBe(before + 1);
    const ev = await app.db.selectFrom('audit_events').select(['actor_id', 'category']).where('evidence_id', '=', clip.id).where('action', '=', 'EVIDENCE_PLAYED').executeTakeFirstOrThrow();
    expect(ev).toEqual({ actor_id: meeraId, category: 'CUSTODY' });
  });

  it('reports UNSUPPORTED media with its error and no URLs', async () => {
    const r = await meera.get(`/api/v1/media/evidence/${audio.id}/playback`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ mediaStatus: 'UNSUPPORTED', hlsUrl: null, mp4Url: null, expiresAt: null });
    expect(r.body.mediaError).toMatch(/video/i);
  });
});

describe('stream endpoint', () => {
  it('serves HLS master + child playlists with the token propagated, and segments', async () => {
    const pb = (await meera.get(`/api/v1/media/evidence/${clip.id}/playback`)).body;
    const client = anon(); // media elements send no auth headers/cookies — the token alone must suffice
    const master = await client.get(pb.hlsUrl);
    expect(master.status).toBe(200);
    expect(master.headers['content-type']).toContain('application/vnd.apple.mpegurl');
    expect(master.headers['cache-control']).toBe('private, no-store');
    const child = master.raw.split('\n').find((l) => l.includes('index.m3u8'))!;
    expect(child).toMatch(/^360p\/index\.m3u8\?t=/);
    const base = pb.hlsUrl.split('?')[0].replace(/master\.m3u8$/, '');
    const pl = await client.get(`${base}${child}`);
    expect(pl.status).toBe(200);
    const seg = pl.raw.split('\n').find((l) => l.startsWith('seg_'))!;
    expect(seg).toMatch(/^seg_\d{5}\.ts\?t=/);
    const s = await client.get(`${base}360p/${seg}`);
    expect(s.status).toBe(200);
    expect(s.headers['content-type']).toBe('video/mp2t');
    expect(Number(s.headers['content-length'])).toBeGreaterThan(1000);
  });

  it('supports Range requests on the proxy MP4 (206 + Content-Range + Accept-Ranges)', async () => {
    const pb = (await meera.get(`/api/v1/media/evidence/${clip.id}/playback`)).body;
    const proxy = await app.db.selectFrom('evidence_derivatives').selectAll().where('evidence_id', '=', clip.id).where('kind', '=', 'PROXY_MP4').executeTakeFirstOrThrow();
    const full = await app.storage.getBuffer(proxy.bucket, proxy.object_key);
    const res = await app.inject({ method: 'GET', url: pb.mp4Url, headers: { range: 'bytes=100-1123' } });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 100-1123/${full.length}`);
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-type']).toBe('video/mp4');
    expect(res.rawPayload.equals(full.subarray(100, 1124))).toBe(true);
    const whole = await app.inject({ method: 'GET', url: pb.mp4Url });
    expect(whole.statusCode).toBe(200);
    expect(whole.rawPayload.length).toBe(full.length);
    const bad = await app.inject({ method: 'GET', url: pb.mp4Url, headers: { range: `bytes=${full.length + 10}-` } });
    expect(bad.statusCode).toBe(416);
  });

  it('serves the sprite VTT with tokenised image references that resolve', async () => {
    const pb = (await meera.get(`/api/v1/media/evidence/${clip.id}/playback`)).body;
    const vtt = await anon().get(pb.spriteVttUrl);
    expect(vtt.status).toBe(200);
    expect(vtt.headers['content-type']).toContain('text/vtt');
    const m = /^(sprite_000\.jpg\?t=[^#\s]+)#xywh=0,0,160,90$/m.exec(vtt.raw);
    expect(m).not.toBeNull();
    const base = pb.spriteVttUrl.split('?')[0].replace(/thumbnails\.vtt$/, '');
    const img = await app.inject({ method: 'GET', url: `${base}${m![1]}` });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/jpeg');
    const poster = await app.inject({ method: 'GET', url: pb.posterUrl });
    expect(poster.statusCode).toBe(200);
    expect(poster.rawPayload.subarray(0, 2).toString('hex')).toBe('ffd8');
  });

  it('token security: missing/tampered/expired → 401; wrong evidence/scope → 403; revoked session → 401', async () => {
    const pb = (await meera.get(`/api/v1/media/evidence/${clip.id}/playback`)).body;
    const path = pb.mp4Url.split('?')[0];
    const t = tokenOf(pb.mp4Url);
    expect((await anon().get(path)).status).toBe(401);
    const [payload, mac] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, 'base64url').toString()), eid: frames.id })).toString('base64url');
    expect((await anon().get(`/api/v1/media/stream/${frames.id}/proxy/proxy.mp4?t=${forged}.${mac}`)).status).toBe(401);
    expect((await anon().get(`${path}?t=${payload}.${mac!.slice(0, 10)}${mac![10] === 'A' ? 'B' : 'A'}${mac!.slice(11)}`)).status).toBe(401);
    const session = await app.db.selectFrom('sessions').select('id').where('user_id', '=', meeraId).where('revoked_at', 'is', null).orderBy('created_at', 'desc').executeTakeFirstOrThrow();
    const expired = signMediaToken({ typ: 'USER', sub: meeraId, sid: session.id, eid: clip.id, scope: 'stream', ttlSeconds: -5 });
    expect((await anon().get(`${path}?t=${expired}`)).status).toBe(401);
    // valid token for clip, presented on another evidence item
    expect((await anon().get(`/api/v1/media/stream/${frames.id}/proxy/proxy.mp4?t=${encodeURIComponent(t)}`)).status).toBe(403);
    // wrong scope (download token on the stream endpoint; stream token on the download endpoint)
    const dl = signMediaToken({ typ: 'USER', sub: meeraId, sid: session.id, eid: clip.id, scope: 'download' });
    expect((await anon().get(`${path}?t=${dl}`)).status).toBe(403);
    expect((await anon().get(`/api/v1/media/download/${clip.id}?t=${encodeURIComponent(t)}`)).status).toBe(403);
    // revoked session
    const u = await createUser({ role: 'INVESTIGATING_OFFICER', org: 'ps_cubbonpark' });
    const other = await login(u.username);
    const pb2 = (await other.get(`/api/v1/media/evidence/${clip.id}/playback`)).body;
    expect((await app.inject({ method: 'GET', url: pb2.mp4Url, headers: { range: 'bytes=0-9' } })).statusCode).toBe(206);
    await app.db.updateTable('sessions').set({ revoked_at: new Date(), revoke_reason: 'test' }).where('user_id', '=', u.id).execute();
    expect((await anon().get(pb2.mp4Url)).status).toBe(401);
  });

  it('is path-traversal safe and only serves pipeline derivatives of that evidence item', async () => {
    const pb = (await meera.get(`/api/v1/media/evidence/${clip.id}/playback`)).body;
    const q = `?t=${encodeURIComponent(tokenOf(pb.mp4Url))}`;
    const base = `/api/v1/media/stream/${clip.id}`;
    for (const rel of ['../' + frames.id + '/proxy/proxy.mp4', 'proxy/../../x', '%2e%2e/%2e%2e/originals', 'hls/../../' + frames.id + '/proxy/proxy.mp4', 'proxy/proxy.mp4%00', 'hls/360p/other.bin', 'snapshot/x.png', 'proxy']) {
      const r = await app.inject({ method: 'GET', url: `${base}/${rel}${q}` });
      // 403: normalised onto another item (token mismatch); 401: normalised out of the media routes
      expect([400, 401, 403, 404], rel).toContain(r.statusCode);
    }
  });
});

describe('image endpoint', () => {
  it('serves image derivatives for a token with scope image + ref=derivativeId', async () => {
    const thumb = await app.db.selectFrom('evidence_derivatives').selectAll().where('evidence_id', '=', clip.id).where('kind', '=', 'THUMBNAIL').executeTakeFirstOrThrow();
    const hls = await app.db.selectFrom('evidence_derivatives').selectAll().where('evidence_id', '=', clip.id).where('kind', '=', 'HLS').executeTakeFirstOrThrow();
    const session = await app.db.selectFrom('sessions').select('id').where('user_id', '=', meeraId).where('revoked_at', 'is', null).orderBy('created_at', 'desc').executeTakeFirstOrThrow();
    const tok = (ref: string, eid = clip.id, scope: 'image' | 'stream' = 'image') => signMediaToken({ typ: 'USER', sub: meeraId, sid: session.id, eid, scope, ref });
    const ok = await app.inject({ method: 'GET', url: `/api/v1/media/image/${thumb.id}?t=${tok(thumb.id)}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('image/jpeg');
    expect(ok.headers['cache-control']).toBe('private, no-store');
    expect((await app.inject({ method: 'GET', url: `/api/v1/media/image/${thumb.id}?t=${tok(hls.id)}` })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/api/v1/media/image/${thumb.id}?t=${tok(thumb.id, frames.id)}` })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/api/v1/media/image/${thumb.id}?t=${tok(thumb.id, clip.id, 'stream')}` })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/api/v1/media/image/${hls.id}?t=${tok(hls.id)}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/v1/media/image/${thumb.id}` })).statusCode).toBe(401);
  });
});

describe('original download', () => {
  it('authz: 401 / 403 without download_original / 404 other jurisdiction', async () => {
    expect((await anon().get(`/api/v1/media/evidence/${clip.id}/original`)).status).toBe(401);
    expect((await meera.get(`/api/v1/media/evidence/${clip.id}/original`)).status).toBe(403);
    expect((await arjun.get(`/api/v1/media/evidence/${clip.id}/original`)).status).toBe(404);
  });

  it('streams the exact original with attachment filename + SHA-256 header and writes a custody event', async () => {
    const before = await auditCount(clip.id, 'EVIDENCE_DOWNLOADED');
    const r = await supervisor.get(`/api/v1/media/evidence/${clip.id}/original`);
    expect(r.status).toBe(200);
    expect(r.body.url).toMatch(new RegExp(`^/api/v1/media/download/${clip.id}\\?t=`));
    expect(r.body.sha256).toBe(clip.sha256);
    const dl = await app.inject({ method: 'GET', url: r.body.url });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-disposition']).toContain(`attachment; filename="${clip.evidenceNumber}_h264.mp4"`);
    expect(dl.headers['x-evidence-sha256']).toBe(clip.sha256);
    expect(dl.headers['accept-ranges']).toBe('bytes');
    expect(createHash('sha256').update(dl.rawPayload).digest('hex')).toBe(clip.sha256);
    expect(await auditCount(clip.id, 'EVIDENCE_DOWNLOADED')).toBe(before + 1);
    const ev = await app.db.selectFrom('audit_events').select(['category', 'details']).where('evidence_id', '=', clip.id).where('action', '=', 'EVIDENCE_DOWNLOADED').orderBy('seq', 'desc').executeTakeFirstOrThrow();
    expect(ev.category).toBe('CUSTODY');
    expect((ev.details as { sha256: string }).sha256).toBe(clip.sha256);
    // resumed range (not from byte 0) is part of the same download: 206, no new custody event
    const part = await app.inject({ method: 'GET', url: r.body.url, headers: { range: 'bytes=10-19' } });
    expect(part.statusCode).toBe(206);
    expect(part.rawPayload.length).toBe(10);
    expect(await auditCount(clip.id, 'EVIDENCE_DOWNLOADED')).toBe(before + 1);
  });
});

describe('snapshots', () => {
  async function reference(path: string, frame: number): Promise<string> {
    const out = join(tmp, `ref-${frame}-${Math.random().toString(36).slice(2)}.png`);
    const r = await runProcess(app.cfg.FFMPEG_PATH, ['-v', 'error', '-y', '-i', path, '-vf', `select=eq(n\\,${frame})`, '-fps_mode', 'passthrough', '-frames:v', '1', out]);
    expect(r.code, r.stderr).toBe(0);
    return md5Frame(out);
  }

  it('authz: 401 / 403 without evidence:snapshot / 404 other jurisdiction', async () => {
    expect((await anon().post(`/api/v1/media/evidence/${frames.id}/snapshots`, { timeMs: 0 })).status).toBe(401);
    expect((await operator.post(`/api/v1/media/evidence/${frames.id}/snapshots`, { timeMs: 0 })).status).toBe(403);
    expect((await arjun.post(`/api/v1/media/evidence/${frames.id}/snapshots`, { timeMs: 0 })).status).toBe(404);
    expect((await arjun.get(`/api/v1/media/evidence/${frames.id}/snapshots`)).status).toBe(404);
    expect((await meera.post(`/api/v1/media/evidence/${frames.id}/snapshots`, { timeMs: 999_999 })).status).toBe(422);
  });

  it('extracts the exact frame (proxy and original) — pixel-identical to an FFmpeg reference frame', async () => {
    const proxy = await app.db.selectFrom('evidence_derivatives').selectAll().where('evidence_id', '=', frames.id).where('kind', '=', 'PROXY_MP4').executeTakeFirstOrThrow();
    const proxyPath = join(tmp, 'frames-proxy.mp4');
    await writeFile(proxyPath, await app.storage.getBuffer(proxy.bucket, proxy.object_key));
    const before = await auditCount(frames.id, 'EVIDENCE_SNAPSHOT_CREATED');
    for (const [frame, source, file] of [[37, 'proxy', proxyPath], [0, 'proxy', proxyPath], [99, 'proxy', proxyPath], [62, 'original', frames.path]] as const) {
      // player semantics: a paused frame n sits at n/fps (+ small epsilon)
      const timeMs = (frame / 25) * 1000 + 1;
      const r = await meera.post(`/api/v1/media/evidence/${frames.id}/snapshots`, { timeMs, source });
      expect(r.status, r.raw).toBe(201);
      expect(r.body).toMatchObject({ frameNumber: frame, source, fps: 25, width: 320, height: 240 });
      expect(r.body.sha256).toMatch(/^[0-9a-f]{64}$/);
      const img = await app.inject({ method: 'GET', url: r.body.url });
      expect(img.statusCode).toBe(200);
      expect(img.headers['content-type']).toBe('image/png');
      expect(createHash('sha256').update(img.rawPayload).digest('hex')).toBe(r.body.sha256);
      const snapPath = join(tmp, `snap-${source}-${frame}.png`);
      await writeFile(snapPath, img.rawPayload);
      const got = await md5Frame(snapPath);
      expect(got, `frame ${frame} from ${source}`).toBe(await reference(file, frame));
      if (frame > 0) expect(got).not.toBe(await reference(file, frame - 1));
      if (frame < 99) expect(got).not.toBe(await reference(file, frame + 1));
    }
    expect(await auditCount(frames.id, 'EVIDENCE_SNAPSHOT_CREATED')).toBe(before + 4);
    const list = await meera.get(`/api/v1/media/evidence/${frames.id}/snapshots`);
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBeGreaterThanOrEqual(4);
    const item = list.body.items[0];
    expect(item.url).toMatch(/^\/api\/v1\/media\/image\/[0-9a-f-]{36}\?t=/);
    expect(item.sha256).toMatch(/^[0-9a-f]{64}$/);
    const dl = await app.inject({ method: 'GET', url: item.downloadUrl });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-disposition']).toMatch(/^attachment; filename=".*snapshot_f\d+_.*\.png"$/);
  });
});

describe('reprocess', () => {
  it('authz + enqueues a forced MEDIA_PROCESS job with a custody audit event', async () => {
    const ev = await processed('h264');
    expect((await anon().post(`/api/v1/media/evidence/${ev.id}/reprocess`)).status).toBe(401);
    expect((await operator.post(`/api/v1/media/evidence/${ev.id}/reprocess`)).status).toBe(403);
    expect((await arjun.post(`/api/v1/media/evidence/${ev.id}/reprocess`)).status).toBe(404);
    const r = await meera.post(`/api/v1/media/evidence/${ev.id}/reprocess`, { reason: 'test' });
    expect(r.status).toBe(202);
    expect(r.body.queued).toBe(true);
    expect((await app.db.selectFrom('evidence').select('media_status').where('id', '=', ev.id).executeTakeFirstOrThrow()).media_status).toBe('PENDING');
    expect(await auditCount(ev.id, 'MEDIA_REPROCESS_REQUESTED')).toBe(1);
    const job = await app.db.selectFrom(sqlTable('pgboss.job')).select(['data']).where('name', '=', 'media.process').execute();
    expect(job.some((j) => (j.data as { evidenceId: string; force: boolean }).evidenceId === ev.id && (j.data as { force: boolean }).force)).toBe(true);
    // system monitor (no evidence media access) may also retry processing
    expect((await admin.post(`/api/v1/media/evidence/${ev.id}/reprocess`)).status).toBe(202);
  });
});

// pg-boss tables are outside the generated Kysely schema.
function sqlTable(name: string) {
  return name as never;
}
