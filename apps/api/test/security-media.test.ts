/**
 * Media tokens & streaming (security round 2): tampered / expired / replayed-after-logout tokens, cross-evidence
 * use, scope escalation (image -> stream -> download), SHARE tokens vs HLS / originals / other shares, path
 * traversal on /media/stream/:id/* and Range abuse. Real FFmpeg-processed evidence (HLS + proxy + poster).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { signMediaToken } from '@ksp/core';
import { closeApp, login, type Agent } from './helpers.js';
import { evidenceTestSetup, evidenceTestTeardown, userId } from './evidence-setup.js';
import { processedEvidence, userWithPerms } from './custody-support.js';
import type { MediaEvidence } from './fixtures/media-evidence.js';
import { createRegisteredEvidence } from './fixtures/evidence.js';

describe('reprocess by system:monitor holders (SEC-09)', () => {
  it('is limited to the jurisdiction of the system:monitor grant; out of scope == unknown (404)', async () => {
    const east = await login((await userWithPerms(['system:monitor', 'dashboard:view'], 'ps_indiranagar')).username);
    const central = await login((await userWithPerms(['system:monitor', 'dashboard:view'], 'blr_central')).username);
    const r1 = await east.post(`/api/v1/media/evidence/${ev.id}/reprocess`, { reason: 'probe' });
    const r2 = await east.post('/api/v1/media/evidence/00000000-0000-4000-8000-000000000000/reprocess', { reason: 'probe' });
    expect([r1.status, r1.body.error.code]).toEqual([404, 'NOT_FOUND']);
    expect([r2.status, r2.body.error.code]).toEqual([404, 'NOT_FOUND']);
    const fresh = await createRegisteredEvidence({ orgCode: 'ps_cubbonpark', uploadedBy: await userId('io.meera') });
    expect((await central.post(`/api/v1/media/evidence/${fresh.id}/reprocess`, { reason: 'retry' })).status).toBe(202);
  });
});

let app: FastifyInstance;
let meera: Agent;
let kavya: Agent;
let ev: MediaEvidence;
let other: MediaEvidence; // a second processed item in the same station
let pb: { hlsUrl: string; mp4Url: string; posterUrl: string; expiresAt: string };
let snapshot: { id: string; url: string };
let tok: string; // meera's genuine stream token for ev
let meeraId: string;
let sid: string;

const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers });
const tokenOf = (url: string) => decodeURIComponent(/[?&]t=([^&]+)/.exec(url)![1]!);
const streamPath = (evId: string, rel: string, t: string) => `/api/v1/media/stream/${evId}/${rel}?t=${encodeURIComponent(t)}`;
const relOf = (url: string) => url.split('?')[0]!.replace(/^\/api\/v1\/media\/stream\/[0-9a-f-]+\//, '');

beforeAll(async () => {
  app = await evidenceTestSetup();
  [ev, other] = await Promise.all([processedEvidence('h264', 'ps_cubbonpark'), processedEvidence('frames', 'ps_cubbonpark')]);
  [meera, kavya] = await Promise.all([login('io.meera'), login('sup.kavya')]);
  const r = await meera.get(`/api/v1/media/evidence/${ev.id}/playback`);
  expect(r.status).toBe(200);
  pb = r.body;
  tok = tokenOf(pb.mp4Url);
  const s = await meera.post(`/api/v1/media/evidence/${ev.id}/snapshots`, { timeMs: 500 });
  expect(s.status).toBe(201);
  snapshot = s.body;
  meeraId = await userId('io.meera');
  sid = (await app.db.selectFrom('sessions').select('id').where('user_id', '=', meeraId).where('revoked_at', 'is', null).orderBy('created_at', 'desc').executeTakeFirstOrThrow()).id;
}, 300_000);

afterAll(async () => {
  await evidenceTestTeardown();
  await closeApp();
});

describe('token integrity', () => {
  it('control: genuine URLs stream', async () => {
    expect((await get(pb.mp4Url)).statusCode).toBe(200);
    const m = await get(pb.hlsUrl);
    expect(m.statusCode).toBe(200);
    expect(m.body).toContain('#EXTM3U');
    expect((await get(snapshot.url)).statusCode).toBe(200);
  });

  it('tampered payload, tampered MAC, truncated, empty and foreign-key-signed tokens are 401', async () => {
    const [payload, mac] = tok.split('.') as [string, string];
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const variants = {
      payloadEdited: `${Buffer.from(JSON.stringify({ ...claims, eid: other.id })).toString('base64url')}.${mac}`,
      expExtended: `${Buffer.from(JSON.stringify({ ...claims, exp: claims.exp + 86400 })).toString('base64url')}.${mac}`,
      macFlipped: `${payload}.${mac.slice(0, -2)}${mac.endsWith('AA') ? 'BB' : 'AA'}`,
      macTruncated: `${payload}.${mac.slice(0, 10)}`,
      noMac: `${payload}.`,
      junk: 'A'.repeat(64),
    };
    const rel = relOf(pb.mp4Url);
    for (const [name, t] of Object.entries(variants)) {
      expect({ name, s: (await get(streamPath(ev.id, rel, t))).statusCode }).toEqual({ name, s: 401 });
    }
    expect((await get(`/api/v1/media/stream/${ev.id}/${rel}`)).statusCode).toBe(401);
  });

  it('expired tokens are 401', async () => {
    const t = signMediaToken({ typ: 'USER', sub: meeraId, sid, eid: ev.id, scope: 'stream', ttlSeconds: -1 });
    expect((await get(streamPath(ev.id, relOf(pb.mp4Url), t))).statusCode).toBe(401);
  });

  it('a token for evidence A cannot read evidence B (403), even with a valid path of B', async () => {
    const b = (await meera.get(`/api/v1/media/evidence/${other.id}/playback`)).body;
    expect((await get(streamPath(other.id, relOf(b.mp4Url), tok))).statusCode).toBe(403);
  });

  it('scope escalation: image -> stream/download, stream -> download/image, download -> stream all refused', async () => {
    const img = tokenOf(snapshot.url);
    expect((await get(streamPath(ev.id, relOf(pb.mp4Url), img))).statusCode).toBe(403);
    expect((await get(`/api/v1/media/download/${ev.id}?t=${encodeURIComponent(img)}`)).statusCode).toBe(403);
    expect((await get(`/api/v1/media/download/${ev.id}?t=${encodeURIComponent(tok)}`)).statusCode).toBe(403);
    expect((await get(`/api/v1/media/image/${snapshot.id}?t=${encodeURIComponent(tok)}`)).statusCode).toBe(403);
    const dl = (await kavya.get(`/api/v1/media/evidence/${ev.id}/original`)).body;
    const dlt = tokenOf(dl.url);
    expect((await get(streamPath(ev.id, relOf(pb.mp4Url), dlt))).statusCode).toBe(403);
    expect((await get(`/api/v1/media/image/${snapshot.id}?t=${encodeURIComponent(dlt)}`)).statusCode).toBe(403);
    // image token bound to one derivative: a sibling derivative (poster) of the same evidence is refused.
    const poster = await app.db.selectFrom('evidence_derivatives').select('id').where('evidence_id', '=', ev.id).where('kind', '=', 'POSTER').executeTakeFirst();
    if (poster) expect((await get(`/api/v1/media/image/${poster.id}?t=${encodeURIComponent(img)}`)).statusCode).toBe(403);
  });

  it('a token replayed after logout is dead (bound to the session)', async () => {
    const m2 = await login('io.meera');
    const url = (await m2.get(`/api/v1/media/evidence/${ev.id}/playback`)).body.mp4Url as string;
    expect((await get(url)).statusCode).toBe(200);
    expect((await m2.post('/api/v1/auth/logout')).status).toBe(200);
    expect((await get(url)).statusCode).toBe(401);
  });

  it('a USER token with a foreign session id (forged with the real key) is refused', async () => {
    const arjunSid = (await app.db.selectFrom('sessions as s').innerJoin('users as u', 'u.id', 's.user_id').select('s.id').where('u.username', '=', 'sup.kavya').where('s.revoked_at', 'is', null).executeTakeFirstOrThrow()).id;
    const t = signMediaToken({ typ: 'USER', sub: meeraId, sid: arjunSid, eid: ev.id, scope: 'stream' });
    expect((await get(streamPath(ev.id, relOf(pb.mp4Url), t))).statusCode).toBe(401);
  });
});

describe('SHARE tokens', () => {
  let shareId: string;
  let otherShareId: string;
  beforeAll(async () => {
    const mk = async (evidenceId: string) => (await meera.post('/api/v1/shares', { evidenceIds: [evidenceId], recipientType: 'EXTERNAL', recipientName: 'Adv. Test', recipientEmail: 'pp@example.org', recipientOrg: 'PP office', purpose: 'Review before trial', expiresAt: new Date(Date.now() + 2 * 86_400_000).toISOString() })).body.share.id as string;
    shareId = await mk(ev.id);
    otherShareId = await mk(other.id);
  });
  const share = (scope: 'stream' | 'download' | 'image', sub = shareId, eid = ev.id, ref?: string) => signMediaToken({ typ: 'SHARE', sub, eid, scope, ref });

  it('cannot reach HLS, the plain proxy (watermarked share), posters or sprites', async () => {
    for (const url of [pb.hlsUrl, pb.mp4Url, pb.posterUrl]) {
      expect((await get(streamPath(ev.id, relOf(url), share('stream')))).statusCode, relOf(url)).toBe(404);
    }
  });
  it('cannot use the image endpoint or download the original without allow_original', async () => {
    expect((await get(`/api/v1/media/image/${snapshot.id}?t=${encodeURIComponent(share('image', shareId, ev.id, snapshot.id))}`)).statusCode).toBe(403);
    expect((await get(`/api/v1/media/download/${ev.id}?t=${encodeURIComponent(share('download', shareId, ev.id, 'original'))}`)).statusCode).toBe(403);
  });
  it('a share token for share X cannot read evidence of share Y, nor evidence not in the share', async () => {
    expect((await get(streamPath(other.id, 'x/watermarked.mp4', share('stream', shareId, other.id)))).statusCode).toBe(401);
    expect((await get(streamPath(ev.id, relOf(pb.mp4Url), share('stream', otherShareId, ev.id)))).statusCode).toBe(401);
  });
  it('a revoked share kills its tokens', async () => {
    const t = share('stream');
    expect((await meera.post(`/api/v1/shares/${shareId}/revoke`, { reason: 'Security test revoke' })).status).toBe(200);
    expect((await get(streamPath(ev.id, relOf(pb.mp4Url), t))).statusCode).toBe(401);
  });
});

describe('path traversal on /media/stream/:evidenceId/*', () => {
  it('never escapes evidence/<id>/ nor reaches originals or other items', async () => {
    const otherRel = relOf((await meera.get(`/api/v1/media/evidence/${other.id}/playback`)).body.mp4Url);
    const orig = (await app.db.selectFrom('evidence').select('storage_key').where('id', '=', ev.id).executeTakeFirstOrThrow()).storage_key!;
    const attacks = [
      `../${other.id}/${otherRel}`, `hls/../../${other.id}/${otherRel}`, `%2e%2e/${other.id}/${otherRel}`, `%2E%2E%2F${other.id}%2F${otherRel}`,
      `%252e%252e/${other.id}/${otherRel}`, `..%2f${other.id}/${otherRel}`, `..\\${other.id}\\${otherRel}`, `..%5c${other.id}%5c${otherRel}`,
      `${relOf(pb.mp4Url)}%00.m3u8`, `${relOf(pb.mp4Url)}\u0000`, `/${orig}`, `%2F${orig}`, `//evil.example/x`, `hls/master.m3u8/..`, `${'a/'.repeat(120)}x`, `hls/seg_00000.ts.m3u8`, `proxy/`,
    ];
    const bad: string[] = [];
    for (const a of attacks) {
      const r = await app.inject({ method: 'GET', url: `/api/v1/media/stream/${ev.id}/${a}?t=${encodeURIComponent(tok)}` });
      if (r.statusCode < 400 || r.statusCode >= 500) bad.push(`${a} -> ${r.statusCode}`);
    }
    expect(bad).toEqual([]);
    // Dot segments that the URL parser resolves INSIDE the same item may only ever return that same item's file.
    const own = await get(pb.mp4Url);
    for (const a of [`./${relOf(pb.mp4Url)}`, `proxy/./${relOf(pb.mp4Url).split('/').pop()}`]) {
      const r = await app.inject({ method: 'GET', url: `/api/v1/media/stream/${ev.id}/${a}?t=${encodeURIComponent(tok)}` });
      if (r.statusCode === 200) expect(r.rawPayload.equals(own.rawPayload)).toBe(true);
      else expect(r.statusCode).toBe(404);
    }
  });
});

describe('path traversal over a real socket (no client-side URL normalisation)', () => {
  it('raw ../ and ./ paths reach the handler un-normalised and are refused', async () => {
    const srv = app.server.listening ? app.server : (await app.listen({ port: 0, host: '127.0.0.1' }), app.server);
    const port = (srv.address() as AddressInfo).port;
    const raw = (path: string) => new Promise<number>((res, rej) => {
      const r = httpRequest({ host: '127.0.0.1', port, path, method: 'GET' }, (m) => { m.resume(); res(m.statusCode ?? 0); });
      r.on('error', rej);
      r.end();
    });
    const otherRel = relOf((await meera.get(`/api/v1/media/evidence/${other.id}/playback`)).body.mp4Url);
    const q = `?t=${encodeURIComponent(tok)}`;
    for (const p of [`../${other.id}/${otherRel}`, `hls/../../${other.id}/${otherRel}`, `./${relOf(pb.mp4Url)}`, `proxy/../proxy/proxy.mp4`]) {
      const s = await raw(`/api/v1/media/stream/${ev.id}/${p}${q}`);
      expect({ p, s }).toEqual({ p, s: 404 });
    }
  });
});

describe('Range abuse', () => {
  it('huge, negative, inverted, multi-range and beyond-size ranges never 500 and never over-read', async () => {
    const full = await get(pb.mp4Url);
    const size = full.rawPayload.length;
    const cases: Array<[string, (s: number, h: Record<string, unknown>, len: number) => boolean]> = [
      ['bytes=0-99999999999999999', (s, h, len) => (s === 206 || s === 200) && len === size],
      ['bytes=-99999999999', (s, _h, len) => (s === 206 || s === 200) && len === size],
      ['bytes=-0', (s) => s === 200 || s === 416],
      ['bytes=10-5', (s, _h, len) => s === 200 && len === size], // invalid => ignored => full body
      ['bytes=0-1,5-6', (s, _h, len) => s === 200 && len === size], // multi-range ignored
      ['bytes=--5', (s, _h, len) => s === 200 && len === size],
      ['bytes=abc', (s, _h, len) => s === 200 && len === size],
      [`bytes=${size + 1000}-`, (s, h) => s === 416 && String(h['content-range']) === `bytes */${size}`],
      [`bytes=${size - 10}-`, (s, _h, len) => s === 206 && len === 10],
      ['items=0-5', (s, _h, len) => s === 200 && len === size],
    ];
    const bad: string[] = [];
    for (const [range, ok] of cases) {
      const r = await get(pb.mp4Url, { range });
      if (!ok(r.statusCode, r.headers, r.rawPayload.length)) bad.push(`${range} -> ${r.statusCode} len=${r.rawPayload.length} cr=${r.headers['content-range']}`);
    }
    expect(bad).toEqual([]);
  });
});
