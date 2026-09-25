/** AI training-dataset export job module (queue ai.training_export). Owned by the AI workstream. */
import { QUEUES, type AiTrainingExportPayload } from '@ksp/shared';
import type { WorkerContext } from '../../lib/context.js';
import { runTrainingExport } from './build.js';

export { runTrainingExport };

export default async function register(ctx: WorkerContext): Promise<void> {
  const deps = { db: ctx.db, storage: ctx.storage, log: ctx.log.child({ module: 'ai-training' }) };
  await ctx.boss.work<AiTrainingExportPayload>(QUEUES.AI_TRAINING_EXPORT, { localConcurrency: 1 }, async (jobs) => {
    for (const j of jobs) await runTrainingExport(deps, j.data.trainingExportId);
  });
}
