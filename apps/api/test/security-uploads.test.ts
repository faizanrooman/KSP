/**
 * Upload protocol abuse (security round 2): part numbers 0 / negative / > total / > MAX_CHUNKS / non-numeric,
 * size mismatch, oversize declarations, wrong content type, hostile filenames (traversal, CRLF header injection,
 * RTL override, 1000+ chars) through to the download Content-Disposition, and officer/device attribution scope
 * (SEC-13).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { closeApp, login, type Agent } from './helpers.js';
import { evidenceTestSetup, evidenceTestTeardown } from './evidence-setup.js';
import { FIXTURES, initUpload, orgId, putPart, readChunk, runFinalize, sha256File, smallVideo } from './uploads-support.js';

let app: FastifyInstance;
let meera: Agent;
let kavya: Agent;
let clip: string;
let cubbon: string;

beforeAll(async () => {
  app = await evidenceTestSetup();
  [meera, kavya] = await Promise.all([login('io.meera'), login('sup.kavya')]);
  clip = await smallVideo(`secup-${Date.now()}.mp4`, 1);
  cubbon = await orgId(app, 'ps_cubbonpark');
}, 300_000);

afterAll(async () => {
  await evidenceTestTeardown();
  await closeApp();
});

describe('chunk protocol abuse', () => {
  let id: string;
  let chunkSize: number;
  beforeAll(async () => {
    const init = await initUpload(meera, clip, { orgUnitId: cubbon, sha256: sha256File(clip) });
    expect(init.status).toBe(201);
    ({ id, chunkSize } = init.body);
  });

  it('part numbers outside 1..totalChunks are refused', async () => {
    const buf = readChunk(clip, chunkSize, 1);
    for (const n of ['0', '-1', '2', '10001', '99999999999999999999', '1.5', 'abc', '1e3']) {
      const r = await meera.request('PUT', `/api/v1/uploads/${id}/parts/${n}`, { payload: buf, headers: { 'content-type': 'application/octet-stream', 'x-chunk-sha256': sha256File(clip) } });
      expect({ n, s: r.status < 500 && r.status >= 400 }).toEqual({ n, s: true });
    }
    const parts = await app.db.selectFrom('upload_parts').select('part_number').where('session_id', '=', id).execute();
    expect(parts).toEqual([]);
  });

  it('size mismatch, wrong hash, missing hash, wrong content type are refused', async () => {
    const buf = readChunk(clip, chunkSize, 1);
    expect((await putPart(meera, id, 1, buf.subarray(0, buf.length - 1))).body.error.code).toBe('CHUNK_SIZE_MISMATCH');
    expect((await putPart(meera, id, 1, Buffer.concat([buf, Buffer.from('x')]))).body.error.code).toBe('CHUNK_SIZE_MISMATCH');
    expect((await putPart(meera, id, 1, buf, '0'.repeat(64))).body.error.code).toBe('CHUNK_HASH_MISMATCH');
    expect((await meera.request('PUT', `/api/v1/uploads/${id}/parts/1`, { payload: buf, headers: { 'content-type': 'application/octet-stream' } })).status).toBe(400);
    expect((await meera.request('PUT', `/api/v1/uploads/${id}/parts/1`, { payload: buf.toString('latin1'), headers: { 'content-type': 'text/plain' } })).status).toBeGreaterThanOrEqual(400);
  });

  it('oversize and absurd declared sizes / chunk sizes are refused at initiation', async () => {
    const base = { orgUnitId: cubbon, filename: 'x.mp4' };
    expect((await meera.post('/api/v1/uploads', { ...base, size: Number.MAX_SAFE_INTEGER })).status).toBe(413);
    expect((await meera.post('/api/v1/uploads', { ...base, size: 1e300 })).status).toBe(413);
    expect((await meera.post('/api/v1/uploads', { ...base, size: -5 })).status).toBe(400);
    expect((await meera.post('/api/v1/uploads', { ...base, size: 0 })).status).toBe(400);
    const tiny = await meera.post('/api/v1/uploads', { ...base, size: 1000, chunkSize: 1 });
    expect(tiny.status).toBe(201);
    expect(tiny.body.chunkSize).toBeGreaterThanOrEqual(5 * 1024 * 1024); // clamped to MIN_CHUNK_SIZE
    await meera.delete(`/api/v1/uploads/${tiny.body.id}`);
  });

  it("another user's session is 404 for parts/complete/abort", async () => {
    const arjun = await login('io.arjun');
    expect((await putPart(arjun, id, 1, readChunk(clip, chunkSize, 1))).status).toBe(404);
    expect((await arjun.post(`/api/v1/uploads/${id}/complete`)).status).toBe(404);
    expect((await arjun.delete(`/api/v1/uploads/${id}`)).status).toBe(404);
  });
});

describe('hostile filenames', () => {
  it('traversal / control chars are stripped, extension whitelist applies, length is bounded', async () => {
    const init = (filename: string) => meera.post('/api/v1/uploads', { orgUnitId: cubbon, filename, size: 1000 });
    const cases: Array<[string, string | null]> = [
      ['../../../../etc/passwd.mp4', 'passwd.mp4'],
      ['..\\..\\windows\\system32\\evil.mp4', 'evil.mp4'],
      ['clip\r\nSet-Cookie: pwn=1.mp4', 'clipSet-Cookie: pwn=1.mp4'],
      ['a\u0000b.mp4', 'ab.mp4'],
      ['report.exe', null],
      ['clip.mp4.exe', null],
      ['.mp4', '.mp4'],
    ];
    for (const [name, stored] of cases) {
      const r = await init(name);
      if (stored === null) {
        expect({ name, s: r.status }).toEqual({ name, s: 400 });
        continue;
      }
      expect({ name, s: r.status }).toEqual({ name, s: r.status === 201 ? 201 : 400 });
      if (r.status === 201) {
        const row = await app.db.selectFrom('upload_sessions').select('original_filename').where('id', '=', r.body.id).executeTakeFirstOrThrow();
        expect(row.original_filename).toBe(stored);
        expect(row.original_filename).not.toMatch(/[\r\n\0/\\]/);
        await meera.delete(`/api/v1/uploads/${r.body.id}`);
      }
    }
    const long = await init(`${'A'.repeat(1000)}.mp4`);
    if (long.status === 201) {
      const row = await app.db.selectFrom('upload_sessions').select('original_filename').where('id', '=', long.body.id).executeTakeFirstOrThrow();
      expect(row.original_filename.length).toBeLessThanOrEqual(255);
      await meera.delete(`/api/v1/uploads/${long.body.id}`);
    }
    expect((await init(`${'A'.repeat(1030)}.mp4`)).status).toBe(400); // schema max 1024
  });

  it('a registered item with a CRLF / RTL / quote filename downloads with a safe Content-Disposition', async () => {
    const nasty = 'evid"ence‮gpj.\r\nX-Injected: 1;مرحبا.mp4';
    const path = join(FIXTURES, `nasty-${Date.now()}.mp4`);
    copyFileSync(await smallVideo(`nasty-src-${Date.now()}.mp4`, 5), path);
    const init = await meera.post('/api/v1/uploads', { orgUnitId: cubbon, filename: nasty, size: (await import('node:fs')).statSync(path).size, sha256: sha256File(path) });
    expect(init.status).toBe(201);
    const { id, chunkSize, totalChunks } = init.body;
    for (let n = 1; n <= totalChunks; n++) expect((await putPart(meera, id, n, readChunk(path, chunkSize, n))).status).toBe(200);
    expect((await meera.post(`/api/v1/uploads/${id}/complete`)).status).toBe(200);
    await runFinalize(app, id);
    const s = await app.db.selectFrom('upload_sessions as s').innerJoin('evidence as e', 'e.id', 's.evidence_id').select(['e.id', 'e.status', 'e.original_filename']).where('s.id', '=', id).executeTakeFirstOrThrow();
    expect(s.status).toBe('REGISTERED');
    expect(s.original_filename).not.toMatch(/[\r\n]/);
    const link = await kavya.get(`/api/v1/media/evidence/${s.id}/original`);
    expect(link.status).toBe(200);
    expect(link.body.filename).toMatch(/^[A-Za-z0-9._-]+$/);
    const dl = await app.inject({ method: 'GET', url: link.body.url });
    expect(dl.statusCode).toBe(200);
    const cd = String(dl.headers['content-disposition']);
    expect(cd).toMatch(/^attachment; filename="[A-Za-z0-9._-]+"; filename\*=UTF-8''[A-Za-z0-9._%-]+$/);
    expect(dl.headers['x-injected']).toBeUndefined();
  });
});

describe('officer / device attribution scope (SEC-13)', () => {
  it('an uploader cannot attribute footage to an officer or device of another district', async () => {
    const base = { orgUnitId: cubbon, filename: 'attr.mp4', size: 1000 };
    const mysuru = await app.db.selectFrom('users').select(['id', 'badge_number']).where('username', '=', 'io.mysuru').executeTakeFirstOrThrow();
    const byId = await meera.post('/api/v1/uploads', { ...base, metadata: { officerId: mysuru.id } });
    expect(byId.status).toBe(400);
    expect(byId.body.error.code).toBe('UNKNOWN_OFFICER');
    const byBadge = await meera.post('/api/v1/uploads', { ...base, metadata: { officerBadge: mysuru.badge_number! } });
    expect(byBadge.body.error.code).toBe('UNKNOWN_OFFICER');
    const naz = await orgId(app, 'ps_nazarbad');
    const dev = await app.db.insertInto('devices').values({ serial_number: `NAZ-${Date.now()}`, device_type: 'BODY_WORN_CAMERA', org_unit_id: naz } as never).returning('serial_number').executeTakeFirstOrThrow();
    const byDevice = await meera.post('/api/v1/uploads', { ...base, metadata: { deviceSerial: dev.serial_number } });
    expect(byDevice.body.error.code).toBe('UNKNOWN_DEVICE');
    // Same-station officer, and a supervisor whose unit covers the station, are accepted.
    for (const u of ['fo.ravi', 'sup.kavya']) {
      const off = await app.db.selectFrom('users').select('id').where('username', '=', u).executeTakeFirstOrThrow();
      const ok = await meera.post('/api/v1/uploads', { ...base, metadata: { officerId: off.id } });
      expect({ u, s: ok.status }).toEqual({ u, s: 201 });
      await meera.delete(`/api/v1/uploads/${ok.body.id}`);
    }
  });
});
