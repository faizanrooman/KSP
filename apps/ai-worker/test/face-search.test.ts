/**
 * Tender §20 — repository-wide suspect search with REAL inference: the portrait test image is embedded and stored as
 * a face detection; a face search with the same photograph as probe must find it with high similarity, while an
 * unrelated face must not pass the threshold.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { sql } from '@ksp/core';
import { processFaceSearches } from '../src/face-search.js';
import { baseDetector } from '../src/models/index.js';
import { fetchAndRegisterModels } from '../src/models/manifest.js';
import { SfaceEmbedder } from '../src/models/sface.js';
import type { ModelRow } from '../src/models/types.js';
import { loadStill } from '../src/watchlist.js';
import { aiCtx, appDb, closeAll, evidenceWithProxy, queueJob, userId } from './helpers.js';
import { slideshow, tryEnsureImages } from './media.js';

let images: Record<string, string> | null = null;
let skipReason: string | null = null;

beforeAll(async () => {
  // Register the pinned models from the local cache into the (freshly rebuilt) test database, as pipeline.test does.
  await fetchAndRegisterModels(appDb()).catch(() => undefined);
  const r = await tryEnsureImages();
  images = r.images;
  skipReason = r.reason;
});
afterAll(closeAll);

describe('face search (real inference)', () => {
  it('finds the stored face of the probe person and ignores other faces', async (ctx) => {
    if (!images) return ctx.skip(skipReason ?? 'no test imagery');
    const db = appDb();
    const models = (await db.selectFrom('ai_models').selectAll().where('status', '=', 'ACTIVE').where('task', 'in', ['FACE_DETECTION', 'FACE_RECOGNITION']).execute()) as unknown as ModelRow[];
    const det = models.find((m) => m.task === 'FACE_DETECTION');
    const rec = models.find((m) => m.task === 'FACE_RECOGNITION');
    if (!det || !rec) return ctx.skip('face models not registered');

    // Arrange: one stored face embedding for the portrait, one for the crowd (different people)
    const faces = baseDetector(det);
    const embedder = new SfaceEmbedder(rec);
    await Promise.all([faces.load(), embedder.load()]);
    const embedOf = async (file: string) => {
      const img = await loadStill(file);
      const found = (await faces.detect(img, 0.6)).filter((f) => f.landmarks).sort((a, b) => (b.box.x2 - b.box.x1) - (a.box.x2 - a.box.x1));
      if (!found[0]) throw new Error(`no face detected in ${file}`);
      return Array.from(await embedder.embed(img, found[0].landmarks!));
    };
    const portraitEmb = await embedOf(images.portrait!);
    // a different "person": a random unit vector is what an unrelated face looks like to the matcher (cosine ≈ 0)
    const rnd = Array.from({ length: 128 }, () => Math.random() * 2 - 1);
    const n = Math.hypot(...rnd);
    const crowdEmb = rnd.map((x) => x / n);
    const video = await slideshow([images.portrait!], [2], 'face-search-fixture');
    const ev = await evidenceWithProxy(video);
    const jobId = await queueJob(ev, ['FACE_RECOGNITION']);
    await db.updateTable('ai_jobs').set({ status: 'COMPLETED' }).where('id', '=', jobId).execute();
    const insertDet = (emb: number[], ms: number) =>
      db.insertInto('ai_detections').values({ job_id: jobId, evidence_id: ev.id, model_id: rec.id, model_code: rec.code, model_version: rec.version, task: 'FACE_RECOGNITION', label: 'face', confidence: 0.9, threshold: 0.5, frame_time_ms: ms, attributes: '{}', embedding: emb }).returning('id').executeTakeFirstOrThrow();
    const dPortrait = (await insertDet(portraitEmb, 1000)).id;
    const dCrowd = (await insertDet(crowdEmb, 2000)).id;

    // Act: queue a face search whose probe is the same portrait, run the worker
    const worker = aiCtx();
    const id = randomUUID();
    const key = `ai/face-searches/${id}/probe.jpg`;
    await worker.storage.put(worker.storage.bucket('derived'), key, await readFile(images.portrait!), { contentType: 'image/jpeg' });
    await db.insertInto('face_searches').values({ id, requested_by: await userId('io.meera'), org_unit_id: ev.orgUnitId, probe_key: key, params: JSON.stringify({ threshold: 0.4, limit: 10 }) }).execute();
    const t0 = Date.now();
    expect(await processFaceSearches(worker)).toBe(1);
    const elapsed = Date.now() - t0;

    // Assert
    const row = await db.selectFrom('face_searches').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.status).toBe('COMPLETED');
    const matches = row.result as Array<{ detectionId: string; similarity: number; evidenceId: string }>;
    expect(matches[0]).toMatchObject({ detectionId: dPortrait, evidenceId: ev.id });
    expect(matches[0]!.similarity).toBeGreaterThan(0.9);
    expect(matches.some((m) => m.detectionId === dCrowd)).toBe(false);
    expect((row.stats as { candidates: number }).candidates).toBeGreaterThanOrEqual(2);
    expect(elapsed).toBeLessThan(60_000);
    const { rows } = await sql<{ action: string }>`SELECT action FROM audit_events WHERE resource_id = ${id}`.execute(db);
    expect(rows.map((r) => r.action)).toContain('AI_FACE_SEARCH_COMPLETED');
  });

  it('fails cleanly when the probe has no face', async (ctx) => {
    if (!images) return ctx.skip(skipReason ?? 'no test imagery');
    const db = appDb();
    const worker = aiCtx();
    const id = randomUUID();
    const key = `ai/face-searches/${id}/probe.png`;
    await worker.storage.put(worker.storage.bucket('derived'), key, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'), { contentType: 'image/png' });
    await db.insertInto('face_searches').values({ id, requested_by: await userId('io.meera'), org_unit_id: (await db.selectFrom('org_units').select('id').where('code', '=', 'ps_cubbonpark').executeTakeFirstOrThrow()).id, probe_key: key, params: '{}' }).execute();
    await processFaceSearches(worker);
    const row = await db.selectFrom('face_searches').select(['status', 'error']).where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.status).toBe('FAILED');
    expect(row.error).toMatch(/NO_FACE_FOUND|image/i);
  });
});
