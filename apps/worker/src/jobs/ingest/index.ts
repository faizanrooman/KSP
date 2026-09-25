/**
 * Ingestion worker: INGEST_FINALIZE (hash → validate → metadata → dedupe → register | quarantine) and the
 * uploads.expire cron. Pipeline logic lives in @ksp/core (ingest/pipeline.ts) so the quarantine-release
 * API registers evidence through the same code path.
 */
import { QUEUES, SCHEDULES, type IngestFinalizePayload } from '@ksp/shared';
import type { WorkerContext } from '../../lib/context.js';
import { EXPIRE_SCHEDULE, expireUploads, handleFinalize } from './handlers.js';

export default async function register(ctx: WorkerContext): Promise<void> {
  await ctx.boss.work(
    QUEUES.INGEST_FINALIZE,
    { localConcurrency: Math.max(1, ctx.cfg.WORKER_CONCURRENCY), includeMetadata: true },
    async (jobs) => {
      for (const job of jobs) await handleFinalize(ctx, { id: job.id, data: job.data as IngestFinalizePayload, retryCount: job.retryCount, retryLimit: job.retryLimit });
    },
  );

  // The uploads.expire queue is created at migrate time (SCHEDULES in @ksp/shared); no runtime DDL.
  await ctx.boss.schedule(EXPIRE_SCHEDULE, SCHEDULES[EXPIRE_SCHEDULE]);
  await ctx.boss.work(EXPIRE_SCHEDULE, async () => {
    await expireUploads(ctx);
  });
}
