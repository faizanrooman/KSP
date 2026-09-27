/** Reports job module: consumes REPORT_BUILD (see build.ts) and runs the reports.schedule cron (schedule.ts). */
import { QUEUES, SCHEDULES, type ReportBuildPayload } from '@ksp/shared';
import type { WorkerContext } from '../../lib/context.js';
import { runReportBuild } from './build.js';
import { notifyScheduledRun, runDueSchedules } from './schedule.js';

export { runReportBuild, runDueSchedules, notifyScheduledRun };

export default async function register(ctx: WorkerContext): Promise<void> {
  const log = ctx.log.child({ module: 'reports' });
  await ctx.boss.work<ReportBuildPayload>(QUEUES.REPORT_BUILD, { localConcurrency: 2 }, async (jobs) => {
    for (const j of jobs) {
      const r = await runReportBuild({ db: ctx.db, storage: ctx.storage, log }, j.data.reportRunId);
      if (r.status === 'COMPLETED') await notifyScheduledRun(ctx.db, j.data.reportRunId, { log });
    }
  });
  await ctx.boss.schedule('reports.schedule', SCHEDULES['reports.schedule']);
  await ctx.boss.work('reports.schedule', async () => {
    const r = await runDueSchedules(ctx.db);
    if (r.created.length || r.skipped.length) log.info({ created: r.created.length, skipped: r.skipped }, 'scheduled reports');
  });
}
