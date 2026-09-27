/** Alerts job module: alerts.evaluate cron (rule evaluation + notification fan-out). */
import { QUEUES, SCHEDULES, type AlertDeliverPayload } from '@ksp/shared';
import { deliverAlert, dispatchPendingAlerts, emailChannel, webhookChannel, type AlertChannel, type Database } from '@ksp/core';
import type { WorkerContext } from '../../lib/context.js';
import { evaluateAlerts } from './evaluate.js';

export { evaluateAlerts, evaluateRule } from './evaluate.js';

/** Outbound channels that are configured through the environment (unconfigured channels are not attempted). */
export function configuredChannels(env: NodeJS.ProcessEnv = process.env): AlertChannel[] {
  return [webhookChannel(env), emailChannel(env)].filter((c) => c.configured);
}

/** One retry attempt (alerts.deliver job). An unconfigured channel is recorded SKIPPED. */
export async function runAlertDelivery(db: Database, p: AlertDeliverPayload, env: NodeJS.ProcessEnv = process.env) {
  const ch = p.channel === 'EMAIL' ? emailChannel(env) : webhookChannel(env);
  return deliverAlert(db, p.alertId, ch, p.attempt);
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
  await ctx.boss.work<AlertDeliverPayload>(QUEUES.ALERT_DELIVER, { localConcurrency: 2 }, async (jobs) => {
    for (const j of jobs) {
      const r = await runAlertDelivery(ctx.db, j.data);
      if (r && r.status !== 'SENT') log.warn({ alertId: j.data.alertId, channel: j.data.channel, attempt: j.data.attempt, status: r.status, detail: r.detail }, 'alert delivery not sent');
    }
  });
}
