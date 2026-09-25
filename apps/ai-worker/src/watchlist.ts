/**
 * Watchlist reference embeddings: for FACE entries without an embedding for the ACTIVE recognition model, read the
 * reference image (derived bucket), detect the largest face, align + embed, store (embedding, model_id).
 */
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { appendAudit, IMAGE_FORMAT_WHITELIST, sql, systemActor } from '@ksp/core';
import type { AiContext } from './context.js';
import { analysisSize, sampleFrames, videoInfo } from './frames.js';
import { baseDetector, type ModelRow } from './models/index.js';
import { SfaceEmbedder } from './models/sface.js';
import type { RgbImage } from './image.js';

/** Tool output quotes the local temp path; never store/return server filesystem paths (shown in the admin UI). */
export function imageErrorMessage(err: Error, file: string, dir: string): string {
  return `IMAGE_UNREADABLE: ${err.message.split(file).join('<reference-image>').split(dir).join('<work-dir>').slice(0, 300)}`;
}

export async function loadStill(path: string): Promise<RgbImage> {
  const info = await videoInfo(path, IMAGE_FORMAT_WHITELIST);
  const size = analysisSize(info.width, info.height, 1600);
  for await (const f of sampleFrames(path, { fps: 0, width: size.width, height: size.height })) return f.image;
  throw new Error('image could not be decoded');
}

export async function embedPendingWatchlistEntries(ctx: AiContext, limit = 25): Promise<{ embedded: number; failed: number }> {
  const active = (await ctx.db.selectFrom('ai_models').selectAll().where('status', '=', 'ACTIVE').where('task', 'in', ['FACE_RECOGNITION', 'FACE_DETECTION']).execute()) as unknown as ModelRow[];
  const rec = active.find((m) => m.task === 'FACE_RECOGNITION' && m.config.architecture === 'sface');
  const det = active.find((m) => m.task === 'FACE_DETECTION' && m.config.architecture === 'yunet');
  if (!rec || !det) return { embedded: 0, failed: 0 };
  const pending = await ctx.db
    .selectFrom('ai_watchlist_entries as e')
    .innerJoin('ai_watchlists as w', 'w.id', 'e.watchlist_id')
    .select(['e.id', 'e.image_key', 'e.watchlist_id', 'w.org_unit_id'])
    .where('w.kind', '=', 'FACE')
    .where('e.image_key', 'is not', null)
    .where('e.embedding_error', 'is', null)
    .where((eb) => eb.or([eb('e.embedding', 'is', null), eb('e.model_id', 'is distinct from', rec.id)]))
    .orderBy('e.created_at')
    .limit(limit)
    .execute();
  if (!pending.length) return { embedded: 0, failed: 0 };
  const faces = baseDetector(det);
  const embedder = new SfaceEmbedder(rec);
  await Promise.all([faces.load(), embedder.load()]);
  const dir = join(ctx.cfg.WORK_DIR, 'ai', 'watchlist');
  await mkdir(dir, { recursive: true });
  let embedded = 0, failed = 0;
  for (const e of pending) {
    const file = join(dir, `${e.id}.img`);
    let error: string | null = null;
    let embedding: number[] | null = null;
    let faceCount = 0;
    try {
      const derived = ctx.storage.bucket('derived');
      if (!e.image_key!.startsWith('ai/watchlists/')) throw new Error('reference image outside the watchlist prefix');
      await writeFile(file, await ctx.storage.getBuffer(derived, e.image_key!));
      const img = await loadStill(file);
      const found = await faces.detect(img, 0.6);
      faceCount = found.length;
      const largest = found.sort((a, b) => (b.box.x2 - b.box.x1) * (b.box.y2 - b.box.y1) - (a.box.x2 - a.box.x1) * (a.box.y2 - a.box.y1))[0];
      if (!largest?.landmarks) error = 'NO_FACE_FOUND: no face detected in the reference image';
      else embedding = Array.from(await embedder.embed(img, largest.landmarks));
    } catch (err) {
      error = imageErrorMessage(err as Error, file, dir);
    } finally {
      await rm(file, { force: true });
    }
    await ctx.db.transaction().execute(async (tx) => {
      await sql`UPDATE ai_watchlist_entries SET embedding = ${embedding}::real[], model_id = ${embedding ? rec.id : null}::uuid,
                 embedding_error = ${error}, embedded_at = now() WHERE id = ${e.id}::uuid`.execute(tx);
      await appendAudit(tx, systemActor(ctx.workerName), {
        action: 'AI_WATCHLIST_EMBEDDED', outcome: error ? 'FAILURE' : 'SUCCESS', resourceType: 'ai_watchlist_entry', resourceId: e.id,
        orgUnitId: e.org_unit_id, details: { watchlistId: e.watchlist_id, model: `${rec.code}@${rec.version}`, facesInImage: faceCount, error },
      });
    });
    if (error) failed++;
    else embedded++;
  }
  return { embedded, failed };
}

/** Jobs RUNNING without a heartbeat for `staleMinutes` (worker crashed) are failed so they do not hang forever. */
export async function reapStaleJobs(ctx: AiContext, staleMinutes = 10): Promise<number> {
  return ctx.db.transaction().execute(async (tx) => {
    const { rows } = await sql<{ id: string; evidence_id: string; input: { orgUnitId?: string } }>`
      UPDATE ai_jobs SET status = 'FAILED', finished_at = now(), error = 'WORKER_LOST: no heartbeat from the AI worker'
       WHERE status = 'RUNNING' AND coalesce((stats->>'heartbeatAt')::timestamptz, started_at) < now() - make_interval(mins => ${staleMinutes})
      RETURNING id, evidence_id, input`.execute(tx);
    for (const r of rows) {
      await appendAudit(tx, systemActor(ctx.workerName), {
        action: 'AI_ANALYSIS_FAILED', outcome: 'FAILURE', resourceType: 'ai_job', resourceId: r.id, evidenceId: r.evidence_id,
        orgUnitId: r.input?.orgUnitId ?? null, details: { error: 'WORKER_LOST' },
      });
    }
    return rows.length;
  });
}
