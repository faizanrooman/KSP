/** Media job module: consumes QUEUES.MEDIA_PROCESS ({ evidenceId, force? }) — ./process.ts — and QUEUES.SNAPSHOT_EXTRACT — ./snapshot.ts. */
import type { JobWithMetadata } from 'pg-boss';
import { QUEUE_DEFAULTS } from '@ksp/core';
import { QUEUES, type MediaProcessPayload, type SnapshotExtractPayload } from '@ksp/shared';
import type { WorkerContext } from '../../lib/context.js';
import { processMedia } from './process.js';
import { runSnapshotExtract } from './snapshot.js';

export { runSnapshotExtract };

export default async function register(ctx: WorkerContext): Promise<void> {
  const log = ctx.log.child({ job: 'media' });
  const retryLimit = QUEUE_DEFAULTS[QUEUES.MEDIA_PROCESS].retryLimit;
  await ctx.boss.work<MediaProcessPayload>(
    QUEUES.MEDIA_PROCESS,
    { localConcurrency: Math.max(1, ctx.cfg.WORKER_CONCURRENCY), batchSize: 1, includeMetadata: true },
    async (jobs) => {
      for (const job of jobs as JobWithMetadata<MediaProcessPayload>[]) {
        await processMedia({ db: ctx.db, storage: ctx.storage, cfg: ctx.cfg, log }, job.data, {
          queueJobId: job.id,
          finalAttempt: job.retryCount >= (job.retryLimit ?? retryLimit),
        });
      }
    },
  );
  // Snapshots are interactive (the API waits for them): short polling interval, a few in parallel.
  await ctx.boss.work<SnapshotExtractPayload>(QUEUES.SNAPSHOT_EXTRACT, { localConcurrency: 4, pollingIntervalSeconds: 0.5 }, async (jobs) => {
    for (const job of jobs) await runSnapshotExtract({ db: ctx.db, storage: ctx.storage, cfg: ctx.cfg, log }, job.data.snapshotRequestId);
  });
}
