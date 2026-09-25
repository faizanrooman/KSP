/** Reports job module: consumes REPORT_BUILD (see build.ts). */
import { QUEUES, type ReportBuildPayload } from '@ksp/shared';
import type { WorkerContext } from '../../lib/context.js';
import { runReportBuild } from './build.js';

export { runReportBuild };

export default async function register(ctx: WorkerContext): Promise<void> {
  const log = ctx.log.child({ module: 'reports' });
  await ctx.boss.work<ReportBuildPayload>(QUEUES.REPORT_BUILD, { localConcurrency: 2 }, async (jobs) => {
    for (const j of jobs) await runReportBuild({ db: ctx.db, storage: ctx.storage, log }, j.data.reportRunId);
  });
}
