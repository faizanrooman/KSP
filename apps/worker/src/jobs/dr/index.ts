/** DR job module: dr.dispose-sweep cron (see sweep.ts). A no-op unless DR_S3_* is configured for the worker. */
import { SCHEDULES } from '@ksp/shared';
import type { WorkerContext } from '../../lib/context.js';
import { runDrDisposeSweep } from './sweep.js';

export { runDrDisposeSweep };

export default async function register(ctx: WorkerContext): Promise<void> {
  const log = ctx.log.child({ module: 'dr' });
  await ctx.boss.schedule('dr.dispose-sweep', SCHEDULES['dr.dispose-sweep']);
  await ctx.boss.work('dr.dispose-sweep', async () => {
    const r = await runDrDisposeSweep(ctx.db);
    if (!r.configured) return;
    if (r.failed) log.warn({ ...r, errors: r.errors.slice(0, 20) }, 'DR disposal sweep: some DR copies could not be deleted');
    else if (r.deleted) log.info({ deleted: r.deleted }, 'DR disposal sweep');
  });
}
