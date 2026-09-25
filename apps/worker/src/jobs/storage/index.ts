/** Storage metrics job module: storage.snapshot cron (see snapshot.ts for the counting method). */
import { SCHEDULES } from '@ksp/shared';
import type { WorkerContext } from '../../lib/context.js';
import { runStorageSnapshot } from './snapshot.js';

export { runStorageSnapshot };

export default async function register(ctx: WorkerContext): Promise<void> {
  const log = ctx.log.child({ module: 'storage' });
  await ctx.boss.schedule('storage.snapshot', SCHEDULES['storage.snapshot']);
  await ctx.boss.work('storage.snapshot', async () => {
    await runStorageSnapshot({ db: ctx.db, storage: ctx.storage, log });
  });
}
