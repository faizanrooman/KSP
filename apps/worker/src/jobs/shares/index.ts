/**
 * Secure-sharing job module:
 *   share.watermark  burn the recipient watermark into a per-share playback variant
 *                    (derived bucket, evidence/<id>/shares/<shareId>/watermarked.mp4, kind WATERMARKED, meta.shareId)
 *   shares.expire    ACTIVE shares past expires_at -> EXPIRED (SHARE_EXPIRED custody event per item); watermarked
 *                    variants of shares that are no longer ACTIVE are deleted.
 */
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from 'kysely';
import { appendAudit, deleteShareVariants, hashStream, systemActor, type AppConfig, type Database, type Storage } from '@ksp/core';
import { burnWatermark } from '@ksp/core/custody';
import { QUEUES, SCHEDULES, type ShareWatermarkPayload } from '@ksp/shared';
import type { WorkerContext } from '../../lib/context.js';
import { ProcessingTracker } from '../../lib/processing.js';

export const SHARE_ACTOR = systemActor('share-worker');
export const shareWatermarkKey = (evidenceId: string, shareId: string) => `evidence/${evidenceId}/shares/${shareId}/watermarked.mp4`;

export interface ShareDeps {
  db: Database;
  storage: Storage;
  cfg: AppConfig;
}

export type ShareWatermarkResult = { status: 'CREATED' | 'EXISTS' | 'SKIPPED'; reason?: string; derivativeId?: string };

/**
 * One burn-in per (share, evidence) at a time. The portal enqueues on every playback/stream/print request and the
 * queue's `singletonKey` does not deduplicate on a `standard` pg-boss queue, so two jobs for the same pair routinely
 * run concurrently (localConcurrency 2). They used to share one work directory: the first to finish removed it and
 * the other failed (`ENOENT` / FFmpeg "Conversion failed!"), raising a spurious PROCESSING_FAILED alert
 * ("SHARE_WATERMARK failed for ..."). A session advisory lock serialises the pair; a job that finds the lock taken
 * skips (the running job produces the variant; the portal re-enqueues on its next poll if it did not).
 */
export async function runShareWatermark(deps: ShareDeps, p: ShareWatermarkPayload, queueJobId?: string): Promise<ShareWatermarkResult> {
  if (!/^[0-9a-f-]{36}$/i.test(p.shareId) || !/^[0-9a-f-]{36}$/i.test(p.evidenceId)) return { status: 'SKIPPED', reason: 'invalid id' };
  return deps.db.connection().execute(async (conn) => {
    const lockKey = `share-wm:${p.shareId}:${p.evidenceId}`;
    const { rows } = await sql<{ ok: boolean }>`SELECT pg_try_advisory_lock(hashtextextended(${lockKey}, 0)) AS ok`.execute(conn);
    if (!rows[0]?.ok) return { status: 'SKIPPED', reason: 'already in progress' };
    try {
      return await runShareWatermarkLocked(deps, p, queueJobId);
    } finally {
      await sql`SELECT pg_advisory_unlock(hashtextextended(${lockKey}, 0))`.execute(conn);
    }
  });
}

async function runShareWatermarkLocked(deps: ShareDeps, p: ShareWatermarkPayload, queueJobId?: string): Promise<ShareWatermarkResult> {
  const { db, storage, cfg } = deps;
  const share = await db
    .selectFrom('shares as s')
    .innerJoin('share_items as si', 'si.share_id', 's.id')
    .select(['s.id', 's.status', 's.expires_at', 's.watermark', 's.recipient_name', 's.recipient_email', 's.recipient_org', 's.created_at', 's.case_id', 's.recipient_type'])
    .where('s.id', '=', p.shareId)
    .where('si.evidence_id', '=', p.evidenceId)
    .executeTakeFirst();
  if (!share || share.status !== 'ACTIVE' || share.expires_at <= new Date() || !share.watermark || share.recipient_type !== 'EXTERNAL') return { status: 'SKIPPED', reason: 'share not active / not watermarked' };
  const key = shareWatermarkKey(p.evidenceId, p.shareId);
  const existing = await db.selectFrom('evidence_derivatives').select('id').where('object_key', '=', key).executeTakeFirst();
  if (existing) return { status: 'EXISTS', derivativeId: existing.id };
  const ev = await db.selectFrom('evidence').select(['id', 'evidence_number', 'org_unit_id', 'recorded_at', 'duration_ms', 'status']).where('id', '=', p.evidenceId).executeTakeFirstOrThrow();
  const proxy = await db.selectFrom('evidence_derivatives').selectAll().where('evidence_id', '=', ev.id).where('kind', '=', 'PROXY_MP4').executeTakeFirst();
  if (!proxy) return { status: 'SKIPPED', reason: 'no playback proxy yet' };
  const tracker = await ProcessingTracker.start(db, { kind: 'SHARE_WATERMARK', evidenceId: ev.id, queueJobId });
  // Per-run directory: never shared with another attempt, even if the lock were bypassed.
  const dir = join(cfg.WORK_DIR, `share-wm-${p.shareId}-${p.evidenceId}-${randomUUID().slice(0, 8)}`);
  await mkdir(dir, { recursive: true });
  try {
    const out = join(dir, 'watermarked.mp4');
    const pm = (proxy.meta ?? {}) as { durationMs?: number; fps?: number };
    const durationMs = pm.durationMs ?? Number(ev.duration_ms ?? 1000);
    const lines = [
      `SHARED COPY FOR ${share.recipient_name ?? 'recipient'}`,
      `${share.recipient_email ?? ''}${share.recipient_org ? ` - ${share.recipient_org}` : ''}`,
      `Share ${share.id} - issued ${share.created_at.toISOString().slice(0, 10)}`,
      `KSP ${ev.evidence_number ?? ev.id} - redistribution prohibited`,
    ];
    await burnWatermark({
      input: await storage.internalUrl(proxy.bucket, proxy.object_key, 6 * 3600),
      output: out,
      lines,
      width: proxy.width ?? 1280,
      height: proxy.height ?? 720,
      durationMs,
      recordedAt: ev.recorded_at,
      label: `SHARE ${share.id.slice(0, 8)}`,
      onProgress: (f) => void tracker.progress(f * 0.95),
    });
    const h = await hashStream(createReadStream(out));
    const bucket = storage.bucket('derived');
    await storage.put(bucket, key, createReadStream(out), { contentType: 'video/mp4', metadata: { sha256: h.sha256, 'share-id': share.id } });
    const d = await db.transaction().execute(async (tx) => {
      const row = await tx
        .insertInto('evidence_derivatives')
        .values({ evidence_id: ev.id, kind: 'WATERMARKED', bucket, object_key: key, mime_type: 'video/mp4', size_bytes: h.size, sha256: h.sha256, width: proxy.width, height: proxy.height, meta: JSON.stringify({ shareId: share.id, sourceDerivativeId: proxy.id, durationMs, fps: pm.fps ?? null, lines, generatedAt: new Date().toISOString() }) })
        .onConflict((oc) => oc.columns(['bucket', 'object_key']).doNothing())
        .returning('id')
        .executeTakeFirst();
      if (row) {
        await appendAudit(tx, SHARE_ACTOR, { action: 'SHARE_WATERMARK_GENERATED', resourceType: 'share', resourceId: share.id, evidenceId: ev.id, caseId: share.case_id, orgUnitId: ev.org_unit_id, details: { derivativeId: row.id, sha256: h.sha256, sizeBytes: h.size, sourceDerivativeId: proxy.id } });
      }
      return row;
    });
    await tracker.complete({ shareId: share.id, sha256: h.sha256 });
    return { status: 'CREATED', derivativeId: d?.id };
  } catch (err) {
    await tracker.fail(err);
    throw err;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function runSharesExpire(deps: { db: Database; storage: Storage }): Promise<{ expired: number; variantsDeleted: number }> {
  const { db, storage } = deps;
  const due = await db.selectFrom('shares').select(['id', 'case_id', 'expires_at']).where('status', '=', 'ACTIVE').where('expires_at', '<=', new Date()).limit(1000).execute();
  for (const s of due) {
    await db.transaction().execute(async (tx) => {
      const upd = await tx.updateTable('shares').set({ status: 'EXPIRED' }).where('id', '=', s.id).where('status', '=', 'ACTIVE').executeTakeFirst();
      if (!upd.numUpdatedRows) return;
      const items = await tx.selectFrom('share_items as si').innerJoin('evidence as e', 'e.id', 'si.evidence_id').select(['si.evidence_id', 'e.org_unit_id']).where('si.share_id', '=', s.id).execute();
      for (const it of items) {
        await appendAudit(tx, SHARE_ACTOR, { action: 'SHARE_EXPIRED', resourceType: 'share', resourceId: s.id, evidenceId: it.evidence_id, caseId: s.case_id, orgUnitId: it.org_unit_id, details: { expiresAt: s.expires_at.toISOString() } });
      }
    });
  }
  // Watermarked variants are only useful while the share is ACTIVE (revoke deletes them at once; this sweep covers
  // expiry, lockout and any deletion that failed). An unlocked/extended share regenerates them on demand.
  const { rows: stale } = await sql<{ share_id: string; status: string }>`
    SELECT DISTINCT s.id AS share_id, s.status FROM evidence_derivatives d
      JOIN shares s ON s.id = (d.meta->>'shareId')::uuid
     WHERE d.kind = 'WATERMARKED' AND (s.status <> 'ACTIVE' OR s.expires_at <= now())
     LIMIT 200`.execute(db);
  let deleted = 0;
  for (const s of stale) deleted += (await deleteShareVariants(db, storage, s.share_id, SHARE_ACTOR, `share ${s.status === 'ACTIVE' ? 'EXPIRED' : s.status}`)).deleted;
  return { expired: due.length, variantsDeleted: deleted };
}

export default async function register(ctx: WorkerContext): Promise<void> {
  const deps: ShareDeps = { db: ctx.db, storage: ctx.storage, cfg: ctx.cfg };
  const log = ctx.log.child({ module: 'shares' });
  await ctx.boss.work<ShareWatermarkPayload>(QUEUES.SHARE_WATERMARK, { localConcurrency: Math.max(1, Math.min(2, ctx.cfg.WORKER_CONCURRENCY)) }, async (jobs) => {
    for (const j of jobs) {
      const r = await runShareWatermark(deps, j.data, j.id);
      log.info({ ...j.data, status: r.status, reason: r.reason }, 'share watermark job');
    }
  });
  await ctx.boss.schedule('shares.expire', SCHEDULES['shares.expire']);
  await ctx.boss.work('shares.expire', async () => {
    await runSharesExpire(deps);
  });
}
