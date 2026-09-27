/**
 * Shared alert raising / resolution / fan-out. Every producer (API, worker, alert evaluator) raises alerts
 * through `raiseAlert` so rule enablement, severity and de-duplication are applied uniformly.
 *
 *  - Rule gate: if alert_rules has a row for the code and it is disabled, nothing is written (suppressed).
 *  - Severity: an explicit `severity` wins (level-based producers such as storage WARNING vs CRITICAL);
 *    otherwise the rule's configured severity; otherwise WARNING.
 *  - De-duplication: at most one non-RESOLVED alert per dedupe key (DB partial unique index). A repeat
 *    increments `occurrences`, refreshes `last_seen_at`/message, and escalates severity (never lowers it);
 *    an escalation clears `notified_at` so recipients are notified again.
 *  - `onlyIfNew`: for one-alert-per-event producers — do nothing if ANY alert (any status) already exists
 *    for the key (so a resolved per-item alert is not reopened by a re-scan of the same event).
 *
 * Notifications are fanned out asynchronously by `dispatchPendingAlerts` (alerts.evaluate cron) to users
 * holding alerts:manage at (an ancestor of) the alert's org unit — or at a root unit for system-wide alerts.
 */
import { createHmac } from 'node:crypto';
import { sql } from 'kysely';
import { DEFAULT_SETTINGS, QUEUES, type AlertDeliverPayload, type AlertDeliveryPolicy } from '@ksp/shared';
import type { Database, Tx } from './db/index.js';
import { cleanRecipients, createMailer, type MailMessage, type Mailer } from './mailer.js';
import { enqueue } from './queue.js';

export type AlertSeverity = 'INFO' | 'WARNING' | 'CRITICAL';
const RANK: Record<AlertSeverity, number> = { INFO: 0, WARNING: 1, CRITICAL: 2 };

export interface RaiseAlertInput {
  ruleCode: string;
  severity?: AlertSeverity;
  title: string;
  message: string;
  resourceType?: string | null;
  resourceId?: string | null;
  orgUnitId?: string | null;
  /** Defaults to `<ruleCode>:<resourceType>:<resourceId>` (or the rule code alone when no resource). */
  dedupeKey?: string;
  onlyIfNew?: boolean;
}

export interface RaiseAlertResult {
  id: string | null;
  created: boolean;
  suppressed: boolean;
  severity: AlertSeverity | null;
}

export function defaultDedupeKey(a: Pick<RaiseAlertInput, 'ruleCode' | 'resourceType' | 'resourceId'>): string {
  return a.resourceId ? `${a.ruleCode}:${a.resourceType ?? 'resource'}:${a.resourceId}` : a.ruleCode;
}

export async function raiseAlert(db: Database | Tx, a: RaiseAlertInput): Promise<RaiseAlertResult> {
  const rule = await db.selectFrom('alert_rules').select(['enabled', 'severity']).where('code', '=', a.ruleCode).executeTakeFirst();
  if (rule && !rule.enabled) return { id: null, created: false, suppressed: true, severity: null };
  const severity: AlertSeverity = a.severity ?? (rule?.severity as AlertSeverity | undefined) ?? 'WARNING';
  const key = a.dedupeKey ?? defaultDedupeKey(a);
  if (a.onlyIfNew) {
    const exists = await db.selectFrom('alerts').select('id').where('dedupe_key', '=', key).executeTakeFirst();
    if (exists) return { id: exists.id, created: false, suppressed: false, severity: null };
  }
  const title = a.title.slice(0, 300);
  const message = a.message.slice(0, 4000);
  const { rows } = await sql<{ id: string; created: boolean; severity: AlertSeverity }>`
    INSERT INTO alerts (rule_code, severity, title, message, resource_type, resource_id, org_unit_id, dedupe_key)
    VALUES (${a.ruleCode}, ${severity}, ${title}, ${message}, ${a.resourceType ?? null}, ${a.resourceId ?? null}, ${a.orgUnitId ?? null}::uuid, ${key})
    ON CONFLICT (dedupe_key) WHERE status <> 'RESOLVED' AND dedupe_key IS NOT NULL
    DO UPDATE SET occurrences = alerts.occurrences + 1, last_seen_at = now(), message = EXCLUDED.message, title = EXCLUDED.title,
      severity = CASE WHEN ${sevRankSql('EXCLUDED.severity')} > ${sevRankSql('alerts.severity')} THEN EXCLUDED.severity ELSE alerts.severity END,
      notified_at = CASE WHEN ${sevRankSql('EXCLUDED.severity')} > ${sevRankSql('alerts.severity')} THEN NULL ELSE alerts.notified_at END
    RETURNING id, (xmax = 0) AS created, severity`.execute(db);
  const r = rows[0]!;
  return { id: r.id, created: r.created, suppressed: false, severity: r.severity };
}

function sevRankSql(col: string) {
  return sql.raw(`(CASE ${col} WHEN 'CRITICAL' THEN 2 WHEN 'WARNING' THEN 1 ELSE 0 END)`);
}

/**
 * Auto-resolve open/acknowledged alerts whose condition has cleared. Match by exact key or key prefix.
 * Returns the number of alerts resolved.
 */
export async function autoResolveAlerts(db: Database | Tx, m: { dedupeKey?: string; dedupePrefix?: string; ruleCode?: string; note: string; exceptKeys?: string[] }): Promise<number> {
  if (!m.dedupeKey && !m.dedupePrefix) throw new Error('autoResolveAlerts requires dedupeKey or dedupePrefix');
  let q = db
    .updateTable('alerts')
    .set({ status: 'RESOLVED', resolved_at: new Date(), resolved_by: null, resolution_note: m.note.slice(0, 1000), auto_resolved: true })
    .where('status', '<>', 'RESOLVED');
  if (m.dedupeKey) q = q.where('dedupe_key', '=', m.dedupeKey);
  if (m.dedupePrefix) q = q.where('dedupe_key', 'like', `${m.dedupePrefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  if (m.ruleCode) q = q.where('rule_code', '=', m.ruleCode);
  if (m.exceptKeys?.length) q = q.where('dedupe_key', 'not in', m.exceptKeys);
  const res = await q.executeTakeFirst();
  return Number(res.numUpdatedRows ?? 0);
}

export function severityRank(s: string): number {
  return RANK[s as AlertSeverity] ?? 0;
}

/**
 * Active users who hold alerts:manage through a grant covering the alert's org unit. System-wide alerts
 * (no org unit) go to alerts:manage holders at root org units.
 */
export async function alertRecipients(db: Database | Tx, orgUnitId: string | null): Promise<string[]> {
  const { rows } = await sql<{ user_id: string }>`
    SELECT DISTINCT ur.user_id
      FROM user_roles ur
      JOIN roles r ON r.id = ur.role_id
      JOIN org_units g ON g.id = ur.org_unit_id
      JOIN users u ON u.id = ur.user_id
     WHERE 'alerts:manage' = ANY (r.permissions)
       AND u.status = 'ACTIVE'
       AND (ur.expires_at IS NULL OR ur.expires_at > now())
       AND ${orgUnitId
         ? sql`g.path @> (SELECT path FROM org_units WHERE id = ${orgUnitId}::uuid)`
         : sql`nlevel(g.path) = 1`}`.execute(db);
  return rows.map((r) => r.user_id);
}

/** Outbound alert channel (webhook / e-mail). `configured === false` records a SKIPPED delivery. */
export interface AlertChannel {
  readonly name: 'WEBHOOK' | 'EMAIL';
  readonly configured: boolean;
  /** Deliver one alert; resolves to the number of recipients reached. Throw `DeliverySkipped` for "nothing to do". */
  send(alert: AlertPayload, db: Database): Promise<number>;
}

/** Thrown by a channel when the delivery is intentionally not made (e.g. no recipients) — recorded SKIPPED, never retried. */
export class DeliverySkipped extends Error {}

export interface AlertPayload {
  id: string;
  ruleCode: string;
  severity: string;
  title: string;
  message: string;
  resourceType: string | null;
  resourceId: string | null;
  orgUnitId: string | null;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

/**
 * JSON webhook channel (ALERT_WEBHOOK_URL; optional ALERT_WEBHOOK_SECRET → `x-ksp-signature: sha256=<hmac>`).
 * The payload carries alert metadata only — never evidence content, storage keys or credentials.
 */
export function webhookChannel(env: NodeJS.ProcessEnv = process.env): AlertChannel {
  const url = env.ALERT_WEBHOOK_URL?.trim();
  const secret = env.ALERT_WEBHOOK_SECRET?.trim();
  const timeoutMs = Number(env.ALERT_WEBHOOK_TIMEOUT_MS ?? 5000);
  return {
    name: 'WEBHOOK',
    configured: !!url,
    async send(alert) {
      if (!url) throw new Error('webhook not configured');
      const body = JSON.stringify({ type: 'ksp.alert', alert });
      const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'ksp-vms-alerts/1' };
      if (secret) headers['x-ksp-signature'] = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
      const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
      if (!res.ok) throw new Error(`webhook responded HTTP ${res.status}`);
      return 1;
    },
  };
}

export async function loadAlertDeliveryPolicy(db: Database | Tx): Promise<AlertDeliveryPolicy> {
  const r = await db.selectFrom('system_settings').select('value').where('key', '=', 'alertDeliveryPolicy').executeTakeFirst();
  return { ...DEFAULT_SETTINGS.alertDeliveryPolicy, ...((r?.value as Partial<AlertDeliveryPolicy> | undefined) ?? {}) };
}

/**
 * E-mail recipients of an alert: e-mail addresses of the in-scope alerts:manage holders (users.email, when
 * alertDeliveryPolicy.emailAlertManagers), the rule's own `email_recipients`, and the per-severity lists
 * (warningRecipients for WARNING+CRITICAL, criticalRecipients for CRITICAL).
 */
export async function alertEmailRecipients(db: Database | Tx, a: Pick<AlertPayload, 'ruleCode' | 'severity' | 'orgUnitId'>, policy?: AlertDeliveryPolicy): Promise<string[]> {
  const pol = policy ?? (await loadAlertDeliveryPolicy(db));
  const out: Array<string | null> = [];
  if (pol.emailAlertManagers) {
    const ids = await alertRecipients(db, a.orgUnitId);
    if (ids.length) out.push(...(await db.selectFrom('users').select('email').where('id', 'in', ids).where('email', 'is not', null).execute()).map((u) => u.email));
  }
  const rule = await db.selectFrom('alert_rules').select('email_recipients').where('code', '=', a.ruleCode).executeTakeFirst();
  out.push(...(rule?.email_recipients ?? []));
  if (a.severity === 'WARNING' || a.severity === 'CRITICAL') out.push(...pol.warningRecipients);
  if (a.severity === 'CRITICAL') out.push(...pol.criticalRecipients);
  return cleanRecipients(out);
}

/** Plain-text alert e-mail (metadata + sign-in link only; never evidence content or credentials). */
export function alertEmail(alert: AlertPayload, baseUrl: string): Omit<MailMessage, 'to'> {
  const link = `${baseUrl.replace(/\/+$/, '')}/alerts/${alert.id}`;
  const lines = [
    `${alert.severity} alert: ${alert.title}`,
    '',
    alert.message,
    '',
    `Rule:        ${alert.ruleCode}`,
    `Severity:    ${alert.severity}`,
    `Occurrences: ${alert.occurrences}`,
    `First seen:  ${alert.firstSeenAt}`,
    `Last seen:   ${alert.lastSeenAt}`,
    ...(alert.resourceType ? [`Resource:    ${alert.resourceType} ${alert.resourceId ?? ''}`.trimEnd()] : []),
    '',
    `Open in KSP VMS (sign-in required): ${link}`,
    '',
    'This is an automated message from the KSP Video Evidence Management System. Do not reply.',
  ];
  return { subject: `[KSP VMS] ${alert.severity}: ${alert.title}`, text: lines.join('\n'), headers: { 'X-KSP-Alert-Id': alert.id, 'X-KSP-Alert-Rule': alert.ruleCode } };
}

/** SMTP e-mail channel (ALERT_SMTP_URL / ALERT_EMAIL_FROM, see mailer.ts). */
export function emailChannel(env: NodeJS.ProcessEnv = process.env, mailer: Mailer = createMailer(env)): AlertChannel {
  const baseUrl = env.APP_BASE_URL ?? 'http://localhost:5173';
  return {
    name: 'EMAIL',
    configured: mailer.configured,
    async send(alert, db) {
      const to = await alertEmailRecipients(db, alert);
      if (!to.length) throw new DeliverySkipped('no e-mail recipients');
      const r = await mailer.send({ ...alertEmail(alert, baseUrl), to });
      return r.accepted.length || to.length;
    },
  };
}

export function toAlertPayload(a: { id: string; rule_code: string; severity: string; title: string; message: string; resource_type: string | null; resource_id: string | null; org_unit_id: string | null; occurrences: number; first_seen_at: Date | string; last_seen_at: Date | string }): AlertPayload {
  return {
    id: a.id, ruleCode: a.rule_code, severity: a.severity, title: a.title, message: a.message, resourceType: a.resource_type,
    resourceId: a.resource_id, orgUnitId: a.org_unit_id, occurrences: a.occurrences,
    firstSeenAt: new Date(a.first_seen_at).toISOString(), lastSeenAt: new Date(a.last_seen_at).toISOString(),
  };
}

export type ScheduleRetry = (payload: AlertDeliverPayload, delaySeconds: number) => Promise<unknown>;
const defaultScheduleRetry: ScheduleRetry = (payload, delaySeconds) =>
  enqueue(QUEUES.ALERT_DELIVER, payload, { startAfter: delaySeconds, singletonKey: `${payload.alertId}:${payload.channel}:${payload.attempt}` });

export interface DeliverResult { status: 'SENT' | 'FAILED' | 'SKIPPED' | 'RETRYING'; attempt: number; nextAttemptAt?: Date; detail?: string }

/**
 * One delivery attempt of an alert on an external channel. Every attempt is an alert_deliveries row.
 * A failure schedules the next attempt (alerts.deliver queue) after baseDelaySeconds·2^(attempt-1) until
 * alertDeliveryPolicy.maxAttempts is reached; the last failure is recorded FAILED. A retry for an alert that
 * has meanwhile been resolved is recorded SKIPPED.
 */
export async function deliverAlert(db: Database, alertId: string, channel: AlertChannel, attempt = 1, opts: { scheduleRetry?: ScheduleRetry; policy?: AlertDeliveryPolicy } = {}): Promise<DeliverResult | null> {
  const a = await db.selectFrom('alerts').selectAll().where('id', '=', alertId).executeTakeFirst();
  if (!a) return null;
  const record = (status: DeliverResult['status'], extra: { recipients?: number | null; detail?: string | null; next_attempt_at?: Date | null } = {}) =>
    db.insertInto('alert_deliveries').values({ alert_id: alertId, channel: channel.name, status, attempt, recipients: extra.recipients ?? null, detail: extra.detail?.slice(0, 500) ?? null, next_attempt_at: extra.next_attempt_at ?? null }).execute();
  if (!channel.configured) {
    await record('SKIPPED', { detail: 'channel not configured' });
    return { status: 'SKIPPED', attempt, detail: 'channel not configured' };
  }
  if (attempt > 1 && a.status === 'RESOLVED') {
    await record('SKIPPED', { detail: 'alert resolved before retry' });
    return { status: 'SKIPPED', attempt, detail: 'alert resolved before retry' };
  }
  try {
    const n = await channel.send(toAlertPayload(a), db);
    await record('SENT', { recipients: n });
    return { status: 'SENT', attempt };
  } catch (e) {
    const detail = (e as Error).message || String(e);
    if (e instanceof DeliverySkipped) {
      await record('SKIPPED', { detail });
      return { status: 'SKIPPED', attempt, detail };
    }
    const policy = opts.policy ?? (await loadAlertDeliveryPolicy(db));
    if (attempt < policy.maxAttempts) {
      const delay = Math.min(policy.baseDelaySeconds * 2 ** (attempt - 1), 24 * 3600);
      const next = new Date(Date.now() + delay * 1000);
      await record('RETRYING', { detail, next_attempt_at: next });
      await (opts.scheduleRetry ?? defaultScheduleRetry)({ alertId, channel: channel.name, attempt: attempt + 1 }, delay);
      return { status: 'RETRYING', attempt, nextAttemptAt: next, detail };
    }
    await record('FAILED', { detail: attempt > 1 ? `${detail} (after ${attempt} attempts)` : detail });
    return { status: 'FAILED', attempt, detail };
  }
}

/**
 * Fan out OPEN alerts not yet notified: WARNING/CRITICAL → in-app notifications for alerts:manage holders in
 * scope, plus the first attempt on every outbound channel (failures are retried via alerts.deliver).
 * INFO alerts are marked notified without fan-out. Returns alerts processed.
 */
export async function dispatchPendingAlerts(db: Database, channels: AlertChannel[] = [], limit = 200, opts: { scheduleRetry?: ScheduleRetry } = {}): Promise<number> {
  const pending = await db
    .selectFrom('alerts')
    .selectAll()
    .where('status', '=', 'OPEN')
    .where('notified_at', 'is', null)
    .orderBy('first_seen_at')
    .limit(limit)
    .execute();
  const policy = channels.length ? await loadAlertDeliveryPolicy(db) : undefined;
  for (const a of pending) {
    const notify = a.severity === 'WARNING' || a.severity === 'CRITICAL';
    let claimedIt = false;
    await db.transaction().execute(async (tx) => {
      // Claim the alert (another dispatcher may race); skip if already claimed.
      const claimed = await tx.updateTable('alerts').set({ notified_at: new Date() }).where('id', '=', a.id).where('notified_at', 'is', null).executeTakeFirst();
      claimedIt = Number(claimed.numUpdatedRows ?? 0) > 0;
      if (!claimedIt || !notify) return;
      const users = await alertRecipients(tx, a.org_unit_id);
      if (users.length) {
        await tx
          .insertInto('notifications')
          .values(users.map((u) => ({ user_id: u, kind: `ALERT_${a.severity}`, title: a.title.slice(0, 300), body: a.message.slice(0, 1000), link: `/alerts/${a.id}` })))
          .execute();
      }
      await tx.insertInto('alert_deliveries').values({ alert_id: a.id, channel: 'IN_APP', status: 'SENT', recipients: users.length }).execute();
    });
    if (!notify || !claimedIt) continue;
    for (const ch of channels) await deliverAlert(db, a.id, ch, 1, { policy, scheduleRetry: opts.scheduleRetry });
  }
  return pending.length;
}
