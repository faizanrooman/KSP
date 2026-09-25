/**
 * Evidence ingestion end-to-end: real Postgres, real S3 (versitygw), real FFmpeg, real pg-boss.
 * The finalize step runs the actual worker handler in-process.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { statSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { GetObjectRetentionCommand } from '@aws-sdk/client-s3';
import { sql } from 'kysely';
import { stopQueue } from '@ksp/core';
import type { FastifyInstance } from 'fastify';
import { Agent, closeApp, createUser, getApp, login } from './helpers.js';
import { invalidateSettings } from '../src/lib/settings.js';
import {
  ensureRole, ffmpegFixture, initUpload, orgId, putPart, readChunk, runFinalize, sha256File, sha512File, smallVideo, uploadAll, validVideo, writeFixture,
} from './uploads-support.js';

let app: FastifyInstance;
let op: Agent; // station operator @ Cubbon Park
let cubbon: string;
let nazarbad: string;
let qm: Agent; // quarantine manager @ Central Division (not the uploader)
let qmMysuru: Agent; // quarantine manager @ Mysuru district

beforeAll(async () => {
  app = await getApp();
  op = await login('op.cubbon');
  cubbon = await orgId(app, 'ps_cubbonpark');
  nazarbad = await orgId(app, 'ps_nazarbad');
  await ensureRole(app, 'T_QUARANTINE_MGR', ['evidence:read', 'evidence:quarantine_manage']);
  qm = await login((await createUser({ role: 'T_QUARANTINE_MGR', org: 'blr_central' })).username);
  qmMysuru = await login((await createUser({ role: 'T_QUARANTINE_MGR', org: 'mysuru_dist' })).username);
}, 120_000);

afterAll(async () => {
  await closeApp();
  await stopQueue();
});

async function evidenceRow(id: string) {
  return app.db.selectFrom('evidence').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
}

async function auditActions(evidenceId: string): Promise<string[]> {
  const rows = await app.db.selectFrom('audit_events').select('action').where('evidence_id', '=', evidenceId).orderBy('seq').execute();
  return rows.map((r) => r.action);
}

async function queued(name: string, key: string, value: string): Promise<number> {
  const { rows } = await sql<{ n: number }>`SELECT count(*)::int AS n FROM pgboss.job WHERE name = ${name} AND data->>${key} = ${value}`.execute(app.db);
  return rows[0]!.n;
}

describe('upload API security', () => {
  it('requires authentication (401) and evidence:upload (403)', async () => {
    const anon = new Agent(app);
    expect((await anon.post('/api/v1/uploads', { orgUnitId: cubbon, filename: 'a.mp4', size: 10 })).status).toBe(401);
    expect((await anon.get('/api/v1/uploads')).status).toBe(401);
    const fa = await login('fa.naveen'); // forensic analyst: no evidence:upload
    expect((await fa.post('/api/v1/uploads', { orgUnitId: cubbon, filename: 'a.mp4', size: 10 })).status).toBe(403);
    expect((await fa.post('/api/v1/uploads/batches', { orgUnitId: cubbon })).status).toBe(403);
  });

  it('rejects out-of-jurisdiction stations with 404', async () => {
    const r = await op.post('/api/v1/uploads', { orgUnitId: nazarbad, filename: 'a.mp4', size: 1000 });
    expect(r.status).toBe(404);
    expect((await op.post('/api/v1/uploads/batches', { orgUnitId: nazarbad })).status).toBe(404);
  });

  it('rejects disallowed extensions and oversize files', async () => {
    const bad = await op.post('/api/v1/uploads', { orgUnitId: cubbon, filename: 'payload.exe', size: 1000 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('UNSUPPORTED_FILE_TYPE');
    const noext = await op.post('/api/v1/uploads', { orgUnitId: cubbon, filename: 'video', size: 1000 });
    expect(noext.body.error.code).toBe('UNSUPPORTED_FILE_TYPE');
    const big = await op.post('/api/v1/uploads', { orgUnitId: cubbon, filename: 'huge.mp4', size: 60 * 1024 ** 3 });
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('FILE_TOO_LARGE');
  });

  it('rejects unknown declared officers/devices before any data is sent', async () => {
    const r = await op.post('/api/v1/uploads', { orgUnitId: cubbon, filename: 'a.mp4', size: 1000, metadata: { officerBadge: 'NOPE-0000' } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('UNKNOWN_OFFICER');
    const d = await op.post('/api/v1/uploads', { orgUnitId: cubbon, filename: 'a.mp4', size: 1000, metadata: { deviceSerial: 'NO-SUCH-CAM' } });
    expect(d.body.error.code).toBe('UNKNOWN_DEVICE');
  });

  it('only the creator can upload parts, read or complete a session (others: 404)', async () => {
    const path = await smallVideo('owner.mp4', 11);
    const init = await initUpload(op, path, { orgUnitId: cubbon });
    expect(init.status).toBe(201);
    const other = await login('fo.ravi');
    const buf = readFileSync(path);
    expect((await putPart(other, init.body.id, 1, buf)).status).toBe(404);
    expect((await other.get(`/api/v1/uploads/${init.body.id}`)).status).toBe(404);
    expect((await other.post(`/api/v1/uploads/${init.body.id}/complete`)).status).toBe(404);
    expect((await other.delete(`/api/v1/uploads/${init.body.id}`)).status).toBe(404);
    // A station-scoped reader (IO at the same station) may view it; an IO elsewhere may not.
    expect((await (await login('io.meera')).get(`/api/v1/uploads/${init.body.id}`)).status).toBe(200);
    expect((await (await login('io.arjun')).get(`/api/v1/uploads/${init.body.id}`)).status).toBe(404);
    expect((await op.delete(`/api/v1/uploads/${init.body.id}`)).status).toBe(200);
  });

  it('enforces the per-user concurrent session limit', async () => {
    const u = await createUser({ role: 'STATION_OPERATOR', org: 'ps_highgrounds' });
    const a = await login(u.username);
    const station = await orgId(app, 'ps_highgrounds');
    const orig = await app.db.selectFrom('system_settings').select('value').where('key', '=', 'uploadPolicy').executeTakeFirstOrThrow();
    await app.db.updateTable('system_settings').set({ value: JSON.stringify({ ...(orig.value as object), maxConcurrentSessionsPerUser: 2 }) }).where('key', '=', 'uploadPolicy').execute();
    invalidateSettings();
    try {
      for (let i = 0; i < 2; i++) expect((await a.post('/api/v1/uploads', { orgUnitId: station, filename: `c${i}.mp4`, size: 1000 })).status).toBe(201);
      const third = await a.post('/api/v1/uploads', { orgUnitId: station, filename: 'c3.mp4', size: 1000 });
      expect(third.status).toBe(429);
      expect(third.body.error.code).toBe('UPLOAD_LIMIT');
    } finally {
      await app.db.updateTable('system_settings').set({ value: JSON.stringify(orig.value) }).where('key', '=', 'uploadPolicy').execute();
      invalidateSettings();
    }
  });
});

describe('chunk transfer', () => {
  it('detects transit corruption (SHA-256 mismatch), wrong sizes, missing hash header and out-of-range parts', async () => {
    const path = await validVideo('chunks.mp4');
    const init = await initUpload(op, path, { orgUnitId: cubbon });
    const { id, chunkSize, totalChunks } = init.body;
    expect(totalChunks).toBeGreaterThan(2);
    const good = readChunk(path, chunkSize, 1);
    const corrupted = Buffer.from(good);
    corrupted[1000] = corrupted[1000]! ^ 0xff;
    const mismatch = await putPart(op, id, 1, corrupted, createHash('sha256').update(good).digest('hex'));
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error.code).toBe('CHUNK_HASH_MISMATCH');
    const short = await putPart(op, id, 1, good.subarray(0, 1000));
    expect(short.body.error.code).toBe('CHUNK_SIZE_MISMATCH');
    const noHeader = await op.request('PUT', `/api/v1/uploads/${id}/parts/1`, { payload: good, headers: { 'content-type': 'application/octet-stream' } });
    expect(noHeader.status).toBe(400);
    expect((await putPart(op, id, totalChunks + 1, good)).status).toBe(400);
    const ok = await putPart(op, id, 1, good);
    expect(ok.status).toBe(200);
    expect(ok.body.receivedParts).toBe(1);
    // idempotent re-send of the same part
    expect((await putPart(op, id, 1, good)).body.receivedParts).toBe(1);
    // completing with missing parts fails and lists them
    const incomplete = await op.post(`/api/v1/uploads/${id}/complete`);
    expect(incomplete.status).toBe(400);
    expect(incomplete.body.error.code).toBe('UPLOAD_INCOMPLETE');
    expect(incomplete.body.error.details.missingParts).toEqual(Array.from({ length: totalChunks - 1 }, (_, i) => i + 2));
    // abort, then parts are refused
    expect((await op.delete(`/api/v1/uploads/${id}`)).body.status).toBe('ABORTED');
    expect((await putPart(op, id, 2, readChunk(path, chunkSize, 2))).status).toBe(409);
  });

  it('resumes an interrupted upload from the server-side part list', async () => {
    const path = await validVideo('resume.mp4', ['-metadata', 'title=resume']);
    const init = await initUpload(op, path, { orgUnitId: cubbon, metadata: { title: 'Resumed upload' } });
    const { id, chunkSize, totalChunks } = init.body;
    for (const n of [1, 3]) expect((await putPart(op, id, n, readChunk(path, chunkSize, n))).status).toBe(200);
    // "Client restarts": a new login asks the server what it already has.
    const again = await login('op.cubbon');
    const status = await again.get(`/api/v1/uploads/${id}`);
    expect(status.status).toBe(200);
    expect(status.body.status).toBe('UPLOADING');
    expect(status.body.receivedParts).toEqual([1, 3]);
    for (let n = 1; n <= totalChunks; n++) {
      if (status.body.receivedParts.includes(n)) continue;
      expect((await putPart(again, id, n, readChunk(path, chunkSize, n))).status).toBe(200);
    }
    const done = await again.post(`/api/v1/uploads/${id}/complete`);
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('COMPLETED');
    // complete is idempotent
    expect((await again.post(`/api/v1/uploads/${id}/complete`)).body.evidence.id).toBe(done.body.evidence.id);
    const out = await runFinalize(app, id);
    expect(out?.outcome).toBe('REGISTERED');
    const ev = await evidenceRow(done.body.evidence.id);
    expect(ev.sha256).toBe(sha256File(path));
    expect(ev.title).toBe('Resumed upload');
  });
});

describe('finalize pipeline', () => {
  let validPath: string;
  let validEvidenceId: string;

  it('registers a valid upload end-to-end (out-of-order chunks)', async () => {
    validPath = await validVideo('e2e.mp4');
    const batch = await op.post('/api/v1/uploads/batches', { orgUnitId: cubbon, label: 'Night shift 24-09', clientInfo: { client: 'test' } });
    expect(batch.status).toBe(201);
    const { init, complete } = await uploadAll(op, validPath, {
      orgUnitId: cubbon,
      batchId: batch.body.id,
      metadata: { title: 'MG Road patrol', category: 'PATROL', officerBadge: 'KSP-FO-1001', notes: 'handed over by PC Ravi' },
    }, { order: 'shuffle' });
    expect(init.body.totalChunks).toBeGreaterThan(3);
    expect(complete.status).toBe(200);
    expect(complete.body.status).toBe('COMPLETED');
    expect(complete.body.evidence.status).toBe('RECEIVED');
    validEvidenceId = complete.body.evidence.id;
    expect(await queued('ingest.finalize', 'uploadSessionId', init.body.id)).toBe(1);

    const out = await runFinalize(app, init.body.id, { copyPartSize: 8 * 1024 * 1024 });
    expect(out?.outcome).toBe('REGISTERED');

    const ev = await evidenceRow(validEvidenceId);
    expect(ev.status).toBe('REGISTERED');
    expect(ev.evidence_number).toMatch(/^KSP-PSCUBBONPARK-\d{4}-\d{6}$/);
    expect(ev.sha256).toBe(sha256File(validPath));
    expect(ev.sha512).toBe(sha512File(validPath));
    expect(Number(ev.size_bytes)).toBe(statSync(validPath).size);
    expect(ev.storage_tier).toBe('ACTIVE');
    expect(ev.storage_bucket).toBe(app.storage.bucket('evidence'));
    expect(ev.storage_key).toMatch(new RegExp(`^originals/\\d{4}/\\d{2}/${validEvidenceId}/${ev.sha256}$`));
    expect(ev.storage_version_id).toBeTruthy();
    expect(ev.object_lock_until!.getTime()).toBeGreaterThan(Date.now() + 365 * 86_400_000);
    expect(ev.retention_policy_id).toBeTruthy();
    expect(ev.retain_until).toBeTruthy();
    expect(ev.registered_at).toBeTruthy();
    // metadata
    expect(Number(ev.duration_ms)).toBeGreaterThan(5500);
    expect(Number(ev.duration_ms)).toBeLessThan(6500);
    expect(ev.container_format).toBe('mov,mp4,m4a,3gp,3g2,mj2');
    expect(ev.video_codec).toBe('h264');
    expect(ev.audio_codec).toBe('aac');
    expect([ev.width, ev.height]).toEqual([640, 360]);
    expect(Number(ev.frame_rate)).toBe(25);
    expect(Number(ev.bit_rate)).toBeGreaterThan(0);
    expect(ev.recorded_at!.toISOString()).toBe('2026-09-01T10:00:00.000Z');
    expect(ev.recorded_end_at!.getTime()).toBe(ev.recorded_at!.getTime() + Number(ev.duration_ms));
    expect(ev.gps_latitude).toBeCloseTo(12.9716, 4);
    expect(ev.gps_longitude).toBeCloseTo(77.5946, 4);
    expect(ev.gps_source).toBe('CONTAINER_TAG');
    expect((ev.probe as { format: { format_name: string } }).format.format_name).toContain('mp4');
    expect((ev.device_metadata as Record<string, string>).encoder).toMatch(/Lavf/);
    expect(ev.title).toBe('MG Road patrol');
    expect(ev.category).toBe('PATROL');
    const officer = await app.db.selectFrom('users').select('id').where('username', '=', 'fo.ravi').executeTakeFirstOrThrow();
    expect(ev.officer_id).toBe(officer.id);

    // storage: object in the WORM bucket with retention; staging object removed
    const head = await app.storage.head(ev.storage_bucket!, ev.storage_key!);
    expect(Number(head!.ContentLength)).toBe(statSync(validPath).size);
    const ret = await app.storage.s3.send(new GetObjectRetentionCommand({ Bucket: ev.storage_bucket!, Key: ev.storage_key!, VersionId: ev.storage_version_id! }));
    expect(ret.Retention?.Mode).toBe(app.cfg.OBJECT_LOCK_MODE);
    const session = await app.db.selectFrom('upload_sessions').selectAll().where('id', '=', init.body.id).executeTakeFirstOrThrow();
    expect(await app.storage.head(session.staging_bucket, session.staging_key)).toBeNull();
    const rehash = await app.storage.hashObject(ev.storage_bucket!, ev.storage_key!);
    expect(rehash.sha256).toBe(ev.sha256);

    // follow-up job, custody trail, job record, integrity row
    expect(await queued('media.process', 'evidenceId', validEvidenceId)).toBe(1);
    const actions = await auditActions(validEvidenceId);
    for (const a of ['UPLOAD_COMPLETED', 'EVIDENCE_RECEIVED', 'EVIDENCE_HASHED', 'EVIDENCE_METADATA_EXTRACTED', 'EVIDENCE_VALIDATED', 'EVIDENCE_STORED', 'EVIDENCE_REGISTERED']) {
      expect(actions).toContain(a);
    }
    expect(actions.indexOf('EVIDENCE_REGISTERED')).toBeGreaterThan(actions.indexOf('EVIDENCE_HASHED'));
    const job = await app.db.selectFrom('processing_jobs').selectAll().where('upload_session_id', '=', init.body.id).executeTakeFirstOrThrow();
    expect(job.kind).toBe('VALIDATE_REGISTER');
    expect(job.status).toBe('COMPLETED');
    const ic = await app.db.selectFrom('integrity_checks').selectAll().where('evidence_id', '=', validEvidenceId).execute();
    expect(ic).toHaveLength(1);
    expect(ic[0]).toMatchObject({ trigger: 'REGISTRATION', ok: true, expected_sha256: ev.sha256, actual_sha256: ev.sha256 });
    const copies = await app.db.selectFrom('evidence_storage_copies').selectAll().where('evidence_id', '=', validEvidenceId).execute();
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({ status: 'CURRENT', tier: 'ACTIVE', bucket: ev.storage_bucket, object_key: ev.storage_key, version_id: ev.storage_version_id, sha256: ev.sha256 });

    // re-running the job is a no-op
    expect((await runFinalize(app, init.body.id))?.outcome).toBe('NOOP');
    expect(await queued('media.process', 'evidenceId', validEvidenceId)).toBe(1);

    // history + batch views
    const hist = await op.get('/api/v1/uploads');
    const mine = hist.body.items.find((x: { id: string }) => x.id === init.body.id);
    expect(mine.evidence).toMatchObject({ id: validEvidenceId, status: 'REGISTERED', evidenceNumber: ev.evidence_number });
    const b = await op.get(`/api/v1/uploads/batches/${batch.body.id}`);
    expect(b.status).toBe(200);
    expect(b.body.summary).toMatchObject({ total: 1, registered: 1 });
    const station = await (await login('io.meera')).get('/api/v1/uploads?scope=station');
    expect(station.body.items.map((x: { id: string }) => x.id)).toContain(init.body.id);
  });

  it('registered evidence integrity columns are immutable in the database (as ksp_app)', async () => {
    await expect(sql`UPDATE evidence SET sha256 = ${'0'.repeat(64)} WHERE id = ${validEvidenceId}::uuid`.execute(app.db)).rejects.toThrow(/immutable/);
    await expect(sql`UPDATE evidence SET storage_key = 'x' WHERE id = ${validEvidenceId}::uuid`.execute(app.db)).rejects.toThrow(/storage location/);
    await expect(sql`DELETE FROM evidence WHERE id = ${validEvidenceId}::uuid`.execute(app.db)).rejects.toThrow();
    // the stored original cannot be deleted (object lock)
    const ev = await evidenceRow(validEvidenceId);
    await expect(app.storage.delete(ev.storage_bucket!, ev.storage_key!, { versionId: ev.storage_version_id! })).rejects.toThrow();
  });

  it('quarantines an identical re-upload as DUPLICATE', async () => {
    const { complete } = await uploadAll(op, validPath, { orgUnitId: cubbon });
    await runFinalize(app, complete.body.id);
    const ev = await evidenceRow(complete.body.evidence.id);
    expect(ev.status).toBe('QUARANTINED');
    expect(ev.status_reason).toMatch(/^DUPLICATE: /);
    expect(ev.duplicate_of).toBe(validEvidenceId);
    expect(await auditActions(ev.id)).toEqual(expect.arrayContaining(['EVIDENCE_DUPLICATE_DETECTED', 'EVIDENCE_QUARANTINED']));
  });

  it('quarantines a truncated (corrupt) video as CORRUPT', async () => {
    const good = await smallVideo('tobecorrupt.mp4', 3);
    const data = readFileSync(good);
    const path = writeFixture('corrupt.mp4', data.subarray(0, Math.floor(data.length * 0.6)));
    const { complete } = await uploadAll(op, path, { orgUnitId: cubbon });
    expect((await runFinalize(app, complete.body.id))?.outcome).toBe('QUARANTINED');
    const ev = await evidenceRow(complete.body.evidence.id);
    expect(ev.status).toBe('QUARANTINED');
    expect(ev.status_reason).toMatch(/^CORRUPT: /);
    expect(ev.status_reason).not.toMatch(/https?:|X-Amz/);
    expect(ev.video_codec).toBe('h264'); // metadata still recorded for the reviewer
    expect(await auditActions(ev.id)).toEqual(expect.arrayContaining(['EVIDENCE_VALIDATION_FAILED', 'EVIDENCE_QUARANTINED']));
  });

  it('quarantines a non-video renamed to .mp4 as NOT_VIDEO', async () => {
    const path = writeFixture('notavideo.mp4', Buffer.from('%PDF-1.4\n' + 'this is definitely not a video\n'.repeat(2000)));
    const { complete } = await uploadAll(op, path, { orgUnitId: cubbon, mimeType: 'video/mp4' });
    await runFinalize(app, complete.body.id);
    const ev = await evidenceRow(complete.body.evidence.id);
    expect(ev.status_reason).toMatch(/^NOT_VIDEO: /);
    // tool output quotes the internal presigned URL: it must never reach user-visible fields
    expect(ev.status_reason).not.toMatch(/https?:|X-Amz|7480/);
    const audits = await app.db.selectFrom('audit_events').select('details').where('evidence_id', '=', ev.id).execute();
    expect(JSON.stringify(audits)).not.toMatch(/X-Amz|https?:\/\//);
    expect(ev.storage_tier).toBe('STAGING');
  });

  it('quarantines an unsupported codec as UNSUPPORTED_CODEC', async () => {
    const path = await ffmpegFixture('ffv1.mkv', ['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25', '-t', '2', '-c:v', 'ffv1']);
    const { complete } = await uploadAll(op, path, { orgUnitId: cubbon });
    await runFinalize(app, complete.body.id);
    const ev = await evidenceRow(complete.body.evidence.id);
    expect(ev.status_reason).toMatch(/^UNSUPPORTED_CODEC: .*ffv1/);
  });

  it('quarantines when the client-declared hash differs from the server hash (HASH_MISMATCH)', async () => {
    const path = await smallVideo('declared-mismatch.mp4', 4);
    const { complete } = await uploadAll(op, path, { orgUnitId: cubbon, sha256: 'a'.repeat(64) });
    await runFinalize(app, complete.body.id);
    const ev = await evidenceRow(complete.body.evidence.id);
    expect(ev.status_reason).toMatch(/^HASH_MISMATCH: /);
    expect(ev.sha256).toBe(sha256File(path));
  });
});

describe('quarantine review', () => {
  let corruptId: string;
  let dupId: string;

  beforeAll(async () => {
    const a = await smallVideo('q-src.mp4', 2);
    const data = readFileSync(a);
    const path = writeFixture('q-corrupt.mp4', data.subarray(0, Math.floor(data.length * 0.7)));
    const c = await uploadAll(op, path, { orgUnitId: cubbon });
    await runFinalize(app, c.complete.body.id);
    corruptId = c.complete.body.evidence.id;
    const first = await uploadAll(op, a, { orgUnitId: cubbon });
    await runFinalize(app, first.complete.body.id);
    const second = await uploadAll(op, a, { orgUnitId: cubbon });
    await runFinalize(app, second.complete.body.id);
    dupId = second.complete.body.evidence.id;
    expect((await evidenceRow(dupId)).status).toBe('QUARANTINED');
  }, 120_000);

  it('lists quarantined items in scope only', async () => {
    const list = await qm.get('/api/v1/uploads/quarantine');
    expect(list.status).toBe(200);
    const ids = list.body.items.map((x: { id: string }) => x.id);
    expect(ids).toEqual(expect.arrayContaining([corruptId, dupId]));
    const dup = list.body.items.find((x: { id: string }) => x.id === dupId);
    expect(dup.reasonCode).toBe('DUPLICATE');
    expect(dup.duplicateOf.evidenceNumber).toMatch(/^KSP-/);
    const filtered = await qm.get('/api/v1/uploads/quarantine?reason=CORRUPT');
    expect(filtered.body.items.every((x: { reasonCode: string }) => x.reasonCode === 'CORRUPT')).toBe(true);
    const other = await qmMysuru.get('/api/v1/uploads/quarantine');
    expect(other.body.items.map((x: { id: string }) => x.id)).not.toContain(corruptId);
    expect((await op.get('/api/v1/uploads/quarantine')).status).toBe(403);
  });

  it('enforces authorization on decisions', async () => {
    expect((await op.post(`/api/v1/uploads/quarantine/${corruptId}/release`, { reason: 'looks fine to me' })).status).toBe(403);
    expect((await qmMysuru.post(`/api/v1/uploads/quarantine/${corruptId}/release`, { reason: 'out of my area' })).status).toBe(404);
    expect((await qm.post(`/api/v1/uploads/quarantine/${corruptId}/release`, { reason: '' })).status).toBe(400);
    // uploader holding quarantine_manage cannot decide on their own upload
    await ensureRole(app, 'T_UPLOADER_QM', ['evidence:upload', 'evidence:read', 'evidence:quarantine_manage']);
    const u = await createUser({ role: 'T_UPLOADER_QM', org: 'ps_cubbonpark' });
    const self = await login(u.username);
    const path = await smallVideo('self.mp4', 1, ['-metadata', 'comment=self']);
    const data = readFileSync(path);
    const up = await uploadAll(self, writeFixture('self-corrupt.mp4', data.subarray(0, Math.floor(data.length * 0.5))), { orgUnitId: cubbon });
    await runFinalize(app, up.complete.body.id);
    const res = await self.post(`/api/v1/uploads/quarantine/${up.complete.body.evidence.id}/release`, { reason: 'my own upload' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SEPARATION_OF_DUTIES');
  });

  it('releases a quarantined duplicate through the registration path', async () => {
    const r = await qm.post(`/api/v1/uploads/quarantine/${dupId}/release`, { reason: 'Second copy retained as separate exhibit per IO request' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('REGISTERED');
    expect(r.body.evidenceNumber).toMatch(/^KSP-PSCUBBONPARK-/);
    const ev = await evidenceRow(dupId);
    expect(ev.storage_tier).toBe('ACTIVE');
    expect(ev.duplicate_of).toBeTruthy();
    const actions = await auditActions(dupId);
    expect(actions).toEqual(expect.arrayContaining(['EVIDENCE_QUARANTINE_RELEASED', 'EVIDENCE_STORED', 'EVIDENCE_REGISTERED']));
    const rel = await app.db.selectFrom('audit_events').select(['details', 'actor_id']).where('evidence_id', '=', dupId).where('action', '=', 'EVIDENCE_QUARANTINE_RELEASED').executeTakeFirstOrThrow();
    expect((rel.details as { reason: string }).reason).toMatch(/separate exhibit/);
    expect(await queued('media.process', 'evidenceId', dupId)).toBe(1);
    expect((await qm.post(`/api/v1/uploads/quarantine/${dupId}/release`, { reason: 'again please' })).status).toBe(409);
  });

  it('rejects a quarantined item: record kept, staged object deleted', async () => {
    const before = await evidenceRow(corruptId);
    expect(await app.storage.head(before.storage_bucket!, before.storage_key!)).not.toBeNull();
    const r = await qm.post(`/api/v1/uploads/quarantine/${corruptId}/reject`, { reason: 'Truncated copy; officer to re-upload from device' });
    expect(r.status).toBe(200);
    const ev = await evidenceRow(corruptId);
    expect(ev.status).toBe('REJECTED');
    expect(ev.storage_key).toBeNull();
    expect(await app.storage.head(before.storage_bucket!, before.storage_key!)).toBeNull();
    expect(await auditActions(corruptId)).toContain('EVIDENCE_REJECTED');
    expect((await qm.post(`/api/v1/uploads/quarantine/${corruptId}/reject`, { reason: 'again please' })).status).toBe(409);
  });
});
