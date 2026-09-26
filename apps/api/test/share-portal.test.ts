/**
 * External share portal: access code + lockout, sessions, watermarked playback (real FFmpeg burn-in by the
 * worker job), SHARE media token confinement, download/print permissions, maxViews, expiry, revocation,
 * access logging + audit, and no storage URLs anywhere.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { ffmpeg, signMediaToken } from '@ksp/core';
import { Agent, closeApp, login } from './helpers.js';
import { evidenceTestSetup, evidenceTestTeardown } from './evidence-setup.js';
import { auditRows, processedEvidence, tmpDir } from './custody-support.js';
import type { MediaEvidence } from './fixtures/media-evidence.js';
import { runShareWatermark } from '../../worker/src/jobs/shares/index.js';

let app: FastifyInstance;
let kavya: Agent; // supervisor: may allow downloads
let clip: MediaEvidence;
let other: MediaEvidence;
let dir: string;

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
const anon = () => new Agent(app);
const H = (s: string) => ({ 'x-share-session': s });

async function share(extra: Record<string, unknown> = {}): Promise<{ id: string; token: string; code: string }> {
  const r = await kavya.post('/api/v1/shares', {
    evidenceIds: [clip.id], recipientType: 'EXTERNAL', recipientName: 'Adv. Rekha Prakash', recipientEmail: 'rekha.pp@example.org', recipientOrg: 'Public Prosecutor, CCH-1',
    purpose: 'Pre-trial review by the prosecutor', expiresAt: inDays(2), ...extra,
  });
  expect(r.status, r.raw).toBe(201);
  return { id: r.body.share.id, token: r.body.token, code: r.body.accessCode };
}
async function open(s: { token: string; code: string }) {
  const r = await anon().post('/api/v1/share-portal/open', { token: s.token, code: s.code });
  expect(r.status, r.raw).toBe(200);
  return r.body.sessionToken as string;
}
const deps = () => ({ db: app.db, storage: app.storage, cfg: app.cfg });
const logActions = async (shareId: string) => (await app.db.selectFrom('share_access_log').select('action').where('share_id', '=', shareId).orderBy('id').execute()).map((r) => r.action);
const noStorageUrls = (v: unknown) => {
  const t = JSON.stringify(v);
  expect(t).not.toMatch(/X-Amz|127\.0\.0\.1:7480|originals\/\d{4}|-derived\/|-evidence\//);
};

beforeAll(async () => {
  app = await evidenceTestSetup();
  [clip, other] = await Promise.all([processedEvidence('h264'), processedEvidence('frames')]);
  kavya = await login('sup.kavya');
  dir = await tmpDir('ksp-share-');
}, 300_000);

afterAll(async () => {
  await evidenceTestTeardown();
  await closeApp();
  await rm(dir, { recursive: true, force: true });
});

describe('open & access code', () => {
  it('wrong code is refused and counted; 5 failures lock the share (even the right code is then refused)', async () => {
    const s = await share();
    const bad = await anon().post('/api/v1/share-portal/open', { token: s.token, code: '00000000' === s.code ? '11111111' : '00000000' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.details.attemptsRemaining).toBe(4);
    for (let i = 0; i < 3; i++) expect((await anon().post('/api/v1/share-portal/open', { token: s.token, code: '99999999' === s.code ? '88888888' : '99999999' })).status).toBe(401);
    const fifth = await anon().post('/api/v1/share-portal/open', { token: s.token, code: '1234' });
    expect(fifth.status).toBe(423);
    expect(fifth.body.error.code).toBe('SHARE_LOCKED');
    const right = await anon().post('/api/v1/share-portal/open', { token: s.token, code: s.code });
    expect(right.status).toBe(423);
    expect((await app.db.selectFrom('shares').select('status').where('id', '=', s.id).executeTakeFirstOrThrow()).status).toBe('LOCKED');
    expect((await logActions(s.id)).filter((a) => a === 'CODE_FAILED').length).toBe(5);
    expect((await auditRows({ resourceId: s.id, action: 'SHARE_LOCKED' })).length).toBe(1);
    const denied = await auditRows({ resourceId: s.id, action: 'SHARE_ACCESS_DENIED' });
    expect(denied.length).toBeGreaterThanOrEqual(6);
    expect(denied.every((d) => d.actor_type === 'EXTERNAL_RECIPIENT' && d.outcome === 'DENIED')).toBe(true);
    expect(JSON.stringify(denied.map((d) => d.details))).not.toContain(s.code);
  });

  it('unknown link -> generic 401; missing session -> 401', async () => {
    const r = await anon().post('/api/v1/share-portal/open', { token: 'x'.repeat(43), code: '12345678' });
    expect(r.status).toBe(401);
    expect(r.body.error.message).toBe('Invalid link or access code');
    expect((await anon().get('/api/v1/share-portal/session')).status).toBe(401);
    expect((await anon().get('/api/v1/share-portal/session', H('garbage.token'))).status).toBe(401);
  });
});

describe('watermarked playback', () => {
  let s: { id: string; token: string; code: string };
  let session: string;
  let mp4Url: string;

  it('opens, prepares a per-share watermarked variant and serves it with a SHARE token', async () => {
    s = await share({ allowDownload: true, allowPrint: true });
    const o = await anon().post('/api/v1/share-portal/open', { token: s.token, code: s.code });
    expect(o.status).toBe(200);
    session = o.body.sessionToken;
    expect(o.body.items.map((i: { evidenceId: string }) => i.evidenceId)).toEqual([clip.id]);
    expect(o.body.share.permissions).toEqual({ allowDownload: true, allowOriginal: false, allowPrint: true, watermark: true });
    noStorageUrls(o.body);
    const p1 = await anon().get(`/api/v1/share-portal/items/${clip.id}/playback`, H(session));
    expect(p1.status).toBe(202);
    expect(p1.body.status).toBe('PREPARING');
    const job = await runShareWatermark(deps(), { shareId: s.id, evidenceId: clip.id });
    expect(job.status).toBe('CREATED');
    expect((await runShareWatermark(deps(), { shareId: s.id, evidenceId: clip.id })).status).toBe('EXISTS');
    const d = await app.db.selectFrom('evidence_derivatives').selectAll().where('evidence_id', '=', clip.id).where('kind', '=', 'WATERMARKED').executeTakeFirstOrThrow();
    expect(d.object_key).toBe(`evidence/${clip.id}/shares/${s.id}/watermarked.mp4`);
    expect((d.meta as { shareId: string; lines: string[] }).shareId).toBe(s.id);
    expect((d.meta as { lines: string[] }).lines.join(' ')).toContain('rekha.pp@example.org');
    expect((await auditRows({ resourceId: s.id, action: 'SHARE_WATERMARK_GENERATED' })).length).toBe(1);

    const p2 = await anon().get(`/api/v1/share-portal/items/${clip.id}/playback`, H(session));
    expect(p2.status).toBe(200);
    expect(p2.body.watermarked).toBe(true);
    mp4Url = p2.body.mp4Url;
    expect(mp4Url).toMatch(new RegExp(`^/api/v1/media/stream/${clip.id}/shares/${s.id}/watermarked\\.mp4\\?t=`));
    noStorageUrls(p2.body);
    const claims = JSON.parse(Buffer.from(new URL(mp4Url, 'http://x').searchParams.get('t')!.split('.')[0]!, 'base64url').toString());
    expect(claims).toMatchObject({ typ: 'SHARE', sub: s.id, eid: clip.id, scope: 'stream' });
    expect(claims.wm).toContain('rekha.pp@example.org');
    expect(claims.wm).toContain(s.id);

    const v = await app.inject({ method: 'GET', url: mp4Url });
    expect(v.statusCode).toBe(200);
    expect(v.headers['content-type']).toBe('video/mp4');
    const range = await app.inject({ method: 'GET', url: mp4Url, headers: { range: 'bytes=0-1023' } });
    expect(range.statusCode).toBe(206);
    // The served video carries the burn-in: frames differ from the unwatermarked proxy at the same time.
    const proxy = await app.db.selectFrom('evidence_derivatives').selectAll().where('evidence_id', '=', clip.id).where('kind', '=', 'PROXY_MP4').executeTakeFirstOrThrow();
    await writeFile(join(dir, 'served.mp4'), v.rawPayload);
    await writeFile(join(dir, 'proxy.mp4'), await app.storage.getBuffer(proxy.bucket, proxy.object_key));
    // Compare the bottom-left info box region (where the recipient text is burned in).
    const crop = async (p: string) => {
      const out = `${p}.gray`;
      await ffmpeg(['-v', 'error', '-ss', '3', '-i', p, '-frames:v', '1', '-vf', 'crop=iw/2:ih/5:0:ih*4/5', '-pix_fmt', 'gray', '-f', 'rawvideo', out]);
      return readFile(out);
    };
    const a = await crop(join(dir, 'served.mp4'));
    const b = await crop(join(dir, 'proxy.mp4'));
    expect(a.length).toBe(b.length);
    expect(a.length).toBeGreaterThan(0);
    let diff = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (Math.abs(a[i]! - b[i]!) > 40) diff++;
    expect(diff / a.length).toBeGreaterThan(0.1);
    expect(createHash('sha256').update(v.rawPayload).digest('hex')).toBe(d.sha256);
    expect((await auditRows({ resourceId: s.id, action: 'SHARE_ACCESSED' })).length).toBeGreaterThanOrEqual(2); // open + playback
    expect(await logActions(s.id)).toEqual(expect.arrayContaining(['OPEN', 'STREAM']));
  });

  it('SHARE tokens are confined to this share\'s watermarked variant of this item', async () => {
    const t = new URL(mp4Url, 'http://x').searchParams.get('t')!;
    const proxy = await app.db.selectFrom('evidence_derivatives').select('object_key').where('evidence_id', '=', clip.id).where('kind', '=', 'PROXY_MP4').executeTakeFirstOrThrow();
    const rel = proxy.object_key.slice(`evidence/${clip.id}/`.length);
    expect((await anon().get(`/api/v1/media/stream/${clip.id}/${rel}?t=${encodeURIComponent(t)}`)).status).toBe(404); // not the plain proxy
    const hls = await app.db.selectFrom('evidence_derivatives').select('object_key').where('evidence_id', '=', clip.id).where('kind', '=', 'HLS').executeTakeFirst();
    if (hls) expect((await anon().get(`/api/v1/media/stream/${clip.id}/${hls.object_key.slice(`evidence/${clip.id}/`.length)}master.m3u8?t=${encodeURIComponent(t)}`)).status).toBe(404);
    expect((await anon().get(`/api/v1/media/stream/${other.id}/shares/${s.id}/watermarked.mp4?t=${encodeURIComponent(t)}`)).status).toBe(403); // other evidence
    const poster = await app.db.selectFrom('evidence_derivatives').select('id').where('evidence_id', '=', clip.id).where('kind', '=', 'POSTER').executeTakeFirst();
    if (poster) {
      const img = signMediaToken({ typ: 'SHARE', sub: s.id, eid: clip.id, scope: 'image', ref: poster.id });
      expect((await anon().get(`/api/v1/media/image/${poster.id}?t=${encodeURIComponent(img)}`)).status).toBe(403);
    }
    // A forged SHARE token for evidence NOT in the share fails at the share check.
    const forged = signMediaToken({ typ: 'SHARE', sub: s.id, eid: other.id, scope: 'stream' });
    expect((await anon().get(`/api/v1/media/stream/${other.id}/proxy/proxy.mp4?t=${encodeURIComponent(forged)}`)).status).toBe(401);
    // The original download route refuses SHARE tokens unless the share allows originals.
    const dl = signMediaToken({ typ: 'SHARE', sub: s.id, eid: clip.id, scope: 'download', ref: 'original' });
    expect((await anon().get(`/api/v1/media/download/${clip.id}?t=${encodeURIComponent(dl)}`)).status).toBe(403);
    // Items outside the share are 404 on the portal and logged.
    expect((await anon().get(`/api/v1/share-portal/items/${other.id}/playback`, H(session))).status).toBe(404);
    // Internal user tokens cannot fetch share variants either.
    const meera = await login('io.meera');
    const pb = await meera.get(`/api/v1/media/evidence/${clip.id}/playback`);
    const ut = new URL(pb.body.mp4Url, 'http://x').searchParams.get('t')!;
    expect((await anon().get(`/api/v1/media/stream/${clip.id}/shares/${s.id}/watermarked.mp4?t=${encodeURIComponent(ut)}`)).status).toBe(404);
  });

  it('download: watermarked copy allowed; original refused (not allowed) and logged', async () => {
    const link = await anon().get(`/api/v1/share-portal/items/${clip.id}/download-link`, H(session));
    expect(link.status).toBe(200);
    expect(link.body.url).toMatch(/^\/api\/v1\/share-portal\/download\//);
    const f = await app.inject({ method: 'GET', url: link.body.url });
    expect(f.statusCode).toBe(200);
    expect(String(f.headers['content-disposition'])).toContain('WATERMARKED_COPY');
    expect((await auditRows({ resourceId: s.id, action: 'SHARE_DOWNLOADED' })).length).toBe(1);
    const orig = await anon().get(`/api/v1/share-portal/items/${clip.id}/download-link?variant=original`, H(session));
    expect(orig.status).toBe(403);
    // Tampering the ref of a download token does not help.
    const forged = signMediaToken({ typ: 'SHARE', sub: s.id, eid: clip.id, scope: 'download', ref: 'original' });
    expect((await anon().get(`/api/v1/share-portal/download/${clip.id}?t=${encodeURIComponent(forged)}`)).status).toBe(403);
    expect(await logActions(s.id)).toEqual(expect.arrayContaining(['DOWNLOAD', 'DENIED']));
  });

  it('print: watermarked PNG frame; audited', async () => {
    const p = await app.inject({ method: 'GET', url: `/api/v1/share-portal/items/${clip.id}/print?timeMs=2000`, headers: H(session) });
    expect(p.statusCode).toBe(200);
    expect(p.headers['content-type']).toBe('image/png');
    expect(p.rawPayload.subarray(1, 4).toString()).toBe('PNG');
    expect((await auditRows({ resourceId: s.id, action: 'SHARE_PRINTED' })).length).toBe(1);
    const log = await kavya.get(`/api/v1/shares/${s.id}`);
    expect(log.body.accessLog.map((l: { action: string }) => l.action)).toEqual(expect.arrayContaining(['OPEN', 'STREAM', 'DOWNLOAD', 'PRINT', 'DENIED']));
    expect(log.body.downloadCount).toBe(1);
  });

  it('revocation stops the session, the stream token and new opens', async () => {
    const rv = await kavya.post(`/api/v1/shares/${s.id}/revoke`, { reason: 'Prosecutor changed' });
    expect(rv.status).toBe(200);
    expect((await anon().get('/api/v1/share-portal/session', H(session))).status).toBe(410);
    expect((await app.inject({ method: 'GET', url: mp4Url })).statusCode).toBe(401);
    const o = await anon().post('/api/v1/share-portal/open', { token: s.token, code: s.code });
    expect(o.status).toBe(410);
    expect(o.body.error.code).toBe('SHARE_REVOKED');
    expect((await auditRows({ resourceId: s.id, action: 'SHARE_ACCESS_DENIED' })).length).toBeGreaterThanOrEqual(2);
  });
});

describe('limits', () => {
  it('no-download / no-print shares refuse those actions (logged, audited)', async () => {
    const s = await share({ allowDownload: false, allowPrint: false });
    const session = await open(s);
    const dl = await anon().get(`/api/v1/share-portal/items/${clip.id}/download-link`, H(session));
    expect(dl.status).toBe(403);
    expect(dl.body.error.code).toBe('SHARE_DOWNLOAD_NOT_ALLOWED');
    expect((await anon().get(`/api/v1/share-portal/items/${clip.id}/print`, H(session))).status).toBe(403);
    const forged = signMediaToken({ typ: 'SHARE', sub: s.id, eid: clip.id, scope: 'download', ref: 'watermarked' });
    expect((await anon().get(`/api/v1/share-portal/download/${clip.id}?t=${encodeURIComponent(forged)}`)).status).toBe(403);
    expect((await logActions(s.id)).filter((a) => a === 'DENIED').length).toBe(3);
    expect((await auditRows({ resourceId: s.id, action: 'SHARE_ACCESS_DENIED' })).length).toBe(3);
  });

  it('maxViews: opens beyond the limit are refused', async () => {
    const s = await share({ maxViews: 2 });
    await open(s);
    await open(s);
    const third = await anon().post('/api/v1/share-portal/open', { token: s.token, code: s.code });
    expect(third.status).toBe(403);
    expect(third.body.error.code).toBe('SHARE_VIEW_LIMIT');
    expect((await app.db.selectFrom('shares').select('view_count').where('id', '=', s.id).executeTakeFirstOrThrow()).view_count).toBe(2);
  });

  it('maxViews: concurrent opens never exceed the limit (atomic increment)', async () => {
    const s = await share({ maxViews: 2 });
    const res = await Promise.all(Array.from({ length: 8 }, () => anon().post('/api/v1/share-portal/open', { token: s.token, code: s.code })));
    expect(res.filter((r) => r.status === 200).length).toBe(2);
    expect(res.filter((r) => r.status === 403).every((r) => r.body.error.code === 'SHARE_VIEW_LIMIT')).toBe(true);
    expect((await app.db.selectFrom('shares').select('view_count').where('id', '=', s.id).executeTakeFirstOrThrow()).view_count).toBe(2);
  });

  it('expired shares refuse opens and existing sessions', async () => {
    const s = await share();
    const session = await open(s);
    await app.db.updateTable('shares').set({ expires_at: new Date(Date.now() - 1000) }).where('id', '=', s.id).execute();
    const o = await anon().post('/api/v1/share-portal/open', { token: s.token, code: s.code });
    expect(o.status).toBe(410);
    expect(o.body.error.code).toBe('SHARE_EXPIRED');
    expect((await anon().get(`/api/v1/share-portal/items/${clip.id}/playback`, H(session))).status).toBe(410);
    expect((await app.db.selectFrom('shares').select('status').where('id', '=', s.id).executeTakeFirstOrThrow()).status).toBe('EXPIRED');
  });
});
