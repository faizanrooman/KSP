/** Lifecycle job module: fixity checks, tier migration, disposal execution, lifecycle.scan and integrity.sweep crons. */
import { QUEUES, SCHEDULES, type DisposalExecutePayload, type FixityCheckPayload, type TierMigratePayload } from '@ksp/shared';
import type { WorkerContext } from '../../lib/context.js';
import type { LifecycleDeps } from './common.js';
import { runFixityCheck } from './fixity.js';
import { runTierMigration } from './tier.js';
import { runDisposal } from './disposal.js';
import { runIntegritySweep, runLifecycleScan } from './scan.js';

export { runFixityCheck, runTierMigration, runDisposal, runIntegritySweep, runLifecycleScan };

export default async function register(ctx: WorkerContext): Promise<void> {
  const deps: LifecycleDeps = { db: ctx.db, storage: ctx.storage, log: ctx.log.child({ module: 'lifecycle' }) };
  const conc = Math.max(1, Math.min(4, ctx.cfg.WORKER_CONCURRENCY));

  await ctx.boss.work<FixityCheckPayload>(QUEUES.FIXITY_CHECK, { localConcurrency: conc }, async (jobs) => {
    for (const j of jobs) await runFixityCheck(deps, j.data, j.id);
  });
  await ctx.boss.work<TierMigratePayload>(QUEUES.TIER_MIGRATE, { localConcurrency: 2 }, async (jobs) => {
    for (const j of jobs) await runTierMigration(deps, j.data, j.id);
  });
  await ctx.boss.work<DisposalExecutePayload>(QUEUES.DISPOSAL_EXECUTE, { localConcurrency: 1 }, async (jobs) => {
    for (const j of jobs) await runDisposal(deps, j.data, j.id);
  });

  for (const name of ['lifecycle.scan', 'integrity.sweep'] as const) {
    await ctx.boss.schedule(name, SCHEDULES[name]);
  }
  await ctx.boss.work('lifecycle.scan', async () => {
    await runLifecycleScan(deps);
  });
  await ctx.boss.work('integrity.sweep', async () => {
    await runIntegritySweep(deps);
  });
}
