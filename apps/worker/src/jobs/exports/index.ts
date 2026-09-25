/** Court export job module: EXPORT_BUILD consumer + exports.expire cron. */
import { appendAudit, type Database, type Storage } from '@ksp/core';
import { QUEUES, SCHEDULES, type ExportBuildPayload } from '@ksp/shared';
import type { WorkerContext } from '../../lib/context.js';
import { EXPORT_ACTOR, runExportBuild } from './build.js';

export { runExportBuild };

/** Delete READY packages past expires_at: status EXPIRED + EXPORT_EXPIRED custody event per item. */
export async function runExportsExpire(deps: { db: Database; storage: Storage }): Promise<number> {
  const due = await deps.db.selectFrom('exports').select(['id', 'export_number', 'case_id', 'bucket', 'object_key']).where('status', '=', 'READY').where('expires_at', '<=', new Date()).limit(500).execute();
  for (const ex of due) {
    if (ex.bucket && ex.object_key) await deps.storage.delete(ex.bucket, ex.object_key);
    await deps.db.transaction().execute(async (tx) => {
      const upd = await tx.updateTable('exports').set({ status: 'EXPIRED' }).where('id', '=', ex.id).where('status', '=', 'READY').executeTakeFirst();
      if (!upd.numUpdatedRows) return;
      const items = await tx.selectFrom('export_items as xi').innerJoin('evidence as e', 'e.id', 'xi.evidence_id').select(['xi.evidence_id', 'e.org_unit_id']).where('xi.export_id', '=', ex.id).execute();
      for (const it of items) {
        await appendAudit(tx, EXPORT_ACTOR, { action: 'EXPORT_EXPIRED', resourceType: 'export', resourceId: ex.id, evidenceId: it.evidence_id, caseId: ex.case_id, orgUnitId: it.org_unit_id, details: { exportNumber: ex.export_number, packageDeleted: !!ex.object_key } });
      }
    });
  }
  return due.length;
}

export default async function register(ctx: WorkerContext): Promise<void> {
  const deps = { db: ctx.db, storage: ctx.storage, cfg: ctx.cfg, log: ctx.log.child({ module: 'exports' }) };
  await ctx.boss.work<ExportBuildPayload>(QUEUES.EXPORT_BUILD, { localConcurrency: Math.max(1, Math.min(2, ctx.cfg.WORKER_CONCURRENCY)) }, async (jobs) => {
    for (const j of jobs) await runExportBuild(deps, j.data);
  });
  await ctx.boss.schedule('exports.expire', SCHEDULES['exports.expire']);
  await ctx.boss.work('exports.expire', async () => {
    await runExportsExpire(deps);
  });
}
