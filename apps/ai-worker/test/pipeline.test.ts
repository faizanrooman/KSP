/** End-to-end AI jobs as ksp_ai: real proxy video, real inference, crops, audit, cancel, failure, watchlists, isolation. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { sql, storage } from '@ksp/core';
import { fetchAndRegisterModels } from '../src/models/manifest.js';
import { claimJob, runJob } from '../src/pipeline.js';
import { drainJobs } from '../src/main.js';
import { embedPendingWatchlistEntries, reapStaleJobs } from '../src/watchlist.js';
import { aiCtx, appDb, auditFor, closeAll, evidenceWithProxy, queueJob, userId } from './helpers.js';
import { slideshow, tryEnsureImages } from './media.js';

const MEDIA = await tryEnsureImages();
if (!MEDIA.images) console.warn(`[ai-worker tests] SKIPPING pipeline tests that need imagery: ${MEDIA.reason}`);

let video = '';
beforeAll(async () => {
  const res = await fetchAndRegisterModels(appDb());
  const failed = res.filter((r) => !r.ok);
  if (failed.length) console.warn('[ai-worker tests] models unavailable:', failed.map((f) => `${f.code}: ${f.error}`).join('; '));
  if (MEDIA.images) {
    const i = MEDIA.images;
    video = await slideshow([i.street, i.crowd, i.portrait, i.plate], [3, 3, 3, 3], 'ai-e2e-12s');
  }
});
afterAll(closeAll);

describe.skipIf(!MEDIA.images)('AI job end-to-end (ksp_ai)', () => {
  it('runs all tasks on the proxy, stores PENDING detections with provenance, crops and audit', async () => {
    const ev = await evidenceWithProxy(video);
    const jobId = await queueJob(ev, ['PERSON_DETECTION', 'OBJECT_DETECTION', 'FACE_DETECTION', 'ANPR', 'CLASSIFICATION'], { sampleFps: 2, crowdMinPersons: 8 });
    const ctx = aiCtx();
    const t0 = Date.now();
    expect(await drainJobs(ctx, 1)).toBe(1);
    const wall = Date.now() - t0;
    const job = await appDb().selectFrom('ai_jobs').selectAll().where('id', '=', jobId).executeTakeFirstOrThrow();
    expect(job.error).toBeNull();
    expect(job.status).toBe('COMPLETED');
    expect(job.progress).toBe(1);
    const stats = job.stats as Record<string, number & Record<string, number>>;
    expect(stats.framesProcessed).toBeGreaterThanOrEqual(22);
    console.log(`[throughput] e2e job: ${stats.framesProcessed} frames @2fps of 12 s video, ${stats.msPerFrame} ms/frame inference (5 tasks), wall ${wall} ms, detections ${JSON.stringify(stats.detections)}`);

    const dets = await appDb().selectFrom('ai_detections').selectAll().where('job_id', '=', jobId).execute();
    const by = (t: string) => dets.filter((d) => d.task === t);
    expect(by('PERSON_DETECTION').length).toBeGreaterThanOrEqual(5);
    expect(by('OBJECT_DETECTION').some((d) => ['car', 'truck', 'motorcycle', 'bus'].includes(d.label))).toBe(true);
    const faces = by('FACE_DETECTION');
    expect(faces.some((f) => f.frame_time_ms >= 6000 && f.frame_time_ms < 9000 && f.confidence > 0.85)).toBe(true); // the portrait segment
    const plates = by('ANPR');
    expect(plates.some((p) => p.label === 'IJZ8992' && (p.attributes as { plateText: string }).plateText === 'IJZ8992' && p.frame_time_ms >= 9000)).toBe(true);
    const tags = by('CLASSIFICATION').map((d) => d.label);
    expect(tags).toEqual(expect.arrayContaining(['person', 'vehicle', 'crowd']));

    // dedupe: a static scene sampled 6 times yields far fewer stored detections than raw detections
    expect(dets.length).toBeLessThan(Number(stats.rawDetections));
    const tracks = new Set(by('PERSON_DETECTION').map((d) => d.track_id));
    expect(tracks.size).toBe(by('PERSON_DETECTION').length); // keepEveryMs=10s > segment length: one per track

    for (const d of dets) {
      expect(d.review_status).toBe('PENDING');
      expect(d.reviewed_by).toBeNull();
      expect(d.model_code).toBeTruthy();
      expect(d.threshold).toBeGreaterThan(0);
      expect(d.confidence).toBeGreaterThanOrEqual(d.threshold - 1e-6);
      if (d.task !== 'CLASSIFICATION') {
        for (const v of [d.bbox_x, d.bbox_y, d.bbox_w, d.bbox_h]) expect(v! >= 0 && v! <= 1).toBe(true);
        expect(d.frame_number).toBe(Math.round((d.frame_time_ms / 1000) * 25));
      }
    }
    const person = by('PERSON_DETECTION')[0]!;
    expect((person.attributes as { colorName?: string }).colorName).toBeTruthy();
    expect(person.crop_key).toBe(`evidence/${ev.id}/ai/${jobId}/${person.id}.jpg`);
    const crop = await storage().getBuffer(storage().bucket('derived'), person.crop_key!);
    expect(crop.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true);

    const audit = await auditFor(jobId);
    expect(audit.map((a) => a.action)).toEqual(['AI_ANALYSIS_STARTED', 'AI_ANALYSIS_COMPLETED']);
    for (const a of audit) {
      expect(a.actor_type).toBe('SYSTEM');
      expect(a.actor_id).toMatch(/^ai-worker@/);
      expect(a.evidence_id).toBe(ev.id);
    }
    // the original evidence object is untouched and never read: its row is unchanged
    const orig = await appDb().selectFrom('evidence').select(['sha256', 'storage_key']).where('id', '=', ev.id).executeTakeFirstOrThrow();
    expect(orig.sha256).toBe(ev.sha256);
  });

  it('matches a FACE watchlist entry (embedding computed by the worker) and flags no identity otherwise', async () => {
    const db = appDb();
    const org = await db.selectFrom('org_units').select(['id']).where('code', '=', 'blr_city').executeTakeFirstOrThrow();
    const wl = await db.insertInto('ai_watchlists').values({ name: 'Test POI', kind: 'FACE', org_unit_id: org.id, created_by: await userId('fa.naveen') }).returning('id').executeTakeFirstOrThrow();
    const st = storage();
    const mk = async (label: string, file: string) => {
      const e = await db.insertInto('ai_watchlist_entries').values({ watchlist_id: wl.id, label }).returning('id').executeTakeFirstOrThrow();
      const key = `ai/watchlists/${wl.id}/${e.id}.jpg`;
      await st.put(st.bucket('derived'), key, await readFile(file), { contentType: 'image/jpeg' });
      await db.updateTable('ai_watchlist_entries').set({ image_key: key }).where('id', '=', e.id).execute();
      return e.id;
    };
    const poi = await mk('Person of interest A', MEDIA.images!.portrait);
    const noFace = await mk('Bad reference', MEDIA.images!.plate);
    const r = await embedPendingWatchlistEntries(aiCtx());
    const rows = await db.selectFrom('ai_watchlist_entries').select(['id', 'embedding', 'embedding_error', 'model_id']).where('watchlist_id', '=', wl.id).execute();
    const good = rows.find((x) => x.id === poi)!;
    expect(good.embedding_error).toBeNull();
    expect(r).toEqual({ embedded: 1, failed: 1 });
    expect(good.embedding).toHaveLength(128);
    expect(good.model_id).toBeTruthy();
    expect(rows.find((x) => x.id === noFace)!.embedding_error).toMatch(/^NO_FACE_FOUND/);

    const ev = await evidenceWithProxy(video);
    const jobId = await queueJob(ev, ['FACE_RECOGNITION'], { sampleFps: 1, watchlistIds: [wl.id] });
    await drainJobs(aiCtx(), 1);
    const job = await db.selectFrom('ai_jobs').select(['status', 'error']).where('id', '=', jobId).executeTakeFirstOrThrow();
    expect(job).toEqual({ status: 'COMPLETED', error: null });
    const dets = await db.selectFrom('ai_detections').selectAll().where('job_id', '=', jobId).execute();
    expect(dets.length).toBeGreaterThanOrEqual(1);
    for (const d of dets) {
      expect(d.task).toBe('FACE_RECOGNITION');
      expect(d.label).toBe('Person of interest A');
      expect(d.frame_time_ms).toBeGreaterThanOrEqual(6000); // only the portrait segment matches
      expect(d.frame_time_ms).toBeLessThan(9000);
      const a = d.attributes as { watchlistEntryId: string; similarity: number };
      expect(a.watchlistEntryId).toBe(poi);
      expect(a.similarity).toBeGreaterThan(0.5);
      expect(d.embedding).toHaveLength(128);
    }
  });

  it('stops when the API cancels the job (status stays CANCELLED, no further detections)', async () => {
    const i = MEDIA.images!;
    const long = await slideshow([i.street, i.crowd, i.street, i.crowd], [10, 10, 10, 10], 'ai-cancel-40s');
    const ev = await evidenceWithProxy(long);
    const jobId = await queueJob(ev, ['OBJECT_DETECTION', 'FACE_DETECTION'], { sampleFps: 4, keepEveryMs: 1000 });
    const ctx = aiCtx();
    const job = await claimJob(ctx);
    expect(job?.id).toBe(jobId);
    const run = runJob(ctx, job!);
    const db = appDb();
    for (let n = 0; n < 200; n++) {
      const j = await db.selectFrom('ai_jobs').select('progress').where('id', '=', jobId).executeTakeFirstOrThrow();
      if (j.progress > 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await sql`UPDATE ai_jobs SET status = 'CANCELLED', finished_at = now() WHERE id = ${jobId}::uuid`.execute(db);
    expect(await run).toBe('CANCELLED');
    const after = await db.selectFrom('ai_jobs').select(['status', 'progress']).where('id', '=', jobId).executeTakeFirstOrThrow();
    expect(after.status).toBe('CANCELLED');
    expect(after.progress).toBeLessThan(1);
    const count = async () => Number((await db.selectFrom('ai_detections').select(sql<number>`count(*)`.as('n')).where('job_id', '=', jobId).executeTakeFirstOrThrow()).n);
    const n1 = await count();
    await new Promise((r) => setTimeout(r, 500));
    expect(await count()).toBe(n1);
  });
});

describe('AI job failures', () => {
  it('fails with PROXY_NOT_FOUND when the derivative is missing, and audits the failure', async () => {
    const i = MEDIA.images;
    const ev = await evidenceWithProxy(i ? await slideshow([i.street], [1], 'ai-1s') : await slideshowFallback());
    const jobId = await queueJob(ev, ['PERSON_DETECTION'], {}, { derivativeKey: `evidence/${ev.id}/proxy/missing.mp4` });
    await drainJobs(aiCtx(), 1);
    const job = await appDb().selectFrom('ai_jobs').select(['status', 'error', 'finished_at']).where('id', '=', jobId).executeTakeFirstOrThrow();
    expect(job.status).toBe('FAILED');
    expect(job.error).toMatch(/^PROXY_NOT_FOUND/);
    expect(job.finished_at).toBeTruthy();
    const audit = await auditFor(jobId);
    expect(audit.map((a) => a.action)).toEqual(['AI_ANALYSIS_STARTED', 'AI_ANALYSIS_FAILED']);
    expect(audit[1]!.outcome).toBe('FAILURE');
  });

  it('refuses inputs outside the derived bucket or belonging to another evidence item', async () => {
    const ev = await evidenceWithProxy(await slideshowFallback());
    const other = await queueJob(ev, ['PERSON_DETECTION'], {}, { derivativeBucket: 'ksptest-evidence-anything' });
    const cross = await queueJob(ev, ['PERSON_DETECTION'], {}, { derivativeKey: 'evidence/00000000-0000-0000-0000-000000000000/proxy/proxy.mp4' });
    await drainJobs(aiCtx(), 2);
    const rows = await appDb().selectFrom('ai_jobs').select(['id', 'status', 'error']).where('id', 'in', [other, cross]).execute();
    expect(rows.find((r) => r.id === other)!.error).toMatch(/^INPUT_NOT_DERIVED/);
    expect(rows.find((r) => r.id === cross)!.error).toMatch(/^INPUT_KEY_MISMATCH/);
  });

  it('fails jobs whose worker stopped heart-beating', async () => {
    const ev = await evidenceWithProxy(await slideshowFallback());
    const jobId = await queueJob(ev, ['PERSON_DETECTION']);
    await sql`UPDATE ai_jobs SET status = 'RUNNING', started_at = now() - interval '1 hour', stats = jsonb_build_object('heartbeatAt', now() - interval '1 hour') WHERE id = ${jobId}::uuid`.execute(appDb());
    expect(await reapStaleJobs(aiCtx(), 10)).toBeGreaterThanOrEqual(1);
    const j = await appDb().selectFrom('ai_jobs').select(['status', 'error']).where('id', '=', jobId).executeTakeFirstOrThrow();
    expect(j).toEqual({ status: 'FAILED', error: 'WORKER_LOST: no heartbeat from the AI worker' });
  });
});

let fallback: Promise<string> | undefined;
async function slideshowFallback(): Promise<string> {
  const { ffmpeg, loadConfig } = await import('@ksp/core');
  return (fallback ??= (async () => {
    const out = `${loadConfig().WORK_DIR}/ai-testsrc.mp4`;
    await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', out]);
    return out;
  })());
}

describe('ksp_ai least privilege (database enforced)', () => {
  const denied = async (q: Promise<unknown>) => {
    const err = await q.then(() => null, (e: { code?: string; message?: string }) => e);
    expect(err, 'statement should have been rejected').not.toBeNull();
    expect(err!.code).toBe('42501');
  };
  it('cannot read evidence, users, sessions, cases or the audit ledger', async () => {
    const db = aiCtx().db;
    await denied(sql`SELECT storage_key FROM evidence LIMIT 1`.execute(db));
    await denied(sql`SELECT id FROM evidence LIMIT 1`.execute(db));
    await denied(sql`SELECT password_hash FROM users LIMIT 1`.execute(db));
    await denied(sql`SELECT id FROM sessions LIMIT 1`.execute(db));
    await denied(sql`SELECT id FROM cases LIMIT 1`.execute(db));
    await denied(sql`SELECT seq FROM audit_events LIMIT 1`.execute(db));
    await denied(sql`SELECT id FROM evidence_derivatives LIMIT 1`.execute(db));
    await denied(sql`SELECT requested_by FROM ai_jobs LIMIT 1`.execute(db));
    await denied(sql`SELECT review_status FROM ai_detections LIMIT 1`.execute(db));
  });

  it('cannot change review decisions, models, tags or job ownership', async () => {
    const db = aiCtx().db;
    await denied(sql`UPDATE ai_detections SET review_status = 'APPROVED'`.execute(db));
    await denied(sql`UPDATE ai_detections SET reviewed_by = NULL, corrected_label = 'x'`.execute(db));
    await denied(sql`DELETE FROM ai_detections`.execute(db));
    await denied(sql`UPDATE ai_models SET status = 'ACTIVE'`.execute(db));
    await denied(sql`INSERT INTO ai_models (code, name, task, version, artifact_uri) VALUES ('x','x','ANPR','1','x')`.execute(db));
    await denied(sql`UPDATE ai_jobs SET requested_by = NULL`.execute(db));
    await denied(sql`UPDATE ai_jobs SET evidence_id = NULL`.execute(db));
    await denied(sql`INSERT INTO evidence_tags (evidence_id, tag) VALUES (gen_random_uuid(), 'x')`.execute(db));
    await denied(sql`INSERT INTO ai_review_events (detection_id, reviewer_id, action, previous_status, new_status, model_id, model_version, confidence) VALUES (gen_random_uuid(), gen_random_uuid(), 'APPROVE', 'PENDING', 'APPROVED', gen_random_uuid(), '1', 0.9)`.execute(db));
    await denied(sql`UPDATE ai_watchlist_entries SET label = 'x'`.execute(db));
    await denied(sql`INSERT INTO audit_events (seq, occurred_at, actor_type, action, category, outcome, prev_hash, hash) VALUES (999999, now(), 'SYSTEM', 'X', 'AI', 'SUCCESS', 'a', 'b')`.execute(db));
  });

  it('cannot insert pre-reviewed detections, or detections for non-running jobs / other evidence', async () => {
    const ev = await evidenceWithProxy(await slideshowFallback());
    const jobId = await queueJob(ev, ['PERSON_DETECTION']);
    const model = await appDb().selectFrom('ai_models').select(['id']).where('code', '=', 'yolox-s-person').where('status', '=', 'ACTIVE').executeTakeFirstOrThrow();
    const db = aiCtx().db;
    const base = { job_id: jobId, evidence_id: ev.id, model_id: model.id, model_code: 'forged', model_version: 'forged', task: 'PERSON_DETECTION', label: 'person', confidence: 0.9, threshold: 0.5, frame_time_ms: 0 };
    // review columns are not insertable by ksp_ai
    await denied(sql`INSERT INTO ai_detections (job_id, evidence_id, model_id, model_code, model_version, task, label, confidence, threshold, frame_time_ms, review_status)
                     VALUES (${jobId}::uuid, ${ev.id}::uuid, ${model.id}::uuid, 'x', '1', 'PERSON_DETECTION', 'person', 0.9, 0.5, 0, 'APPROVED')`.execute(db));
    // job is QUEUED, not RUNNING -> guard trigger rejects
    await denied(db.insertInto('ai_detections').values(base).execute());
    await sql`UPDATE ai_jobs SET status = 'RUNNING' WHERE id = ${jobId}::uuid`.execute(appDb());
    const other = await evidenceWithProxy(await slideshowFallback());
    await denied(db.insertInto('ai_detections').values({ ...base, evidence_id: other.id }).execute());
    // allowed insert: provenance is overwritten from the registry
    const ok = await db.insertInto('ai_detections').values(base).returning('id').executeTakeFirstOrThrow();
    const row = await appDb().selectFrom('ai_detections').select(['model_code', 'model_version', 'review_status']).where('id', '=', ok.id).executeTakeFirstOrThrow();
    expect(row.model_code).toBe('yolox-s-person');
    expect(row.model_version).not.toBe('forged');
    expect(row.review_status).toBe('PENDING');
    await sql`UPDATE ai_jobs SET status = 'FAILED' WHERE id = ${jobId}::uuid`.execute(appDb());
  });
});
