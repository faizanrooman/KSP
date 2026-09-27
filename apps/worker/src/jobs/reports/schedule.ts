/**
 * reports.schedule cron: materialise due scheduled reports into report_runs, and notify recipients when a
 * scheduled run completes.
 *
 *  - Due = enabled AND next_run_at <= now. Claimed FOR UPDATE SKIP LOCKED; one run per (schedule, slot) is
 *    guaranteed by a unique index, so concurrent/restarted crons cannot double-run a slot. Missed slots (worker
 *    down) are not back-filled: one run for the latest due slot, then next_run_at moves to the next future slot.
 *  - Jurisdiction is the OWNER's, computed from the owner's CURRENT grants at run time and frozen into
 *    params.scopePaths (narrowed to the schedule's org unit). An inactive owner, or one who no longer holds the
 *    report's permissions (over the org unit), skips the slot: last_error + REPORT_SCHEDULE_SKIPPED.
 *  - Recipients are frozen into report_runs.recipient_ids — only ACTIVE users whose own report jurisdiction
 *    covers the run's scope (the API re-checks on every access).
 *  - Period = [slot − lookback_days, slot).
 * On completion (`notifyScheduledRun`) the owner and recipients get an in-app notification linking to the
 * Reports page, and — when schedule.email_recipients and SMTP is configured — an e-mail with the same link
 * (sign-in required; no tokenised download URL is ever e-mailed).
 */
import { REPORT_TYPES, reportScopeFromGrants, scopeCovered, pathCoversPath, QUEUES, type ReportParams, type ReportType, type ScopeGrant } from '@ksp/shared';
import { appendAudit, createMailer, enqueue, nextCronRun, systemActor, type Database, type Mailer } from '@ksp/core';

const ACTOR = systemActor('report-scheduler');

export async function userGrants(db: Database, userId: string): Promise<ScopeGrant[]> {
  const rows = await db
    .selectFrom('user_roles as ur')
    .innerJoin('roles as r', 'r.id', 'ur.role_id')
    .innerJoin('org_units as o', 'o.id', 'ur.org_unit_id')
    .select(['r.permissions', 'o.path'])
    .where('ur.user_id', '=', userId)
    .where('o.active', '=', true)
    .where((eb) => eb.or([eb('ur.expires_at', 'is', null), eb('ur.expires_at', '>', new Date())]))
    .execute();
  return rows.map((r) => ({ orgPath: r.path, permissions: r.permissions }));
}

interface ScheduleParamsJson { orgUnitId?: string | null; actorId?: string | null; inactiveDays?: number | null }

export interface ScheduleCycleResult { created: string[]; skipped: Array<{ scheduleId: string; reason: string }> }

export async function runDueSchedules(db: Database, opts: { now?: Date; limit?: number; enqueueBuild?: (runId: string) => Promise<unknown> } = {}): Promise<ScheduleCycleResult> {
  const now = opts.now ?? new Date();
  const out: ScheduleCycleResult = { created: [], skipped: [] };
  const toEnqueue: string[] = [];
  const due = await db.selectFrom('report_schedules').select('id').where('enabled', '=', true).where('next_run_at', '<=', now).orderBy('next_run_at').limit(opts.limit ?? 100).execute();
  for (const { id } of due) {
    await db.transaction().execute(async (tx) => {
      const s = await tx.selectFrom('report_schedules').selectAll().where('id', '=', id).where('enabled', '=', true).where('next_run_at', '<=', now).forUpdate().skipLocked().executeTakeFirst();
      if (!s || !s.next_run_at) return;
      const slot = s.next_run_at;
      const next = nextCronRun(s.cron, s.timezone, new Date(Math.max(now.getTime(), slot.getTime())));
      const type = s.report_type as ReportType;
      const prm = s.params as ScheduleParamsJson;
      const skip = async (reason: string) => {
        await tx.updateTable('report_schedules').set({ next_run_at: next, last_error: reason.slice(0, 500) }).where('id', '=', s.id).execute();
        await appendAudit(tx, ACTOR, { action: 'REPORT_SCHEDULE_SKIPPED', outcome: 'FAILURE', resourceType: 'report_schedule', resourceId: s.id, details: { ownerId: s.owner_id, reportType: type, slot: slot.toISOString(), reason } });
        out.skipped.push({ scheduleId: s.id, reason });
      };
      const owner = await tx.selectFrom('users').select(['id', 'full_name', 'username', 'status']).where('id', '=', s.owner_id).executeTakeFirst();
      if (!owner || owner.status !== 'ACTIVE') return skip('owner account is not active');
      if (!REPORT_TYPES[type]) return skip(`unknown report type ${s.report_type}`);
      const scope = reportScopeFromGrants(await userGrants(db, owner.id), type);
      if (!scope.length) return skip(`owner no longer holds ${['reports:generate', ...REPORT_TYPES[type].requires].join(' + ')}`);
      let runScope = scope;
      let orgUnitId: string | null = null;
      if (prm.orgUnitId) {
        const o = await tx.selectFrom('org_units').select(['id', 'path']).where('id', '=', prm.orgUnitId).executeTakeFirst();
        if (!o || !scope.some((p) => pathCoversPath(p, o.path))) return skip('the schedule’s org unit is outside the owner’s current jurisdiction');
        orgUnitId = o.id;
        runScope = [o.path];
      }
      const recipients: string[] = [];
      for (const rid of s.recipient_ids) {
        const u = await tx.selectFrom('users').select('status').where('id', '=', rid).executeTakeFirst();
        if (u?.status === 'ACTIVE' && scopeCovered(runScope, reportScopeFromGrants(await userGrants(db, rid), type))) recipients.push(rid);
      }
      const params: ReportParams & { scheduleId: string } = {
        from: new Date(slot.getTime() - s.lookback_days * 86_400_000).toISOString(), to: slot.toISOString(),
        orgUnitId, actorId: prm.actorId ?? null, inactiveDays: prm.inactiveDays ?? null,
        scopePaths: runScope, requestedBy: { id: owner.id, name: owner.full_name, username: owner.username }, scheduleId: s.id,
      };
      const run = await tx.insertInto('report_runs')
        .values({ report_type: type, format: s.format, params: JSON.stringify(params), created_by: owner.id, org_unit_id: orgUnitId, schedule_id: s.id, scheduled_for: slot, recipient_ids: recipients })
        .onConflict((oc) => oc.columns(['schedule_id', 'scheduled_for']).where('schedule_id', 'is not', null).doNothing())
        .returning('id').executeTakeFirst();
      await tx.updateTable('report_schedules').set({ next_run_at: next, ...(run ? { last_run_at: now, last_run_id: run.id, last_error: null } : {}) }).where('id', '=', s.id).execute();
      if (!run) return;
      await appendAudit(tx, ACTOR, {
        action: 'REPORT_REQUESTED', resourceType: 'report_run', resourceId: run.id, orgUnitId,
        details: { reportType: type, format: s.format, from: params.from, to: params.to, scopePaths: runScope, scheduleId: s.id, ownerId: owner.id, recipients, droppedRecipients: s.recipient_ids.filter((r) => !recipients.includes(r)) },
      });
      out.created.push(run.id);
      toEnqueue.push(run.id);
    });
  }
  for (const runId of toEnqueue) await (opts.enqueueBuild ?? ((rid: string) => enqueue(QUEUES.REPORT_BUILD, { reportRunId: rid }, { singletonKey: rid })))(runId);
  return out;
}

/** After a scheduled run COMPLETED: in-app notification (+ optional e-mail) to owner and frozen recipients. Idempotent (notified_at). */
export async function notifyScheduledRun(db: Database, runId: string, opts: { mailer?: Mailer; baseUrl?: string; log?: { warn: (o: object, m: string) => void } } = {}): Promise<{ notified: number; emailed: number }> {
  const claimed = await db.updateTable('report_runs').set({ notified_at: new Date() })
    .where('id', '=', runId).where('status', '=', 'COMPLETED').where('schedule_id', 'is not', null).where('notified_at', 'is', null)
    .returning(['id', 'report_type', 'format', 'created_by', 'recipient_ids', 'schedule_id', 'scheduled_for', 'row_count']).executeTakeFirst();
  if (!claimed) return { notified: 0, emailed: 0 };
  const s = await db.selectFrom('report_schedules').select(['name', 'email_recipients']).where('id', '=', claimed.schedule_id!).executeTakeFirst();
  const users = [...new Set([claimed.created_by, ...claimed.recipient_ids])];
  const title = `Scheduled report ready: ${s?.name ?? REPORT_TYPES[claimed.report_type as ReportType]?.title ?? claimed.report_type}`.slice(0, 300);
  const body = `${REPORT_TYPES[claimed.report_type as ReportType]?.title ?? claimed.report_type} (${claimed.format}, ${claimed.row_count ?? 0} rows) for the period ending ${claimed.scheduled_for?.toISOString() ?? ''}.`;
  const link = `/reports?run=${claimed.id}`;
  await db.insertInto('notifications').values(users.map((u) => ({ user_id: u, kind: 'REPORT_READY', title, body, link }))).execute();
  let emailed = 0;
  const mailer = opts.mailer ?? createMailer();
  if (s?.email_recipients && mailer.configured) {
    const rows = await db.selectFrom('users').select('email').where('id', 'in', users).where('status', '=', 'ACTIVE').where('email', 'is not', null).execute();
    const to = rows.map((r) => r.email!).filter(Boolean);
    if (to.length) {
      const base = (opts.baseUrl ?? process.env.APP_BASE_URL ?? 'http://localhost:5173').replace(/\/+$/, '');
      try {
        await mailer.send({
          to, subject: `[KSP VMS] ${title}`,
          text: [title, '', body, '', `Open it in KSP VMS (sign-in required; downloads are audited): ${base}${link}`, '', 'This is an automated message from the KSP Video Evidence Management System. Do not reply.'].join('\n'),
          headers: { 'X-KSP-Report-Run': claimed.id },
        });
        emailed = to.length;
      } catch (e) {
        opts.log?.warn({ runId, err: (e as Error).message }, 'scheduled report e-mail failed');
        await db.updateTable('report_schedules').set({ last_error: `e-mail notification failed: ${(e as Error).message}`.slice(0, 500) }).where('id', '=', claimed.schedule_id!).execute();
      }
    }
  }
  return { notified: users.length, emailed };
}
