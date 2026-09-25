/** Alerts job module: alerts.evaluate cron (rule evaluation + notification fan-out). */
import { SCHEDULES } from '@ksp/shared';
import { dispatchPendingAlerts, emailChannel, webhookChannel, type AlertChannel, type Database } from '@ksp/core';
import type { WorkerContext } from '../../lib/context.js';
import { evaluateAlerts } from './evaluate.js';

export { evaluateAlerts, evaluateRule } from './evaluate.js';

/** Outbound channels that are configured through the environment (unconfigured channels are not attempted). */
export function configuredChannels(env: NodeJS.ProcessEnv = process.env): AlertChannel[] {
  return [webhookChannel(env), emailChannel(env)].filter((c) => c.configured);
}

export async function runAlertCycle(db: Database, channels = configuredChannels()) {
  const rules = await evaluateAlerts(db);
  const dispatched = await dispatchPendingAlerts(db, channels);
  return { rules, dispatched };
}

export default async function register(ctx: WorkerContext): Promise<void> {
  const log = ctx.log.child({ module: 'alerts' });
  await ctx.boss.schedule('alerts.evaluate', SCHEDULES['alerts.evaluate']);
  await ctx.boss.work('alerts.evaluate', async () => {
    const { rules, dispatched } = await runAlertCycle(ctx.db);
    const failed = rules.filter((r) => r.error);
    if (failed.length) log.warn({ failed }, 'alert rules failed to evaluate');
    const raised = rules.reduce((s, r) => s + r.raised, 0);
    if (raised || dispatched) log.info({ raised, dispatched }, 'alerts evaluated');
  });
}
