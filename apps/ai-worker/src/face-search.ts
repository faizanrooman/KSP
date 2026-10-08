/**
 * Repository-wide suspect (face) search (tender §20). Runs as ksp_ai.
 *
 *   1. claim a QUEUED face_searches row (FOR UPDATE SKIP LOCKED)
 *   2. read the probe image from the derived bucket (ai/face-searches/<id>/…), detect the largest face, embed it with
 *      the ACTIVE recognition model
 *   3. stream every stored face embedding of that model (FACE_RECOGNITION rows + FACE_DETECTION rows embedded by the
 *      pipeline) and compute cosine similarity in memory — 1 lakh 128-d vectors take well under a second
 *   4. write the top-K matches above the threshold; the API filters them by the requester's evidence visibility
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appendAudit, sql, systemActor } from '@ksp/core';
import type { AiContext } from './context.js';
import { baseDetector } from './models/index.js';
import { cosine, SfaceEmbedder } from './models/sface.js';
import type { ModelRow } from './models/types.js';
import { imageErrorMessage, loadStill } from './watchlist.js';

export interface FaceSearchMatch {
  detectionId: string;
  evidenceId: string;
  similarity: number;
  frameTimeMs: number | null;
}

interface Claimed {
  id: string;
  probe_key: string;
  params: { threshold?: number; limit?: number };
  requested_by: string;
  org_unit_id: string;
}

const PROBE_PREFIX = 'ai/face-searches/';
const PAGE = 20_000;

/** Scan all stored embeddings of `modelId` against `probe`, keeping the best `limit` above `threshold`. */
export async function scanEmbeddings(ctx: AiContext, modelId: string, probe: Float32Array, threshold: number, limit: number): Promise<{ matches: FaceSearchMatch[]; candidates: number }> {
  const top: FaceSearchMatch[] = [];
  let worst = -1;
  let candidates = 0;
  let after: string | null = null;
  for (;;) {
    const { rows } = await sql<{ id: string; evidence_id: string; frame_time_ms: number | null; embedding: number[] }>`
      SELECT id, evidence_id, frame_time_ms, embedding FROM ai_detections
      WHERE embedding IS NOT NULL
        AND ((task = 'FACE_RECOGNITION' AND model_id = ${modelId}::uuid) OR (task = 'FACE_DETECTION' AND attributes->>'embeddingModelId' = ${modelId}))
        AND (${after}::uuid IS NULL OR id > ${after}::uuid)
      ORDER BY id LIMIT ${PAGE}`.execute(ctx.db);
    for (const r of rows) {
      candidates++;
      const sim = cosine(probe, r.embedding);
      if (sim < threshold || (top.length >= limit && sim <= worst)) continue;
      top.push({ detectionId: r.id, evidenceId: r.evidence_id, similarity: Math.round(sim * 10000) / 10000, frameTimeMs: r.frame_time_ms });
      top.sort((a, b) => b.similarity - a.similarity);
      if (top.length > limit) top.pop();
      worst = top.length >= limit ? top[top.length - 1]!.similarity : -1;
    }
    if (rows.length < PAGE) break;
    after = rows[rows.length - 1]!.id;
  }
  return { matches: top, candidates };
}

export async function processFaceSearches(ctx: AiContext, max = 10): Promise<number> {
  let n = 0;
  while (n < max) {
    const claimed = await ctx.db.transaction().execute(async (tx) => {
      const { rows } = await sql<Claimed>`
        UPDATE face_searches SET status = 'RUNNING', started_at = now()
         WHERE id = (SELECT id FROM face_searches WHERE status = 'QUEUED' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
         RETURNING id, probe_key, params, requested_by, org_unit_id`.execute(tx);
      return rows[0] ?? null;
    });
    if (!claimed) break;
    n++;
    await runFaceSearch(ctx, claimed).catch((err) => ctx.log.error({ err, id: claimed.id }, 'face search crashed'));
  }
  return n;
}

async function runFaceSearch(ctx: AiContext, fs: Claimed): Promise<void> {
  const t0 = Date.now();
  const dir = join(ctx.cfg.WORK_DIR, 'ai', 'face-search');
  const file = join(dir, `${fs.id}.img`);
  let error: string | null = null;
  let result: FaceSearchMatch[] = [];
  const stats: Record<string, unknown> = { worker: ctx.workerName };
  let rec: ModelRow | undefined;
  try {
    const models = (await ctx.db.selectFrom('ai_models').selectAll().where('status', '=', 'ACTIVE').where('task', 'in', ['FACE_DETECTION', 'FACE_RECOGNITION']).execute()) as unknown as ModelRow[];
    const det = models.find((m) => m.task === 'FACE_DETECTION');
    rec = models.find((m) => m.task === 'FACE_RECOGNITION');
    if (!det || !rec) throw new Error('MODEL_MISSING: an ACTIVE face detection and face recognition model are required');
    if (!fs.probe_key.startsWith(PROBE_PREFIX)) throw new Error('probe outside the face-search prefix');
    await mkdir(dir, { recursive: true });
    await writeFile(file, await ctx.storage.getBuffer(ctx.storage.bucket('derived'), fs.probe_key));
    const faces = baseDetector(det);
    const embedder = new SfaceEmbedder(rec);
    await Promise.all([faces.load(), embedder.load()]);
    const img = await loadStill(file);
    const tDet = Date.now();
    const found = await faces.detect(img, 0.6);
    stats.probeFaces = found.length;
    const largest = found.sort((a, b) => (b.box.x2 - b.box.x1) * (b.box.y2 - b.box.y1) - (a.box.x2 - a.box.x1) * (a.box.y2 - a.box.y1))[0];
    if (!largest?.landmarks) throw new Error('NO_FACE_FOUND: no face detected in the probe image');
    const probe = await embedder.embed(img, largest.landmarks);
    stats.embedMs = Date.now() - tDet;
    const threshold = typeof fs.params.threshold === 'number' ? fs.params.threshold : rec.default_threshold;
    const limit = Math.min(500, Math.max(1, fs.params.limit ?? 50));
    const tScan = Date.now();
    const scan = await scanEmbeddings(ctx, rec.id, probe, threshold, limit);
    stats.scanMs = Date.now() - tScan;
    stats.candidates = scan.candidates;
    stats.threshold = threshold;
    result = scan.matches;
  } catch (err) {
    error = imageErrorMessage(err as Error, file, dir);
  } finally {
    await rm(file, { force: true });
  }
  stats.totalMs = Date.now() - t0;
  await ctx.db.transaction().execute(async (tx) => {
    await sql`UPDATE face_searches SET status = ${error ? 'FAILED' : 'COMPLETED'}, finished_at = now(), model_id = ${rec?.id ?? null}::uuid,
               result = ${error ? null : JSON.stringify(result)}::jsonb, stats = ${JSON.stringify(stats)}::jsonb, error = ${error}
             WHERE id = ${fs.id}::uuid`.execute(tx);
    await appendAudit(tx, systemActor(ctx.workerName), {
      action: error ? 'AI_FACE_SEARCH_FAILED' : 'AI_FACE_SEARCH_COMPLETED',
      outcome: error ? 'FAILURE' : 'SUCCESS',
      resourceType: 'face_search',
      resourceId: fs.id,
      orgUnitId: fs.org_unit_id,
      details: { requestedBy: fs.requested_by, matches: result.length, candidates: stats.candidates ?? 0, totalMs: stats.totalMs, error },
    });
  });
}
