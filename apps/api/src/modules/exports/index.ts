/**
 * Court evidence export (spec module 14).
 *
 *   POST /exports                    request an export (export:create; each item via loadEvidenceFor)      -> PENDING_APPROVAL
 *   GET  /exports?view=mine|pending|all
 *   GET  /exports/:id                detail incl. items with verified hashes
 *   POST /exports/:id/approve        export:approve; approver != requester (also DB CHECK); approver must see every item
 *   POST /exports/:id/reject         export:approve; reason required
 *   POST /exports/:id/revoke         requester or in-scope approver; deletes the package
 *   GET  /exports/:id/download       export:download -> short-lived tokenised URL (scope 'export')
 *   GET  /exports/:id/package?t=     (token) streams the ZIP with Range; custody-audited per item
 *   POST /exports/verify             verify a package (application/octet-stream ZIP) or {manifest, signature}
 *
 * Package build: worker queue EXPORT_BUILD (apps/worker/src/jobs/exports). Layout: docs/COURT-EXPORT.md.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql, type SelectQueryBuilder } from 'kysely';
import { appendAudit, enqueue, type Database, type Tx } from '@ksp/core';
import { EXPORT_STATUSES, QUEUES, type ExportBuildPayload, type Permission } from '@ksp/shared';
import { loadEvidenceFor, orgScopeSql } from '../../lib/access.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { hasPermission, hasPermissionAt, type Principal } from '../../lib/principal.js';
import { authenticateMediaToken, issueUserToken, tokenExpiry } from '../media/tokens.js';
import { sendObject } from '../media/stream.js';
import { readZip, verifyExport } from './verify.js';

export const prefix = '/exports';

export const EXPORT_DOWNLOAD_TTL_SECONDS = 120;
// Items with an open disposal request are not exported (the package would outlive the authorised disposal).
const STORED = ['REGISTERED'];
const MAX_VERIFY_BYTES = 100 * 1024 * 1024;

const idParams = z.object({ id: z.string().uuid() });
const optText = (max: number) => z.string().trim().max(max).optional().transform((v) => (v ? v : undefined));

export const createExportBody = z.object({
  evidenceIds: z.array(z.string().uuid()).min(1).max(100),
  caseId: z.string().uuid().optional(),
  purpose: z.string().trim().min(5).max(2000),
  courtName: optText(300),
  courtCaseNumber: optText(200),
  recipient: optText(300),
  options: z.object({
    includeOriginal: z.boolean().default(true),
    includeWatermarked: z.boolean().default(false),
    includeCustodyReport: z.boolean().default(true),
    includeFactSheet: z.boolean().default(true),
    watermarkText: optText(120),
  }).strict().default({}),
}).strict().refine((b) => b.options.includeOriginal || b.options.includeWatermarked, { message: 'Include the originals and/or watermarked copies', path: ['options'] });

type ExportRow = {
  id: string; export_number: string; created_by: string; org_unit_id: string; case_id: string | null; purpose: string; court_name: string | null; court_case_number: string | null;
  recipient: string | null; options: unknown; status: string; approved_by: string | null; approved_at: Date | null; decision_note: string | null; size_bytes: number | null; sha256: string | null;
  manifest_sha256: string | null; signature_alg: string | null; signing_key_id: string | null; signing_cert_fingerprint: string | null; error: string | null; download_count: number;
  created_at: Date; completed_at: Date | null; expires_at: Date | null; progress: number; revoked_at: Date | null; revoked_by: string | null; revoke_reason: string | null;
  ledger_head_seq: number | null; ledger_head_hash: string | null; bucket: string | null; object_key: string | null;
  org_path: string; org_name: string; org_code: string; creator_name: string; creator_username: string; approver_name: string | null; revoker_name: string | null;
  case_number: string | null; case_title: string | null; item_count: number;
};

// Loosely typed on purpose: the fully inferred 6-join builder type overflows the TypeScript checker.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseSelect = SelectQueryBuilder<any, any, ExportRow>;

function baseSelect(db: Database | Tx): LooseSelect {
  return (db
    .selectFrom('exports as x')
    .innerJoin('org_units as o', 'o.id', 'x.org_unit_id')
    .innerJoin('users as cu', 'cu.id', 'x.created_by')
    .leftJoin('users as au', 'au.id', 'x.approved_by')
    .leftJoin('users as ru', 'ru.id', 'x.revoked_by')
    .leftJoin('cases as c', 'c.id', 'x.case_id')
    .selectAll('x')
    .select([
      'o.path as org_path', 'o.name as org_name', 'o.code as org_code', 'cu.full_name as creator_name', 'cu.username as creator_username', 'au.full_name as approver_name',
      'ru.full_name as revoker_name', 'c.case_number', 'c.title as case_title',
      sql<number>`(SELECT count(*)::int FROM export_items xi WHERE xi.export_id = x.id)`.as('item_count'),
    ]) as unknown) as LooseSelect;
}

function canApprove(p: Principal, r: ExportRow) {
  return r.status === 'PENDING_APPROVAL' && r.created_by !== p.userId && hasPermissionAt(p, 'export:approve', r.org_path);
}
function canAccess(p: Principal, r: ExportRow) {
  return r.created_by === p.userId || r.approved_by === p.userId || hasPermissionAt(p, 'export:approve', r.org_path);
}
function canDownload(p: Principal, r: ExportRow) {
  return r.status === 'READY' && !!r.expires_at && r.expires_at > new Date() && hasPermission(p, 'export:download') && canAccess(p, r);
}
function canRevoke(p: Principal, r: ExportRow) {
  return ['PENDING_APPROVAL', 'APPROVED', 'PROCESSING', 'READY', 'FAILED'].includes(r.status) && (r.created_by === p.userId || hasPermissionAt(p, 'export:approve', r.org_path));
}

export function exportDto(p: Principal, r: ExportRow) {
  return {
    id: r.id,
    exportNumber: r.export_number,
    status: r.status,
    purpose: r.purpose,
    courtName: r.court_name,
    courtCaseNumber: r.court_case_number,
    recipient: r.recipient,
    options: r.options,
    orgUnit: { id: r.org_unit_id, name: r.org_name, code: r.org_code },
    case: r.case_id ? { id: r.case_id, caseNumber: r.case_number, title: r.case_title } : null,
    createdBy: { id: r.created_by, name: r.creator_name, username: r.creator_username },
    createdAt: r.created_at.toISOString(),
    approvedBy: r.approved_by ? { id: r.approved_by, name: r.approver_name } : null,
    approvedAt: r.approved_at?.toISOString() ?? null,
    decisionNote: r.decision_note,
    progress: Number(r.progress ?? 0),
    error: r.error,
    sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
    sha256: r.sha256,
    manifestSha256: r.manifest_sha256,
    signatureAlgorithm: r.signature_alg,
    signingKeyId: r.signing_key_id,
    certificateFingerprint: r.signing_cert_fingerprint,
    ledgerHead: r.ledger_head_seq ? { seq: Number(r.ledger_head_seq), hash: r.ledger_head_hash } : null,
    downloadCount: r.download_count,
    completedAt: r.completed_at?.toISOString() ?? null,
    expiresAt: r.expires_at?.toISOString() ?? null,
    revokedAt: r.revoked_at?.toISOString() ?? null,
    revokedBy: r.revoked_by ? { id: r.revoked_by, name: r.revoker_name } : null,
    revokeReason: r.revoke_reason,
    itemCount: Number(r.item_count),
    permissions: { canApprove: canApprove(p, r) && hasPermission(p, 'export:approve'), canDownload: canDownload(p, r), canRevoke: canRevoke(p, r) },
  };
}

async function exportItems(db: Database | Tx, exportId: string) {
  return db
    .selectFrom('export_items as xi')
    .innerJoin('evidence as e', 'e.id', 'xi.evidence_id')
    .select(['xi.evidence_id', 'e.evidence_number', 'e.title', 'e.org_unit_id', 'e.duration_ms', 'e.recorded_at', 'xi.expected_sha256', 'xi.verified_sha256', 'xi.verified_sha512', 'xi.verified_ok', 'xi.verified_at', 'xi.verify_error'])
    .where('xi.export_id', '=', exportId)
    .orderBy('e.evidence_number')
    .execute();
}

async function auditPerItem(db: Database | Tx, actor: ReturnType<FastifyRequest['actor']>, action: Parameters<typeof appendAudit>[2]['action'], ex: { id: string; export_number: string; case_id: string | null }, items: Array<{ evidence_id: string; org_unit_id: string }>, details: Record<string, unknown> = {}, outcome?: 'SUCCESS' | 'FAILURE' | 'DENIED') {
  for (const it of items) {
    await appendAudit(db, actor, { action, outcome, resourceType: 'export', resourceId: ex.id, evidenceId: it.evidence_id, caseId: ex.case_id, orgUnitId: it.org_unit_id, details: { exportNumber: ex.export_number, ...details } });
  }
}

export default async function exportsModule(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  const anyOf = (...perms: Permission[]) => async (req: FastifyRequest) => {
    const p = req.requirePrincipal();
    if (!perms.some((x) => hasPermission(p, x))) {
      await appendAudit(app.db, req.actor(), { action: 'ACCESS_DENIED', outcome: 'DENIED', resourceType: 'route', resourceId: `${req.method} ${req.routeOptions.url}`, details: { missingAnyOf: perms } });
      throw forbidden();
    }
  };

  async function loadExport(p: Principal, id: string): Promise<ExportRow> {
    const r = (await baseSelect(app.db).where('x.id', '=', id).executeTakeFirst()) as ExportRow | undefined;
    if (!r || !canAccess(p, r)) throw notFound('Export');
    return r;
  }

  // ---------------------------------------------------------------------------------------------
  app.post('/', {
    preHandler: app.authorize('export:create'),
    schema: { tags: ['exports'], summary: 'Request a court export (requires approval)', body: createExportBody },
  }, async (req, reply) => {
    const p = req.requirePrincipal();
    const b = req.body;
    const ids = [...new Set(b.evidenceIds)];
    const action: Permission = b.options.includeOriginal ? 'evidence:download_original' : 'evidence:play';
    const items: Array<{ id: string; org_unit_id: string; evidence_number: string | null; status: string; sha256: string; sha512: string | null }> = [];
    for (const id of ids) {
      const ev = await loadEvidenceFor(app.db, p, id, action, req.actor());
      if (!STORED.includes(ev.status)) throw conflict(`Evidence ${ev.evidence_number ?? ev.id} is not available for export (status ${ev.status})`);
      const h = await app.db.selectFrom('evidence').select(['sha256', 'sha512']).where('id', '=', ev.id).executeTakeFirstOrThrow();
      if (!h.sha256) throw conflict(`Evidence ${ev.evidence_number ?? ev.id} has no registered hash`);
      items.push({ ...ev, sha256: h.sha256, sha512: h.sha512 });
    }
    let orgUnitId = items[0]!.org_unit_id;
    if (b.caseId) {
      const c = await app.db.selectFrom('cases').select(['id', 'org_unit_id', 'org_path', 'investigating_officer_id', 'supervisor_id']).where('id', '=', b.caseId).executeTakeFirst();
      const member = c && p.userId ? await app.db.selectFrom('case_members').select('user_id').where('case_id', '=', c.id).where('user_id', '=', p.userId).executeTakeFirst() : undefined;
      if (!c || !(hasPermissionAt(p, 'cases:read', c.org_path) || c.investigating_officer_id === p.userId || c.supervisor_id === p.userId || member)) throw notFound('Case');
      orgUnitId = c.org_unit_id;
    }
    const row = await app.db.transaction().execute(async (tx) => {
      const { rows } = await sql<{ n: string }>`SELECT nextval('export_number_seq')::text AS n`.execute(tx);
      const exportNumber = `EXP-${new Date().getUTCFullYear()}-${rows[0]!.n.padStart(6, '0')}`;
      const x = await tx
        .insertInto('exports')
        .values({
          export_number: exportNumber, created_by: p.userId!, org_unit_id: orgUnitId, case_id: b.caseId ?? null, purpose: b.purpose, court_name: b.courtName ?? null,
          court_case_number: b.courtCaseNumber ?? null, recipient: b.recipient ?? null, options: JSON.stringify(b.options), status: 'PENDING_APPROVAL',
        })
        .returning(['id', 'export_number', 'case_id'])
        .executeTakeFirstOrThrow();
      await tx.insertInto('export_items').values(items.map((i) => ({ export_id: x.id, evidence_id: i.id, expected_sha256: i.sha256, expected_sha512: i.sha512 }))).execute();
      await auditPerItem(tx, req.actor(), 'EXPORT_REQUESTED', x, items.map((i) => ({ evidence_id: i.id, org_unit_id: i.org_unit_id })), { purpose: b.purpose, courtName: b.courtName ?? null, courtCaseNumber: b.courtCaseNumber ?? null, recipient: b.recipient ?? null, options: b.options, items: items.length });
      return x;
    });
    const full = await loadExport(p, row.id);
    return reply.status(201).send(exportDto(p, full));
  });

  // ---------------------------------------------------------------------------------------------
  app.get('/', {
    preHandler: anyOf('export:create', 'export:approve', 'export:download'),
    schema: {
      tags: ['exports'], summary: 'List exports: mine, pending approval (in scope, not mine) or all in scope',
      querystring: z.object({
        view: z.enum(['mine', 'pending', 'all']).default('mine'),
        status: z.enum(EXPORT_STATUSES).optional(),
        caseId: z.string().uuid().optional(),
        q: z.string().trim().max(100).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(25),
        sort: z.enum(['created_at', '-created_at', 'export_number', '-export_number', 'status', '-status']).default('-created_at'),
      }),
    },
  }, async (req) => {
    const p = req.requirePrincipal();
    const { view, status, caseId, q, page, pageSize, sort } = req.query;
    let qb = baseSelect(app.db);
    if (view === 'mine') qb = qb.where('x.created_by', '=', p.userId!);
    else if (view === 'pending') qb = qb.where('x.status', '=', 'PENDING_APPROVAL').where('x.created_by', '<>', p.userId!).where(orgScopeSql(p, 'export:approve', 'o.path'));
    else qb = qb.where((eb) => eb.or([eb('x.created_by', '=', p.userId!), eb('x.approved_by', '=', p.userId!), orgScopeSql(p, 'export:approve', 'o.path')]));
    if (status) qb = qb.where('x.status', '=', status);
    if (caseId) qb = qb.where('x.case_id', '=', caseId);
    if (q) qb = qb.where((eb) => eb.or([eb('x.export_number', 'ilike', `%${q}%`), eb('x.purpose', 'ilike', `%${q}%`), eb('x.court_case_number', 'ilike', `%${q}%`)]));
    const total = Number((await qb.clearSelect().select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n);
    const col = sort.replace('-', '') as 'created_at' | 'export_number' | 'status';
    const rows = (await qb.orderBy(`x.${col}`, sort.startsWith('-') ? 'desc' : 'asc').orderBy('x.id').limit(pageSize).offset((page - 1) * pageSize).execute()) as ExportRow[];
    return { items: rows.map((r) => exportDto(p, r)), total, page, pageSize };
  });

  app.get('/:id', {
    preHandler: anyOf('export:create', 'export:approve', 'export:download'),
    schema: { tags: ['exports'], summary: 'Export detail with items and verification results', params: idParams },
  }, async (req) => {
    const p = req.requirePrincipal();
    const r = await loadExport(p, req.params.id);
    const items = await exportItems(app.db, r.id);
    return {
      ...exportDto(p, r),
      items: items.map((i) => ({
        evidenceId: i.evidence_id, evidenceNumber: i.evidence_number, title: i.title, durationMs: i.duration_ms === null ? null : Number(i.duration_ms), recordedAt: i.recorded_at?.toISOString() ?? null,
        expectedSha256: i.expected_sha256, verifiedSha256: i.verified_sha256, verifiedSha512: i.verified_sha512, verifiedOk: i.verified_ok, verifiedAt: i.verified_at?.toISOString() ?? null, verifyError: i.verify_error,
      })),
    };
  });

  // ---------------------------------------------------------------------------------------------
  const decisionBody = z.object({ note: z.string().trim().max(2000).optional() }).strict().default({});

  app.post('/:id/approve', {
    preHandler: app.authorize('export:approve'),
    schema: { tags: ['exports'], summary: 'Approve an export (not your own); queues the package build', params: idParams, body: decisionBody },
  }, async (req) => {
    const p = req.requirePrincipal();
    const r = (await baseSelect(app.db).where('x.id', '=', req.params.id).executeTakeFirst()) as ExportRow | undefined;
    if (!r || !hasPermissionAt(p, 'export:approve', r.org_path)) throw notFound('Export');
    const items = await exportItems(app.db, r.id);
    if (r.created_by === p.userId) {
      await auditPerItem(app.db, req.actor(), 'EXPORT_APPROVED', r, items, { reason: 'SEPARATION_OF_DUTIES: approver is the requester' }, 'DENIED');
      throw new AppError(403, 'SEPARATION_OF_DUTIES', 'You cannot approve your own export request');
    }
    if (r.status !== 'PENDING_APPROVAL') throw conflict(`Export is ${r.status}`);
    const hidden: string[] = [];
    for (const it of items) {
      try {
        await loadEvidenceFor(app.db, p, it.evidence_id, null, req.actor());
      } catch (err) {
        if (err instanceof AppError && err.statusCode === 404) hidden.push(it.evidence_id);
        else throw err;
      }
    }
    if (hidden.length) {
      await auditPerItem(app.db, req.actor(), 'EXPORT_APPROVED', r, items, { reason: 'APPROVER_CANNOT_SEE_ITEMS', hiddenItems: hidden.length }, 'DENIED');
      throw new AppError(403, 'ITEMS_NOT_VISIBLE', `You cannot approve this export: ${hidden.length} item(s) are outside your jurisdiction`);
    }
    await app.db.transaction().execute(async (tx) => {
      const upd = await tx.updateTable('exports').set({ status: 'APPROVED', approved_by: p.userId, approved_at: new Date(), decision_note: req.body?.note ?? null }).where('id', '=', r.id).where('status', '=', 'PENDING_APPROVAL').executeTakeFirst();
      if (!upd.numUpdatedRows) throw conflict('Export was decided concurrently');
      await auditPerItem(tx, req.actor(), 'EXPORT_APPROVED', r, items, { note: req.body?.note ?? null, requestedBy: r.created_by });
    });
    await enqueue<ExportBuildPayload>(QUEUES.EXPORT_BUILD, { exportId: r.id }, { singletonKey: r.id });
    return exportDto(p, await loadExport(p, r.id));
  });

  app.post('/:id/reject', {
    preHandler: app.authorize('export:approve'),
    schema: { tags: ['exports'], summary: 'Reject an export request (reason required)', params: idParams, body: z.object({ note: z.string().trim().min(5).max(2000) }).strict() },
  }, async (req) => {
    const p = req.requirePrincipal();
    const r = (await baseSelect(app.db).where('x.id', '=', req.params.id).executeTakeFirst()) as ExportRow | undefined;
    if (!r || !hasPermissionAt(p, 'export:approve', r.org_path)) throw notFound('Export');
    if (r.created_by === p.userId) throw new AppError(403, 'SEPARATION_OF_DUTIES', 'You cannot decide your own export request');
    if (r.status !== 'PENDING_APPROVAL') throw conflict(`Export is ${r.status}`);
    const items = await exportItems(app.db, r.id);
    await app.db.transaction().execute(async (tx) => {
      const upd = await tx.updateTable('exports').set({ status: 'REJECTED', approved_by: p.userId, approved_at: new Date(), decision_note: req.body.note }).where('id', '=', r.id).where('status', '=', 'PENDING_APPROVAL').executeTakeFirst();
      if (!upd.numUpdatedRows) throw conflict('Export was decided concurrently');
      await auditPerItem(tx, req.actor(), 'EXPORT_REJECTED', r, items, { note: req.body.note });
    });
    return exportDto(p, await loadExport(p, r.id));
  });

  app.post('/:id/revoke', {
    preHandler: anyOf('export:create', 'export:approve'),
    schema: { tags: ['exports'], summary: 'Revoke an export; the package is deleted and can no longer be downloaded', params: idParams, body: z.object({ reason: z.string().trim().min(5).max(2000) }).strict() },
  }, async (req) => {
    const p = req.requirePrincipal();
    const r = await loadExport(p, req.params.id);
    if (!canRevoke(p, r)) throw r.status === 'REVOKED' || r.status === 'EXPIRED' || r.status === 'REJECTED' ? conflict(`Export is ${r.status}`) : forbidden();
    const items = await exportItems(app.db, r.id);
    await app.db.transaction().execute(async (tx) => {
      await tx.updateTable('exports').set({ status: 'REVOKED', revoked_by: p.userId, revoked_at: new Date(), revoke_reason: req.body.reason }).where('id', '=', r.id).execute();
      await auditPerItem(tx, req.actor(), 'EXPORT_REVOKED', r, items, { reason: req.body.reason, previousStatus: r.status, packageDeleted: !!r.object_key });
    });
    if (r.bucket && r.object_key) await app.storage.delete(r.bucket, r.object_key).catch((err) => req.log.warn({ err }, 'could not delete revoked export package'));
    return exportDto(p, await loadExport(p, r.id));
  });

  // ---------------------------------------------------------------------------------------------
  app.get('/:id/download', {
    preHandler: app.authorize('export:download'),
    schema: { tags: ['exports'], summary: 'Short-lived tokenised download URL for a READY export package', params: idParams },
  }, async (req) => {
    const p = req.requirePrincipal();
    const r = await loadExport(p, req.params.id);
    if (r.status !== 'READY' || !r.object_key) throw conflict(`Export is ${r.status}`);
    if (!r.expires_at || r.expires_at <= new Date()) throw new AppError(410, 'GONE', 'Export package has expired');
    const token = issueUserToken(p, r.id, 'export', { ttlSeconds: EXPORT_DOWNLOAD_TTL_SECONDS, ref: r.id });
    return { url: `/api/v1/exports/${r.id}/package?t=${encodeURIComponent(token)}`, expiresAt: tokenExpiry(token), filename: `${r.export_number}.zip`, sha256: r.sha256, sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes) };
  });

  app.get('/:id/package', {
    config: { public: true },
    schema: { tags: ['exports'], summary: 'Stream the export package (media token, custody audited)', params: idParams, querystring: z.object({ t: z.string().min(10).max(4096).optional() }) },
  }, async (req, reply) => {
    const auth = await authenticateMediaToken(app.db, req, req.query.t, { evidenceId: req.params.id, scope: 'export', ref: req.params.id });
    if (auth.claims.typ !== 'USER') throw new AppError(403, 'TOKEN_SCOPE', 'Media token not valid for this resource');
    const r = (await baseSelect(app.db).where('x.id', '=', req.params.id).executeTakeFirst()) as ExportRow | undefined;
    if (!r || r.status !== 'READY' || !r.bucket || !r.object_key || !r.expires_at || r.expires_at <= new Date()) throw notFound('Export');
    const range = req.headers.range;
    if (!range || /^bytes=0-/.test(range.trim())) {
      const items = await exportItems(app.db, r.id);
      await app.db.transaction().execute(async (tx) => {
        await tx.updateTable('exports').set((eb) => ({ download_count: eb('download_count', '+', 1) })).where('id', '=', r.id).execute();
        await auditPerItem(tx, auth.actor, 'EXPORT_DOWNLOADED', r, items, { packageSha256: r.sha256, sizeBytes: r.size_bytes, range: range ?? null });
      });
    }
    return sendObject(app.storage, req, reply, { bucket: r.bucket, key: r.object_key, contentType: 'application/zip' }, {
      'Content-Disposition': `attachment; filename="${r.export_number}.zip"`,
      'X-Package-SHA256': r.sha256 ?? '',
    });
  });

  // ---------------------------------------------------------------------------------------------
  app.post('/verify', {
    preHandler: anyOf('export:create', 'export:approve', 'export:download', 'audit:verify'),
    config: { rateLimit: { max: app.cfg.NODE_ENV === 'test' ? 10_000 : 10, timeWindow: '1 minute' } },
    bodyLimit: MAX_VERIFY_BYTES + 1024,
    schema: { tags: ['exports'], summary: 'Verify an export package (octet-stream ZIP body) or a {manifest, signature} pair' },
  }, async (req) => {
    let report;
    if (Buffer.isBuffer(req.body)) {
      if (req.body.length > MAX_VERIFY_BYTES) throw new AppError(413, 'TOO_LARGE', 'Package too large for online verification; verify offline with VERIFY.txt');
      let zip;
      try {
        zip = await readZip(req.body);
      } catch (err) {
        throw badRequest(`Not a readable ZIP package: ${(err as Error).message}`);
      }
      if (!zip.manifest || !zip.signature) throw badRequest('Package does not contain manifest.json and manifest.sig');
      report = await verifyExport(app.db, { manifest: zip.manifest, signature: zip.signature, certificate: zip.certificate, zip });
    } else {
      const parsed = z.object({ manifest: z.string().min(2).max(20_000_000), signature: z.string().min(16).max(20_000) }).safeParse(req.body);
      if (!parsed.success) throw badRequest('Provide a ZIP (application/octet-stream) or JSON {manifest, signature (base64)}');
      report = await verifyExport(app.db, { manifest: Buffer.from(parsed.data.manifest, 'utf8'), signature: Buffer.from(parsed.data.signature, 'base64') });
    }
    await appendAudit(app.db, req.actor(), { action: 'EXPORT_VERIFIED', outcome: report.ok ? 'SUCCESS' : 'FAILURE', resourceType: 'export', resourceId: report.export?.exportNumber ?? undefined, details: { signatureValid: report.signatureValid, manifestSha256: report.manifestSha256, known: report.export?.known ?? false, problems: report.problems.slice(0, 20), mode: report.files ? 'package' : 'manifest' } });
    return report;
  });
}
