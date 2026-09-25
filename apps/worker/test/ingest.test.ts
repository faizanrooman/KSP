/**
 * Ingestion worker: real pg-boss consumer, final-failure handling (quarantine + audit + alert) and the
 * uploads.expire cron. Real Postgres + S3 + FFmpeg.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync } from 'node:fs';
import pino from 'pino';
import { QUEUES } from '@ksp/shared';
import { createDb, enqueue, loadConfig, runProcess, stopQueue, Storage, type Database } from '@ksp/core';
import { startWorker } from '../src/main.js';
import { expireUploads, handleFinalize } from '../src/jobs/ingest/handlers.js';
import type { WorkerContext } from '../src/lib/context.js';

let db: Database;
let storage: Storage;
let ctx: Pick<WorkerContext, 'db' | 'storage' | 'cfg' | 'log'>;
let uploader: string;
let station: { id: string; path: string };
const dir = join(tmpdir(), `ksp-worker-test-${process.pid}`);

async function fixture(name: string, seed: number): Promise<Buffer> {
  mkdirSync(dir, { recursive: true });
  const out = join(dir, name);
  const res = await runProcess(loadConfig().FFMPEG_PATH, [
    '-hide_banner', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=320x240:rate=25`, '-t', String(2 + seed * 0.1),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-metadata', 'location=+12.3052+076.6647/', out,
  ]);
  if (res.code !== 0) throw new Error(res.stderr);
  return readFileSync(out);
}

/** Stage a completed upload directly (what POST /uploads/:id/complete leaves behind). */
async function stageCompleted(data: Buffer, opts: { declaredSha256?: string } = {}) {
  const sessionId = randomUUID();
  const key = `uploads/test/${sessionId}`;
  const bucket = storage.bucket('staging');
  await storage.put(bucket, key, data);
  await db.insertInto('upload_sessions').values({
    id: sessionId, created_by: uploader, org_unit_id: station.id, original_filename: `${sessionId}.mp4`, declared_size: data.length,
    declared_sha256: opts.declaredSha256 ?? createHash('sha256').update(data).digest('hex'), chunk_size: 5 * 1024 * 1024, total_chunks: 1,
    staging_bucket: bucket, staging_key: key, status: 'COMPLETED', expires_at: new Date(Date.now() + 3600_000), received_bytes: data.length,
  }).execute();
  const ev = await db.insertInto('evidence').values({
    status: 'RECEIVED', org_unit_id: station.id, org_path: station.path, upload_session_id: sessionId, uploaded_by: uploader,
    original_filename: `${sessionId}.mp4`, size_bytes: data.length, storage_tier: 'STAGING', storage_bucket: bucket, storage_key: key,
  }).returning('id').executeTakeFirstOrThrow();
  await db.updateTable('upload_sessions').set({ evidence_id: ev.id }).where('id', '=', sessionId).execute();
  return { sessionId, evidenceId: ev.id, bucket, key };
}

async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, timeoutMs = 60_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 250));
  }
}

beforeAll(async () => {
  db = createDb(loadConfig().DATABASE_URL, 4).db;
  storage = new Storage();
  ctx = { db, storage, cfg: loadConfig(), log: pino({ level: 'silent' }) };
  uploader = (await db.selectFrom('users').select('id').where('username', '=', 'op.cubbon').executeTakeFirstOrThrow()).id;
  const o = await db.selectFrom('org_units').select(['id', 'path']).where('code', '=', 'ps_nazarbad').executeTakeFirstOrThrow();
  station = { id: o.id, path: o.path };
});

afterAll(async () => {
  await stopQueue();
  await db.destroy();
});

describe('ingest worker', () => {
  it('consumes INGEST_FINALIZE from the real queue and registers the evidence', async () => {
    const worker = await startWorker(['ingest']);
    try {
      const s = await stageCompleted(await fixture('queue.mp4', 1));
      await enqueue(QUEUES.INGEST_FINALIZE, { uploadSessionId: s.sessionId }, { singletonKey: `ingest:${s.sessionId}` });
      const ev = await waitFor(async () => {
        const r = await db.selectFrom('evidence').selectAll().where('id', '=', s.evidenceId).executeTakeFirst();
        return r && r.status !== 'RECEIVED' && r.status !== 'VALIDATING' ? r : undefined;
      });
      expect(ev.status).toBe('REGISTERED');
      expect(ev.evidence_number).toMatch(/^KSP-PSNAZARBAD-\d{4}-\d{6}$/);
      expect(ev.gps_source).toBe('CONTAINER_TAG');
      expect(ev.gps_latitude).toBeCloseTo(12.3052, 4);
      const job = await waitFor(() => db.selectFrom('processing_jobs').selectAll().where('upload_session_id', '=', s.sessionId).where('status', '=', 'COMPLETED').executeTakeFirst());
      expect(job.kind).toBe('VALIDATE_REGISTER');
      expect(job.evidence_id).toBe(s.evidenceId);
      expect(job.progress).toBe(1);
    } finally {
      await worker.boss.offWork(QUEUES.INGEST_FINALIZE);
      await worker.db.destroy();
    }
  });

  it('evidence numbers are sequential per station and year', async () => {
    const a = await stageCompleted(await fixture('seq-a.mp4', 2));
    const b = await stageCompleted(await fixture('seq-b.mp4', 3));
    const [ra, rb] = await Promise.all([handleFinalize(ctx, { id: randomUUID(), data: { uploadSessionId: a.sessionId } }), handleFinalize(ctx, { id: randomUUID(), data: { uploadSessionId: b.sessionId } })]);
    expect(ra?.outcome).toBe('REGISTERED');
    expect(rb?.outcome).toBe('REGISTERED');
    const nums = [ra, rb].map((r) => Number((r as { evidenceNumber: string }).evidenceNumber.split('-').pop()));
    expect(Math.abs(nums[0]! - nums[1]!)).toBe(1);
  });

  it('retries transient failures, then quarantines + audits + alerts on the final attempt', async () => {
    const s = await stageCompleted(await fixture('lost.mp4', 4));
    await storage.delete(s.bucket, s.key); // staged object vanished (storage incident)
    const jobId = randomUUID();
    await expect(handleFinalize(ctx, { id: jobId, data: { uploadSessionId: s.sessionId }, retryCount: 0, retryLimit: 2 })).rejects.toThrow(/missing/);
    expect((await db.selectFrom('evidence').select('status').where('id', '=', s.evidenceId).executeTakeFirstOrThrow()).status).toBe('VALIDATING');
    expect(await db.selectFrom('alerts').select('id').where('dedupe_key', '=', `UPLOAD_FAILED:${s.sessionId}`).executeTakeFirst()).toBeUndefined();

    await expect(handleFinalize(ctx, { id: jobId, data: { uploadSessionId: s.sessionId }, retryCount: 2, retryLimit: 2 })).rejects.toThrow(/missing/);
    const ev = await db.selectFrom('evidence').select(['status', 'status_reason']).where('id', '=', s.evidenceId).executeTakeFirstOrThrow();
    expect(ev.status).toBe('QUARANTINED');
    expect(ev.status_reason).toMatch(/^PROCESSING_FAILED: /);
    const alert = await db.selectFrom('alerts').selectAll().where('dedupe_key', '=', `UPLOAD_FAILED:${s.sessionId}`).executeTakeFirstOrThrow();
    expect(alert).toMatchObject({ rule_code: 'UPLOAD_FAILED', status: 'OPEN', resource_id: s.sessionId, org_unit_id: station.id });
    const job = await db.selectFrom('processing_jobs').selectAll().where('queue_job_id', '=', jobId).executeTakeFirstOrThrow();
    expect(job.status).toBe('FAILED');
    expect(job.attempts).toBe(2);
    const audit = await db.selectFrom('audit_events').select(['action', 'outcome']).where('resource_id', '=', s.sessionId).where('action', '=', 'UPLOAD_FAILED').executeTakeFirstOrThrow();
    expect(audit.outcome).toBe('FAILURE');
    const session = await db.selectFrom('upload_sessions').select('error').where('id', '=', s.sessionId).executeTakeFirstOrThrow();
    expect(session.error).toMatch(/missing/);
  });

  it('uploads.expire aborts expired unfinished sessions and re-requests lost finalize jobs', async () => {
    const id = randomUUID();
    const bucket = storage.bucket('staging');
    const key = `uploads/test/${id}`;
    const uploadId = await storage.createMultipart(bucket, key);
    await storage.uploadPart(bucket, key, uploadId, 1, Buffer.alloc(5 * 1024 * 1024, 1));
    await db.insertInto('upload_sessions').values({
      id, created_by: uploader, org_unit_id: station.id, original_filename: 'old.mp4', declared_size: 20 * 1024 * 1024, chunk_size: 5 * 1024 * 1024,
      total_chunks: 4, staging_bucket: bucket, staging_key: key, s3_upload_id: uploadId, status: 'UPLOADING', received_bytes: 5 * 1024 * 1024,
      expires_at: new Date(Date.now() - 60_000),
    }).execute();
    const stale = await stageCompleted(await fixture('stale.mp4', 5));
    await db.updateTable('evidence').set({ created_at: new Date(Date.now() - 3600_000) }).where('id', '=', stale.evidenceId).execute();
    const requeued: string[] = [];
    const res = await expireUploads(ctx, { enqueueFinalize: async (sid) => requeued.push(sid) });
    expect(res.expired).toBeGreaterThanOrEqual(1);
    expect(requeued).toContain(stale.sessionId);
    const s = await db.selectFrom('upload_sessions').select(['status', 'error']).where('id', '=', id).executeTakeFirstOrThrow();
    expect(s.status).toBe('EXPIRED');
    const audit = await db.selectFrom('audit_events').select('details').where('resource_id', '=', id).where('action', '=', 'UPLOAD_ABORTED').executeTakeFirstOrThrow();
    expect((audit.details as { reason: string }).reason).toBe('EXPIRED');
    // idempotent
    const again = await expireUploads(ctx, { enqueueFinalize: async () => undefined });
    expect(again.expired).toBe(0);
  });

  it('ignores malformed payloads and unknown sessions without retry storms', async () => {
    expect(await handleFinalize(ctx, { id: randomUUID(), data: { uploadSessionId: 'nope' } })).toBeNull();
    expect(await handleFinalize(ctx, { id: randomUUID(), data: { uploadSessionId: randomUUID() } })).toBeNull();
  });
});
