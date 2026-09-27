/**
 * Cron helpers for user-defined schedules (scheduled reports). Evaluated with cron-parser in the schedule's
 * IANA timezone; pg-boss's own cron is only used for the system SCHEDULES in @ksp/shared.
 */
import { CronExpressionParser } from 'cron-parser';

/** Throws a descriptive Error for an invalid 5-field expression or timezone. */
export function validateCron(expr: string, tz: string): void {
  if (expr.trim().split(/\s+/).length !== 5) throw new Error('cron must have 5 fields (minute hour day-of-month month day-of-week)');
  CronExpressionParser.parse(expr, { tz, currentDate: new Date() }).next();
}

/** First slot strictly after `after`. */
export function nextCronRun(expr: string, tz: string, after: Date = new Date()): Date {
  return CronExpressionParser.parse(expr, { tz, currentDate: after }).next().toDate();
}

/** Minimum spacing between two consecutive slots (guards against every-minute schedules). */
export function minCronIntervalSeconds(expr: string, tz: string, samples = 6): number {
  const it = CronExpressionParser.parse(expr, { tz, currentDate: new Date() });
  let prev = it.next().toDate().getTime();
  let min = Infinity;
  for (let i = 0; i < samples; i++) {
    const n = it.next().toDate().getTime();
    min = Math.min(min, (n - prev) / 1000);
    prev = n;
  }
  return min;
}
