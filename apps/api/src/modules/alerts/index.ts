/**
 * Alerts & notifications (spec 17).
 *   GET  /alerts                     alerts:read — scoped: org alerts within the reader's jurisdiction; system-wide
 *                                    alerts (no org unit) only for state-level readers or system:monitor holders
 *   GET  /alerts/summary             alerts:read — open counts by severity (same scoping)
 *   GET  /alerts/:id                 alerts:read (out of scope → 404) + delivery log
 *   POST /alerts/:id/acknowledge     alerts:manage at the alert's unit (root for system-wide) — audit ALERT_ACKNOWLEDGED
 *   POST /alerts/:id/resolve {note}  same — audit ALERT_RESOLVED
 *   GET  /alerts/rules               alerts:manage
 *   PUT  /alerts/rules/:code         alerts:manage at a ROOT unit (rules are global) — audit ALERT_RULE_UPDATED
 *   GET  /notifications              own notifications (?unread=true)
 *   POST /notifications/:id/read     own
 *   POST /notifications/read-all     own
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql, type RawBuilder } from 'kysely';
import { ALERT_RULE_CODES, ALERT_SEVERITIES, ALERT_STATUSES, type AlertRuleCode, type Permission } from '@ksp/shared';
import { appendAudit, type AuditActor } from '@ksp/core';
import { hasPermission, hasPermissionAt, scopePaths, type Principal } from '../../lib/principal.js';
import { conflict, forbidden, notFound, validationFailed } from '../../lib/errors.js';
import { hasRootPermission, pageFields } from '../users/admin-lib.js';

export const prefix = '';

/** Per-rule config schemas (thresholds). Unknown keys are rejected. */
const pos = (max: number) => z.number().int().positive().max(max);
const pct = z.number().min(1).max(100);
export const RULE_CONFIG_SCHEMAS: Record<AlertRuleCode, z.ZodTypeAny> = {
  UPLOAD_FAILED: z.object({}).strict(),
  PROCESSING_FAILED: z.object({}).strict(),
  AI_FAILURE: z.object({}).strict(),
  INTEGRITY_FAILURE: z.object({}).strict(),
  STORAGE_THRESHOLD: z.object({ warnPercent: pct, criticalPercent: pct, capacityBytes: z.number().int().nonnegative() }).partial().strict()
    .refine((c) => c.warnPercent === undefined || c.criticalPercent === undefined || c.warnPercent < c.criticalPercent, 'warnPercent must be below criticalPercent'),
  EXCESSIVE_DOWNLOADS: z.object({ perHour: pos(100_000) }).partial().strict(),
  AUTH_BRUTE_FORCE: z.object({ failuresPer15Min: pos(100_000) }).partial().strict(),
  POLICY_VIOLATION: z.object({ deniedPer15Min: pos(100_000) }).partial().strict(),
  QUEUE_BACKLOG: z.object({ maxQueued: pos(10_000_000), maxAgeMinutes: pos(10_080) }).partial().strict(),
  AUDIT_CHAIN_BROKEN: z.object({ fullVerifyEveryHours: pos(24 * 31) }).partial().strict(),
};

const SORTS = { lastSeenAt: 'a.last_seen_at', firstSeenAt: 'a.first_seen_at', severity: 'sev_rank', occurrences: 'a.occurrences' } as const;
const sortValues = Object.keys(SORTS).flatMap((k) => [k, `-${k}`]) as [string, ...string[]];
const csv = <T extends readonly [string, ...string[]]>(values: T) =>
  z.union([z.enum(values), z.array(z.enum(values))]).optional().transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]));

const listQuery = z.object({
  status: csv(ALERT_STATUSES),
  severity: csv(ALERT_SEVERITIES),
  rule: csv(ALERT_RULE_CODES),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  orgUnitId: z.string().uuid().optional(),
  q: z.string().trim().max(100).optional(),
  sort: z.enum(sortValues).default('-lastSeenAt'),
  ...pageFields,
});
const idParam = z.object({ id: z.string().uuid() });
const noteBody = z.object({ note: z.string().trim().max(1000).optional() }).strict();
const resolveBody = z.object({ note: z.string().trim().min(5, 'A resolution note of at least 5 characters is required').max(1000) }).strict();
const ruleBody = z.object({
  enabled: z.boolean(), severity: z.enum(ALERT_SEVERITIES), config: z.record(z.unknown()),
  /** Extra e-mail addresses notified for this rule (besides in-scope alert managers and the alertDeliveryPolicy lists). */
  emailRecipients: z.array(z.string().trim().toLowerCase().email().max(254)).max(50).transform((v) => [...new Set(v)]),
}).partial().strict();

/** Alerts the principal may see for `perm`. */
export function alertScopeSql(p: Principal, perm: Permission, alias = 'a'): RawBuilder<boolean> {
  const paths = scopePaths(p, perm);
  const parts: RawBuilder<unknown>[] = [];
  if (paths.length) parts.push(sql`(${sql.ref(`${alias}.org_unit_id`)} IS NOT NULL AND EXISTS (SELECT 1 FROM org_units ou WHERE ou.id = ${sql.ref(`${alias}.org_unit_id`)} AND ou.path <@ ${sql.val(paths)}::ltree[]))`);
  if (hasRootPermission(p, perm) || (hasPermission(p, perm) && hasPermission(p, 'system:monitor'))) parts.push(sql`${sql.ref(`${alias}.org_unit_id`)} IS NULL`);
  if (!parts.length) return sql<boolean>`false`;
  return sql<boolean>`(${sql.join(parts, sql` OR `)})`;
}

export default async function alerts(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const db = app.db;

  const base = () =>
    db.selectFrom('alerts as a')
      .leftJoin('org_units as o', 'o.id', 'a.org_unit_id')
      .leftJoin('users as ack', 'ack.id', 'a.acknowledged_by')
      .leftJoin('users as res', 'res.id', 'a.resolved_by')
      .select([
        'a.id', 'a.rule_code', 'a.severity', 'a.title', 'a.message', 'a.resource_type', 'a.resource_id', 'a.org_unit_id', 'a.occurrences', 'a.status',
        'a.acknowledged_at', 'a.resolved_at', 'a.resolution_note', 'a.first_seen_at', 'a.last_seen_at', 'a.notified_at', 'a.auto_resolved',
        'o.name as org_name', 'o.code as org_code', 'o.path as org_path', 'ack.full_name as ack_name', 'res.full_name as res_name',
        sql<number>`CASE a.severity WHEN 'CRITICAL' THEN 2 WHEN 'WARNING' THEN 1 ELSE 0 END`.as('sev_rank'),
      ]);
  type Row = Awaited<ReturnType<ReturnType<typeof base>['executeTakeFirstOrThrow']>>;
  const canManage = (p: Principal, r: { org_path: string | null }) => (r.org_path ? hasPermissionAt(p, 'alerts:manage', r.org_path) : hasRootPermission(p, 'alerts:manage'));
  const dto = (r: Row, p: Principal) => ({
    id: r.id, ruleCode: r.rule_code, severity: r.severity, title: r.title, message: r.message, status: r.status,
    resourceType: r.resource_type, resourceId: r.resource_id, occurrences: r.occurrences,
    orgUnit: r.org_unit_id ? { id: r.org_unit_id, name: r.org_name, code: r.org_code } : null,
    firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at, notifiedAt: r.notified_at,
    acknowledgedAt: r.acknowledged_at, acknowledgedBy: r.ack_name, resolvedAt: r.resolved_at, resolvedBy: r.auto_resolved ? 'system (auto-resolved)' : r.res_name,
    resolutionNote: r.resolution_note, autoResolved: r.auto_resolved,
    link: resourceLink(r.resource_type, r.resource_id),
    canManage: canManage(p, r),
  });

  async function loadAlert(p: Principal, id: string): Promise<Row> {
    const r = await base().where('a.id', '=', id).where(alertScopeSql(p, 'alerts:read')).executeTakeFirst();
    if (!r) throw notFound('Alert');
    return r;
  }

  app.get('/alerts', {
    preHandler: app.authorize('alerts:read'),
    schema: { tags: ['alerts'], summary: 'List alerts within jurisdiction', querystring: listQuery },
  }, async (req) => {
    const p = req.requirePrincipal();
    const f = req.query;
    let q = base().where(alertScopeSql(p, 'alerts:read'));
    if (f.status) q = q.where('a.status', 'in', f.status);
    if (f.severity) q = q.where('a.severity', 'in', f.severity);
    if (f.rule) q = q.where('a.rule_code', 'in', f.rule);
    if (f.from) q = q.where('a.last_seen_at', '>=', f.from);
    if (f.to) q = q.where('a.first_seen_at', '<', f.to);
    if (f.orgUnitId) q = q.where(sql<boolean>`o.path <@ (SELECT path FROM org_units WHERE id = ${f.orgUnitId}::uuid)`);
    if (f.q) q = q.where(sql<boolean>`(a.title ILIKE ${`%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`} OR a.resource_id = ${f.q})`);
    const total = await q.clearSelect().select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow();
    const desc = f.sort.startsWith('-');
    const col = SORTS[f.sort.replace(/^-/, '') as keyof typeof SORTS];
    const rows = await q.orderBy(sql.raw(col), desc ? 'desc' : 'asc').orderBy('a.last_seen_at', 'desc').offset((f.page - 1) * f.pageSize).limit(f.pageSize).execute();
    return { items: rows.map((r) => dto(r, p)), total: total.n, page: f.page, pageSize: f.pageSize };
  });

  app.get('/alerts/summary', {
    preHandler: app.authorize('alerts:read'),
    schema: { tags: ['alerts'], summary: 'Open/acknowledged alert counts by severity within jurisdiction' },
  }, async (req) => {
    const p = req.requirePrincipal();
    const rows = await db.selectFrom('alerts as a').select(['a.severity', 'a.status', sql<number>`count(*)::int`.as('n')])
      .where('a.status', '<>', 'RESOLVED').where(alertScopeSql(p, 'alerts:read')).groupBy(['a.severity', 'a.status']).execute();
    const bySeverity = Object.fromEntries(ALERT_SEVERITIES.map((s) => [s, rows.filter((r) => r.severity === s).reduce((a, r) => a + r.n, 0)]));
    return { open: rows.filter((r) => r.status === 'OPEN').reduce((a, r) => a + r.n, 0), acknowledged: rows.filter((r) => r.status === 'ACKNOWLEDGED').reduce((a, r) => a + r.n, 0), bySeverity };
  });

  app.get('/alerts/rules', {
    preHandler: app.authorize('alerts:manage'),
    schema: { tags: ['alerts'], summary: 'Alert rules and thresholds' },
  }, async (req) => {
    const p = req.requirePrincipal();
    const rows = await db.selectFrom('alert_rules as r').leftJoin('users as u', 'u.id', 'r.updated_by')
      .select(['r.code', 'r.name', 'r.enabled', 'r.severity', 'r.config', 'r.email_recipients', 'r.updated_at', 'u.full_name as updated_by']).orderBy('r.code').execute();
    const cursors = await db.selectFrom('alert_cursors').select(['rule_code', 'updated_at']).execute();
    return {
      canEdit: hasRootPermission(p, 'alerts:manage'),
      items: rows.map((r) => ({ code: r.code, name: r.name, enabled: r.enabled, severity: r.severity, config: r.config, emailRecipients: r.email_recipients, updatedAt: r.updated_at, updatedBy: r.updated_by, lastEvaluatedAt: cursors.find((c) => c.rule_code === r.code)?.updated_at ?? null })),
    };
  });

  app.put('/alerts/rules/:code', {
    preHandler: app.authorize('alerts:manage'),
    schema: { tags: ['alerts'], summary: 'Update an alert rule (enabled, severity, thresholds)', params: z.object({ code: z.enum(ALERT_RULE_CODES) }), body: ruleBody },
  }, async (req) => {
    const p = req.requirePrincipal();
    if (!hasRootPermission(p, 'alerts:manage')) throw forbidden('Alert rules are system-wide; a state-level alerts:manage grant is required');
    const code = req.params.code;
    const cur = await db.selectFrom('alert_rules').selectAll().where('code', '=', code).executeTakeFirst();
    if (!cur) throw notFound('Alert rule');
    let config: Record<string, unknown> | undefined;
    if (req.body.config !== undefined) {
      const parsed = RULE_CONFIG_SCHEMAS[code].safeParse(req.body.config);
      if (!parsed.success) throw validationFailed('Invalid rule configuration', parsed.error.issues);
      config = parsed.data as Record<string, unknown>;
    }
    const patch = { ...(req.body.enabled !== undefined ? { enabled: req.body.enabled } : {}), ...(req.body.severity ? { severity: req.body.severity } : {}), ...(config ? { config: JSON.stringify(config) } : {}), ...(req.body.emailRecipients ? { email_recipients: req.body.emailRecipients } : {}) };
    if (!Object.keys(patch).length) throw validationFailed('Nothing to update');
    const updated = await db.transaction().execute(async (tx) => {
      const r = await tx.updateTable('alert_rules').set({ ...patch, updated_by: p.userId, updated_at: new Date() }).where('code', '=', code).returningAll().executeTakeFirstOrThrow();
      await appendAudit(tx, req.actor(), {
        action: 'ALERT_RULE_UPDATED', resourceType: 'alert_rule', resourceId: code,
        details: { before: { enabled: cur.enabled, severity: cur.severity, config: cur.config, emailRecipients: cur.email_recipients }, after: { enabled: r.enabled, severity: r.severity, config: r.config, emailRecipients: r.email_recipients } },
      });
      return r;
    });
    return { code: updated.code, name: updated.name, enabled: updated.enabled, severity: updated.severity, config: updated.config, emailRecipients: updated.email_recipients, updatedAt: updated.updated_at };
  });

  app.get('/alerts/:id', {
    preHandler: app.authorize('alerts:read'),
    schema: { tags: ['alerts'], summary: 'Alert detail with delivery log', params: idParam },
  }, async (req) => {
    const p = req.requirePrincipal();
    const r = await loadAlert(p, req.params.id);
    const deliveries = await db.selectFrom('alert_deliveries').select(['channel', 'status', 'attempt', 'next_attempt_at', 'recipients', 'detail', 'created_at']).where('alert_id', '=', r.id).orderBy('id').execute();
    return { ...dto(r, p), deliveries: deliveries.map((d) => ({ channel: d.channel, status: d.status, attempt: d.attempt, nextAttemptAt: d.next_attempt_at, recipients: d.recipients, detail: d.detail, at: d.created_at })) };
  });

  const transition = (to: 'ACKNOWLEDGED' | 'RESOLVED') => async (p: Principal, id: string, note: string | undefined, actor: AuditActor) => {
    const r = await loadAlert(p, id);
    if (!canManage(p, r)) throw forbidden();
    if (r.status === 'RESOLVED') throw conflict('Alert is already resolved');
    if (to === 'ACKNOWLEDGED' && r.status === 'ACKNOWLEDGED') throw conflict('Alert is already acknowledged');
    await db.transaction().execute(async (tx) => {
      const now = new Date();
      const set = to === 'ACKNOWLEDGED'
        ? { status: to, acknowledged_by: p.userId, acknowledged_at: now, ...(note ? { resolution_note: note } : {}) }
        : { status: to, resolved_by: p.userId, resolved_at: now, resolution_note: note!, auto_resolved: false, ...(r.acknowledged_at ? {} : { acknowledged_by: p.userId, acknowledged_at: now }) };
      const res = await tx.updateTable('alerts').set(set).where('id', '=', id).where('status', '=', r.status).executeTakeFirst();
      if (!Number(res.numUpdatedRows ?? 0)) throw conflict('Alert changed concurrently; reload and retry');
      await appendAudit(tx, actor, {
        action: to === 'ACKNOWLEDGED' ? 'ALERT_ACKNOWLEDGED' : 'ALERT_RESOLVED', resourceType: 'alert', resourceId: id, orgUnitId: r.org_unit_id,
        details: { ruleCode: r.rule_code, severity: r.severity, previousStatus: r.status, note: note ?? null },
      });
    });
    return dto(await loadAlert(p, id), p);
  };

  app.post('/alerts/:id/acknowledge', {
    preHandler: app.authorize('alerts:manage'),
    schema: { tags: ['alerts'], summary: 'Acknowledge an alert', params: idParam, body: noteBody },
  }, async (req) => transition('ACKNOWLEDGED')(req.requirePrincipal(), req.params.id, req.body.note, req.actor()));

  app.post('/alerts/:id/resolve', {
    preHandler: app.authorize('alerts:manage'),
    schema: { tags: ['alerts'], summary: 'Resolve an alert with a note', params: idParam, body: resolveBody },
  }, async (req) => transition('RESOLVED')(req.requirePrincipal(), req.params.id, req.body.note, req.actor()));

  // ---- notifications (own) ---------------------------------------------------------------------
  app.get('/notifications', {
    schema: { tags: ['notifications'], summary: 'My notifications', querystring: z.object({ unread: z.enum(['true', 'false']).optional(), ...pageFields }) },
  }, async (req) => {
    const p = req.requirePrincipal();
    if (!p.userId) return { items: [], total: 0, unread: 0, page: 1, pageSize: req.query.pageSize };
    let q = db.selectFrom('notifications').where('user_id', '=', p.userId);
    if (req.query.unread === 'true') q = q.where('read_at', 'is', null);
    const [total, unread, rows] = await Promise.all([
      q.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow(),
      db.selectFrom('notifications').select(sql<number>`count(*)::int`.as('n')).where('user_id', '=', p.userId).where('read_at', 'is', null).executeTakeFirstOrThrow(),
      q.select(['id', 'kind', 'title', 'body', 'link', 'read_at', 'created_at']).orderBy('created_at', 'desc').offset((req.query.page - 1) * req.query.pageSize).limit(req.query.pageSize).execute(),
    ]);
    return {
      items: rows.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, link: n.link, readAt: n.read_at, createdAt: n.created_at })),
      total: total.n, unread: unread.n, page: req.query.page, pageSize: req.query.pageSize,
    };
  });

  app.post('/notifications/:id/read', {
    schema: { tags: ['notifications'], summary: 'Mark one of my notifications read', params: idParam },
  }, async (req) => {
    const p = req.requirePrincipal();
    const r = await db.updateTable('notifications').set({ read_at: sql`coalesce(read_at, now())` }).where('id', '=', req.params.id).where('user_id', '=', p.userId ?? '00000000-0000-0000-0000-000000000000').executeTakeFirst();
    if (!Number(r.numUpdatedRows ?? 0)) throw notFound('Notification');
    return { ok: true };
  });

  app.post('/notifications/read-all', {
    schema: { tags: ['notifications'], summary: 'Mark all my notifications read' },
  }, async (req) => {
    const p = req.requirePrincipal();
    if (!p.userId) return { updated: 0 };
    const r = await db.updateTable('notifications').set({ read_at: new Date() }).where('user_id', '=', p.userId).where('read_at', 'is', null).executeTakeFirst();
    return { updated: Number(r.numUpdatedRows ?? 0) };
  });
}

/** Web link for an alert's subject (never a storage URL). */
export function resourceLink(type: string | null, id: string | null): string | null {
  if (!type || !id) return null;
  if (type === 'evidence') return `/evidence/${id}`;
  if (type === 'upload_session') return '/uploads';
  if (type === 'queue' || type === 'storage' || type === 'audit_ledger') return '/system/health';
  if (type === 'user') return `/admin/users/${id}`;
  return null;
}
