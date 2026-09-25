/** Media job module: consumes QUEUES.MEDIA_PROCESS ({ evidenceId, force? }). See ./process.ts. */
import type { JobWithMetadata } from 'pg-boss';
import { QUEUE_DEFAULTS } from '@ksp/core';
import { QUEUES, type MediaProcessPayload } from '@ksp/shared';
import type { WorkerContext } from '../../lib/context.js';
import { processMedia } from './process.js';

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
}
