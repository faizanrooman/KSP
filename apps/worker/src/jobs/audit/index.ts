/**
 * Audit ledger job module: `audit.checkpoint` cron (hourly). Verifies the chain since the last checkpoint
 * and signs the verified head (audit_checkpoints + AUDIT_CHECKPOINT_CREATED). A broken chain is never
 * signed; it raises a CRITICAL AUDIT_CHAIN_BROKEN alert instead.
 */
import { systemActor, type Database } from '@ksp/core';
import { createCheckpoint, type CreateCheckpointResult } from '@ksp/core/custody';
import { SCHEDULES } from '@ksp/shared';
import type { WorkerContext } from '../../lib/context.js';

export const AUDIT_ACTOR = systemActor('audit-worker');

export async function runAuditCheckpoint(deps: { db: Database }): Promise<CreateCheckpointResult> {
  return createCheckpoint(deps.db, AUDIT_ACTOR);
}

export default async function register(ctx: WorkerContext): Promise<void> {
  const log = ctx.log.child({ module: 'audit' });
  await ctx.boss.schedule('audit.checkpoint', SCHEDULES['audit.checkpoint']);
  await ctx.boss.work('audit.checkpoint', async () => {
    const r = await runAuditCheckpoint({ db: ctx.db });
    if (r.created) log.info({ headSeq: r.checkpoint?.headSeq }, 'audit checkpoint created');
    else log.warn({ reason: r.reason }, 'audit checkpoint not created');
  });
}
