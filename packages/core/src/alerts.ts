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
import type { Database, Tx } from './db/index.js';

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
  send(alert: AlertPayload): Promise<void>;
}

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
    },
  };
}

/**
 * E-mail channel placeholder. SMTP delivery is NOT implemented (no SMTP relay/library is configured in this
 * deployment); when ALERT_SMTP_URL is set the delivery is recorded as FAILED with an explicit reason rather
 * than pretending to send. See docs/DASHBOARDS-REPORTS-ALERTS.md.
 */
export function emailChannel(env: NodeJS.ProcessEnv = process.env): AlertChannel {
  const configured = !!env.ALERT_SMTP_URL?.trim();
  return {
    name: 'EMAIL',
    configured,
    async send() {
      throw new Error('SMTP delivery not implemented (UNVERIFIED channel)');
    },
  };
}

/**
 * Fan out OPEN alerts not yet notified: WARNING/CRITICAL → in-app notifications for alerts:manage holders in
 * scope, plus outbound channels. INFO alerts are marked notified without fan-out. Returns alerts processed.
 */
export async function dispatchPendingAlerts(db: Database, channels: AlertChannel[] = [], limit = 200): Promise<number> {
  const pending = await db
    .selectFrom('alerts')
    .selectAll()
    .where('status', '=', 'OPEN')
    .where('notified_at', 'is', null)
    .orderBy('first_seen_at')
    .limit(limit)
    .execute();
  for (const a of pending) {
    const notify = a.severity === 'WARNING' || a.severity === 'CRITICAL';
    await db.transaction().execute(async (tx) => {
      // Claim the alert (another dispatcher may race); skip if already claimed.
      const claimed = await tx.updateTable('alerts').set({ notified_at: new Date() }).where('id', '=', a.id).where('notified_at', 'is', null).executeTakeFirst();
      if (!Number(claimed.numUpdatedRows ?? 0) || !notify) return;
      const users = await alertRecipients(tx, a.org_unit_id);
      if (users.length) {
        await tx
          .insertInto('notifications')
          .values(users.map((u) => ({ user_id: u, kind: `ALERT_${a.severity}`, title: a.title.slice(0, 300), body: a.message.slice(0, 1000), link: `/alerts/${a.id}` })))
          .execute();
      }
      await tx.insertInto('alert_deliveries').values({ alert_id: a.id, channel: 'IN_APP', status: 'SENT', recipients: users.length }).execute();
    });
    if (!notify) continue;
    const payload: AlertPayload = {
      id: a.id, ruleCode: a.rule_code, severity: a.severity, title: a.title, message: a.message, resourceType: a.resource_type,
      resourceId: a.resource_id, orgUnitId: a.org_unit_id, occurrences: a.occurrences,
      firstSeenAt: new Date(a.first_seen_at).toISOString(), lastSeenAt: new Date(a.last_seen_at).toISOString(),
    };
    for (const ch of channels) {
      if (!ch.configured) {
        await db.insertInto('alert_deliveries').values({ alert_id: a.id, channel: ch.name, status: 'SKIPPED', detail: 'channel not configured' }).execute();
        continue;
      }
      try {
        await ch.send(payload);
        await db.insertInto('alert_deliveries').values({ alert_id: a.id, channel: ch.name, status: 'SENT', recipients: 1 }).execute();
      } catch (e) {
        await db.insertInto('alert_deliveries').values({ alert_id: a.id, channel: ch.name, status: 'FAILED', detail: (e as Error).message.slice(0, 500) }).execute();
      }
    }
  }
  return pending.length;
}
