/**
 * Secure sharing (spec module 15).
 *
 *   POST /shares               share:create; each item loadEvidenceFor 'evidence:play' (+ download_original when allowDownload)
 *   GET  /shares?view=mine|all|received
 *   GET  /shares/:id           detail + access log (creator / share:manage_all in scope; recipients see a reduced view)
 *   POST /shares/:id/revoke    creator or share:manage_all in scope
 *
 * INTERNAL_USER shares grant visibility through the canonical access rule (lib/access.ts rule 4).
 * EXTERNAL shares: the link token and the access code are returned ONCE (stored as sha256 / argon2id) and are
 * used on the public portal (/share-portal, web route /s/:token).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql, type SelectQueryBuilder } from 'kysely';
import { appendAudit, hashSecret, randomDigits, randomToken, sha256Hex, type Database, type Tx } from '@ksp/core';
import { SHARE_STATUSES, type Permission } from '@ksp/shared';
import { loadEvidenceFor, orgScopeSql } from '../../lib/access.js';
import { badRequest, conflict, forbidden, notFound, validationFailed } from '../../lib/errors.js';
import { hasPermission, hasPermissionAt, type Principal } from '../../lib/principal.js';
import { getSettings } from '../../lib/settings.js';

export const prefix = '/shares';

const STORED = ['REGISTERED', 'DISPOSAL_PENDING'];
const idParams = z.object({ id: z.string().uuid() });
const optText = (max: number) => z.string().trim().max(max).optional().transform((v) => (v ? v : undefined));

export const createShareBody = z.object({
  evidenceIds: z.array(z.string().uuid()).min(1).max(50),
  caseId: z.string().uuid().optional(),
  recipientType: z.enum(['INTERNAL_USER', 'EXTERNAL']),
  recipientUserId: z.string().uuid().optional(),
  recipientName: optText(200),
  recipientEmail: z.string().trim().email().max(254).optional(),
  recipientOrg: optText(200),
  purpose: z.string().trim().min(5).max(2000),
  allowDownload: z.boolean().default(false),
  allowOriginal: z.boolean().default(false),
  allowPrint: z.boolean().default(false),
  watermark: z.boolean().default(true),
  maxViews: z.number().int().min(1).max(1000).optional(),
  expiresAt: z.coerce.date(),
}).strict();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose<T> = SelectQueryBuilder<any, any, T>;

type ShareRow = {
  id: string; created_by: string; org_unit_id: string; case_id: string | null; recipient_type: string; recipient_user_id: string | null; recipient_name: string | null;
  recipient_email: string | null; recipient_org: string | null; purpose: string; allow_download: boolean; allow_original: boolean; allow_print: boolean; watermark: boolean;
  max_views: number | null; view_count: number; download_count: number; failed_code_attempts: number; status: string; expires_at: Date; revoked_by: string | null;
  revoked_at: Date | null; revoke_reason: string | null; last_accessed_at: Date | null; created_at: Date; locked_at: Date | null;
  org_path: string; org_name: string; creator_name: string; creator_username: string; recipient_user_name: string | null; revoker_name: string | null;
  case_number: string | null; item_count: number;
};

function baseSelect(db: Database | Tx): Loose<ShareRow> {
  return (db
    .selectFrom('shares as s')
    .innerJoin('org_units as o', 'o.id', 's.org_unit_id')
    .innerJoin('users as cu', 'cu.id', 's.created_by')
    .leftJoin('users as ru', 'ru.id', 's.recipient_user_id')
    .leftJoin('users as vu', 'vu.id', 's.revoked_by')
    .leftJoin('cases as c', 'c.id', 's.case_id')
    .select([
      's.id', 's.created_by', 's.org_unit_id', 's.case_id', 's.recipient_type', 's.recipient_user_id', 's.recipient_name', 's.recipient_email', 's.recipient_org', 's.purpose',
      's.allow_download', 's.allow_original', 's.allow_print', 's.watermark', 's.max_views', 's.view_count', 's.download_count', 's.failed_code_attempts', 's.status', 's.expires_at',
      's.revoked_by', 's.revoked_at', 's.revoke_reason', 's.last_accessed_at', 's.created_at', 's.locked_at',
      'o.path as org_path', 'o.name as org_name', 'cu.full_name as creator_name', 'cu.username as creator_username', 'ru.full_name as recipient_user_name',
      'vu.full_name as revoker_name', 'c.case_number',
      sql<number>`(SELECT count(*)::int FROM share_items si WHERE si.share_id = s.id)`.as('item_count'),
    ]) as unknown) as Loose<ShareRow>;
}

const effectiveStatus = (r: ShareRow) => (r.status === 'ACTIVE' && r.expires_at <= new Date() ? 'EXPIRED' : r.status);
const canManage = (p: Principal, r: ShareRow) => r.created_by === p.userId || hasPermissionAt(p, 'share:manage_all', r.org_path);

export function shareDto(p: Principal, r: ShareRow) {
  const status = effectiveStatus(r);
  return {
    id: r.id,
    status,
    recipientType: r.recipient_type,
    recipient: r.recipient_type === 'INTERNAL_USER'
      ? { userId: r.recipient_user_id, name: r.recipient_user_name }
      : { name: r.recipient_name, email: r.recipient_email, organisation: r.recipient_org },
    purpose: r.purpose,
    permissions: { allowDownload: r.allow_download, allowOriginal: r.allow_original, allowPrint: r.allow_print, watermark: r.watermark },
    maxViews: r.max_views,
    viewCount: r.view_count,
    downloadCount: r.download_count,
    failedCodeAttempts: r.failed_code_attempts,
    expiresAt: r.expires_at.toISOString(),
    createdAt: r.created_at.toISOString(),
    createdBy: { id: r.created_by, name: r.creator_name, username: r.creator_username },
    orgUnit: { id: r.org_unit_id, name: r.org_name },
    case: r.case_id ? { id: r.case_id, caseNumber: r.case_number } : null,
    lastAccessedAt: r.last_accessed_at?.toISOString() ?? null,
    lockedAt: r.locked_at?.toISOString() ?? null,
    revokedAt: r.revoked_at?.toISOString() ?? null,
    revokedBy: r.revoked_by ? { id: r.revoked_by, name: r.revoker_name } : null,
    revokeReason: r.revoke_reason,
    itemCount: Number(r.item_count),
    canRevoke: canManage(p, r) && ['ACTIVE', 'LOCKED'].includes(status),
  };
}

export default async function shares(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  const anyOf = (...perms: Permission[]) => async (req: FastifyRequest) => {
    const p = req.requirePrincipal();
    if (!perms.some((x) => hasPermission(p, x))) {
      await appendAudit(app.db, req.actor(), { action: 'ACCESS_DENIED', outcome: 'DENIED', resourceType: 'route', resourceId: `${req.method} ${req.routeOptions.url}`, details: { missingAnyOf: perms } });
      throw forbidden();
    }
  };

  const shareItems = (id: string) =>
    app.db
      .selectFrom('share_items as si')
      .innerJoin('evidence as e', 'e.id', 'si.evidence_id')
      .select(['si.evidence_id', 'e.evidence_number', 'e.title', 'e.org_unit_id', 'e.duration_ms', 'e.recorded_at'])
      .where('si.share_id', '=', id)
      .orderBy('e.evidence_number')
      .execute();

  // ---------------------------------------------------------------------------------------------
  app.post('/', {
    preHandler: app.authorize('share:create'),
    schema: { tags: ['shares'], summary: 'Share evidence with an internal user or an external recipient', body: createShareBody },
  }, async (req, reply) => {
    const p = req.requirePrincipal();
    const b = req.body;
    const settings = await getSettings(app.db);
    const now = Date.now();
    if (b.expiresAt.getTime() <= now + 60_000) throw validationFailed('expiresAt must be in the future');
    if (b.expiresAt.getTime() > now + settings.shareExportPolicy.maxShareDays * 86_400_000 + 60_000) throw validationFailed(`Shares may last at most ${settings.shareExportPolicy.maxShareDays} days`);
    if (b.allowOriginal && !b.allowDownload) throw validationFailed('allowOriginal requires allowDownload');
    if (b.recipientType === 'INTERNAL_USER') {
      if (!b.recipientUserId) throw validationFailed('recipientUserId is required for internal shares');
      if (b.recipientUserId === p.userId) throw badRequest('You cannot share with yourself');
      const u = await app.db.selectFrom('users').select(['id', 'status']).where('id', '=', b.recipientUserId).executeTakeFirst();
      if (!u || u.status !== 'ACTIVE') throw notFound('Recipient user');
    } else if (!b.recipientName || !b.recipientEmail) {
      throw validationFailed('recipientName and recipientEmail are required for external shares');
    }
    const ids = [...new Set(b.evidenceIds)];
    const items: Array<{ id: string; org_unit_id: string; evidence_number: string | null; org_path: string }> = [];
    for (const id of ids) {
      const ev = await loadEvidenceFor(app.db, p, id, 'evidence:play', req.actor());
      if (!STORED.includes(ev.status)) throw conflict(`Evidence ${ev.evidence_number ?? ev.id} cannot be shared (status ${ev.status})`);
      // Allowing the recipient to download (or an external recipient to view without a watermark) requires the
      // sharer to hold download_original over the item themself.
      const needsOriginal = b.allowDownload || (b.recipientType === 'EXTERNAL' && !b.watermark);
      if (needsOriginal && !hasPermissionAt(p, 'evidence:download_original', ev.org_path)) {
        await appendAudit(app.db, req.actor(), { action: 'EVIDENCE_ACCESS_DENIED', outcome: 'DENIED', resourceType: 'evidence', resourceId: ev.id, evidenceId: ev.id, orgUnitId: ev.org_unit_id, details: { attemptedAction: 'share:create', reason: b.allowDownload ? 'allowDownload requires evidence:download_original' : 'unwatermarked external share requires evidence:download_original' } });
        throw forbidden(b.allowDownload ? 'Allowing downloads requires that you may download the original' : 'Unwatermarked external shares require that you may download the original');
      }
      items.push(ev);
    }
    let orgUnitId = items[0]!.org_unit_id;
    if (b.caseId) {
      const c = await app.db.selectFrom('cases').select(['id', 'org_unit_id', 'org_path', 'investigating_officer_id', 'supervisor_id']).where('id', '=', b.caseId).executeTakeFirst();
      if (!c || !(hasPermissionAt(p, 'cases:read', c.org_path) || c.investigating_officer_id === p.userId || c.supervisor_id === p.userId)) throw notFound('Case');
      orgUnitId = c.org_unit_id;
    }
    const external = b.recipientType === 'EXTERNAL';
    const token = external ? randomToken(32) : null;
    const accessCode = external ? randomDigits(8) : null;
    const codeHash = accessCode ? await hashSecret(accessCode) : null;
    const created = await app.db.transaction().execute(async (tx) => {
      const s = await tx
        .insertInto('shares')
        .values({
          created_by: p.userId!, org_unit_id: orgUnitId, case_id: b.caseId ?? null, recipient_type: b.recipientType,
          recipient_user_id: external ? null : b.recipientUserId!, recipient_name: b.recipientName ?? null, recipient_email: b.recipientEmail ?? null, recipient_org: b.recipientOrg ?? null,
          purpose: b.purpose, allow_download: b.allowDownload, allow_original: b.allowOriginal, allow_print: b.allowPrint, watermark: external ? b.watermark : true,
          max_views: b.maxViews ?? null, token_hash: token ? sha256Hex(token) : null, access_code_hash: codeHash, expires_at: b.expiresAt, status: 'ACTIVE',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await tx.insertInto('share_items').values(items.map((i) => ({ share_id: s.id, evidence_id: i.id }))).execute();
      for (const i of items) {
        await appendAudit(tx, req.actor(), {
          action: 'SHARE_CREATED', resourceType: 'share', resourceId: s.id, evidenceId: i.id, caseId: b.caseId ?? null, orgUnitId: i.org_unit_id,
          details: {
            recipientType: b.recipientType, recipientUserId: b.recipientUserId ?? null, recipientName: b.recipientName ?? null, recipientEmail: b.recipientEmail ?? null, recipientOrg: b.recipientOrg ?? null,
            purpose: b.purpose, allowDownload: b.allowDownload, allowOriginal: b.allowOriginal, allowPrint: b.allowPrint, watermark: external ? b.watermark : true, maxViews: b.maxViews ?? null,
            expiresAt: b.expiresAt.toISOString(), items: items.length,
          },
        });
      }
      return s;
    });
    const row = (await baseSelect(app.db).where('s.id', '=', created.id).executeTakeFirstOrThrow()) as ShareRow;
    return reply.status(201).send({
      share: shareDto(p, row),
      // Returned ONCE. Send the link and the access code to the recipient through DIFFERENT channels.
      ...(external ? { link: `${app.cfg.APP_BASE_URL.replace(/\/$/, '')}/s/${token}`, token, accessCode } : {}),
    });
  });

  // ---------------------------------------------------------------------------------------------
  app.get('/', {
    preHandler: anyOf('share:create', 'share:manage_all', 'evidence:read', 'evidence:read_own', 'cases:read'),
    schema: {
      tags: ['shares'], summary: 'List shares: mine (created), received (internal, to me) or all in scope (share:manage_all)',
      querystring: z.object({
        view: z.enum(['mine', 'received', 'all']).default('mine'),
        status: z.enum(SHARE_STATUSES).optional(),
        evidenceId: z.string().uuid().optional(),
        q: z.string().trim().max(100).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(25),
      }),
    },
  }, async (req) => {
    const p = req.requirePrincipal();
    const { view, status, evidenceId, q, page, pageSize } = req.query;
    let qb = baseSelect(app.db);
    if (view === 'mine') qb = qb.where('s.created_by', '=', p.userId!);
    else if (view === 'received') qb = qb.where('s.recipient_user_id', '=', p.userId!);
    else {
      if (!hasPermission(p, 'share:manage_all')) throw forbidden();
      qb = qb.where(orgScopeSql(p, 'share:manage_all', 'o.path'));
    }
    if (status === 'EXPIRED') qb = qb.where((eb) => eb.or([eb('s.status', '=', 'EXPIRED'), eb.and([eb('s.status', '=', 'ACTIVE'), eb('s.expires_at', '<=', new Date())])]));
    else if (status === 'ACTIVE') qb = qb.where('s.status', '=', 'ACTIVE').where('s.expires_at', '>', new Date());
    else if (status) qb = qb.where('s.status', '=', status);
    if (evidenceId) qb = qb.where(sql<boolean>`EXISTS (SELECT 1 FROM share_items x WHERE x.share_id = s.id AND x.evidence_id = ${evidenceId}::uuid)`);
    if (q) qb = qb.where((eb) => eb.or([eb('s.recipient_name', 'ilike', `%${q}%`), eb('s.recipient_email', 'ilike', `%${q}%`), eb('s.purpose', 'ilike', `%${q}%`)]));
    const total = Number((await qb.clearSelect().select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n);
    const rows = (await qb.orderBy('s.created_at', 'desc').orderBy('s.id').limit(pageSize).offset((page - 1) * pageSize).execute()) as ShareRow[];
    return { items: rows.map((r) => shareDto(p, r)), total, page, pageSize };
  });

  app.get('/:id', {
    schema: { tags: ['shares'], summary: 'Share detail with items and access log', params: idParams },
  }, async (req) => {
    const p = req.requirePrincipal();
    const r = (await baseSelect(app.db).where('s.id', '=', req.params.id).executeTakeFirst()) as ShareRow | undefined;
    const isRecipient = !!r && r.recipient_user_id === p.userId;
    if (!r || !(canManage(p, r) || isRecipient)) throw notFound('Share');
    const items = await shareItems(r.id);
    const manager = canManage(p, r);
    const log = manager
      ? await app.db.selectFrom('share_access_log').select(['id', 'evidence_id', 'action', sql<string | null>`host(ip)`.as('ip'), 'user_agent', 'detail', 'created_at']).where('share_id', '=', r.id).orderBy('id', 'desc').limit(500).execute()
      : [];
    return {
      ...shareDto(p, r),
      items: items.map((i) => ({ evidenceId: i.evidence_id, evidenceNumber: i.evidence_number, title: i.title, durationMs: i.duration_ms === null ? null : Number(i.duration_ms), recordedAt: i.recorded_at?.toISOString() ?? null })),
      accessLog: log.map((l) => ({ id: Number(l.id), evidenceId: l.evidence_id, action: l.action, ip: l.ip, userAgent: l.user_agent, detail: l.detail, at: l.created_at.toISOString() })),
    };
  });

  app.post('/:id/revoke', {
    schema: { tags: ['shares'], summary: 'Revoke a share (access stops immediately)', params: idParams, body: z.object({ reason: z.string().trim().min(5).max(2000) }).strict() },
  }, async (req) => {
    const p = req.requirePrincipal();
    const r = (await baseSelect(app.db).where('s.id', '=', req.params.id).executeTakeFirst()) as ShareRow | undefined;
    if (!r || !(canManage(p, r) || r.recipient_user_id === p.userId)) throw notFound('Share');
    if (!canManage(p, r)) throw forbidden();
    if (!['ACTIVE', 'LOCKED'].includes(r.status)) throw conflict(`Share is ${r.status}`);
    const items = await shareItems(r.id);
    await app.db.transaction().execute(async (tx) => {
      const upd = await tx.updateTable('shares').set({ status: 'REVOKED', revoked_by: p.userId, revoked_at: new Date(), revoke_reason: req.body.reason }).where('id', '=', r.id).where('status', 'in', ['ACTIVE', 'LOCKED']).executeTakeFirst();
      if (!upd.numUpdatedRows) throw conflict('Share changed concurrently');
      for (const i of items) {
        await appendAudit(tx, req.actor(), { action: 'SHARE_REVOKED', resourceType: 'share', resourceId: r.id, evidenceId: i.evidence_id, caseId: r.case_id, orgUnitId: i.org_unit_id, details: { reason: req.body.reason, previousStatus: r.status, recipientType: r.recipient_type } });
      }
    });
    const row = (await baseSelect(app.db).where('s.id', '=', r.id).executeTakeFirstOrThrow()) as ShareRow;
    return shareDto(p, row);
  });
}
