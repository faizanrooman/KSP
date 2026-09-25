/**
 * External integration REST API (spec module 16: REST APIs for video search and retrieval).
 *
 * Auth: API clients via HTTP Basic `client_id:secret` (scopes + org-unit jurisdiction, IP allow-list, expiry);
 * also usable by signed-in users. Every call is audited (INTEGRATION_API_REQUEST, fail-closed) and API clients
 * are rate limited per client (api_clients.rate_limit_per_minute, fixed one-minute windows in Postgres).
 * Responses never contain storage locations; downloads use short-lived media tokens.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';
import { appendAudit, signMediaToken } from '@ksp/core';
import { API_PREFIX } from '@ksp/shared';
import { evidenceVisibleSql, loadEvidenceFor } from '../../lib/access.js';
import { conflict, notFound, tooMany } from '../../lib/errors.js';
import type { Principal } from '../../lib/principal.js';
import { caseVisibleSql } from '../cases/access.js';
import { DOWNLOAD_TOKEN_TTL_SECONDS, issueUserToken, tokenExpiry } from '../media/tokens.js';

export const prefix = '/integration';

export const API_CLIENT_DOWNLOAD_TTL_SECONDS = 300;
const DOWNLOADABLE = ['REGISTERED', 'DISPOSAL_PENDING'];
const safeFilename = (v: string) => v.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 180) || 'evidence';

const searchQuery = z.object({
  firStation: z.string().trim().max(40).optional().describe('Station org-unit code of the FIR (with firYear + firNumber)'),
  firYear: z.coerce.number().int().min(1950).max(2200).optional(),
  firNumber: z.string().trim().max(40).optional(),
  caseNumber: z.string().trim().max(60).optional(),
  station: z.string().trim().max(40).optional().describe('Org-unit code; includes sub-units'),
  officerBadge: z.string().trim().max(60).optional(),
  deviceSerial: z.string().trim().max(100).optional(),
  evidenceNumber: z.string().trim().max(60).optional(),
  recordedFrom: z.coerce.date().optional(),
  recordedTo: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

interface EvRow {
  id: string; evidence_number: string | null; title: string | null; category: string | null; status: string; recorded_at: Date | null; recorded_end_at: Date | null;
  duration_ms: number | null; size_bytes: number | null; mime_type: string | null; sha256: string | null; sha512: string | null; width: number | null; height: number | null;
  registered_at: Date | null; legal_hold: boolean; gps_latitude: number | null; gps_longitude: number | null; org_code: string; org_name: string;
  off_badge: string | null; off_name: string | null; dev_serial: string | null;
}

function evidenceDto(r: EvRow, cases: Array<{ case_number: string; title: string; status: string }> = []) {
  return {
    id: r.id,
    evidenceNumber: r.evidence_number,
    title: r.title,
    category: r.category,
    status: r.status,
    station: { code: r.org_code, name: r.org_name },
    officer: r.off_badge || r.off_name ? { badgeNumber: r.off_badge, fullName: r.off_name } : null,
    deviceSerial: r.dev_serial,
    recordedAt: r.recorded_at,
    recordedEndAt: r.recorded_end_at,
    durationMs: r.duration_ms,
    sizeBytes: r.size_bytes,
    mimeType: r.mime_type,
    width: r.width,
    height: r.height,
    gps: r.gps_latitude !== null && r.gps_longitude !== null ? { latitude: r.gps_latitude, longitude: r.gps_longitude } : null,
    hashes: { sha256: r.sha256, sha512: r.sha512 },
    registeredAt: r.registered_at,
    legalHold: r.legal_hold,
    cases: cases.map((c) => ({ caseNumber: c.case_number, title: c.title, status: c.status })),
  };
}

function evidenceQuery(app: FastifyInstance, p: Principal) {
  return app.db
    .selectFrom('evidence as e')
    .innerJoin('org_units as o', 'o.id', 'e.org_unit_id')
    .leftJoin('users as off', 'off.id', 'e.officer_id')
    .leftJoin('devices as d', 'd.id', 'e.device_id')
    .where(evidenceVisibleSql(p, 'e'))
    .select([
      'e.id', 'e.evidence_number', 'e.title', 'e.category', 'e.status', 'e.recorded_at', 'e.recorded_end_at', 'e.duration_ms', 'e.size_bytes', 'e.mime_type', 'e.sha256',
      'e.sha512', 'e.width', 'e.height', 'e.registered_at', 'e.legal_hold', 'e.gps_latitude', 'e.gps_longitude', 'o.code as org_code', 'o.name as org_name',
      'off.badge_number as off_badge', 'off.full_name as off_name', 'd.serial_number as dev_serial',
    ]);
}

/** Linked cases of an evidence item, limited to cases the principal may see. */
async function visibleCases(app: FastifyInstance, p: Principal, evidenceIds: string[]) {
  if (!evidenceIds.length) return new Map<string, Array<{ case_number: string; title: string; status: string }>>();
  const rows = await app.db
    .selectFrom('case_evidence as ce')
    .innerJoin('cases as c', 'c.id', 'ce.case_id')
    .select(['ce.evidence_id', 'c.case_number', 'c.title', 'c.status'])
    .where('ce.evidence_id', 'in', evidenceIds)
    .where('ce.unlinked_at', 'is', null)
    .where(caseVisibleSql(p, 'c'))
    .execute();
  const m = new Map<string, Array<{ case_number: string; title: string; status: string }>>();
  for (const r of rows) m.set(r.evidence_id, [...(m.get(r.evidence_id) ?? []), r]);
  return m;
}

/** Per-API-client fixed-window rate limit (shared across instances via Postgres). */
async function rateLimit(app: FastifyInstance, req: FastifyRequest, p: Principal) {
  if (p.kind !== 'API_CLIENT' || !p.apiClientId) return;
  const row = await sql<{ count: number; lim: number }>`
    WITH w AS (
      INSERT INTO api_client_rate_windows (api_client_id, window_start, count)
      VALUES (${p.apiClientId}::uuid, date_trunc('minute', now()), 1)
      ON CONFLICT (api_client_id, window_start) DO UPDATE SET count = api_client_rate_windows.count + 1
      RETURNING count)
    SELECT w.count, c.rate_limit_per_minute AS lim FROM w, api_clients c WHERE c.id = ${p.apiClientId}::uuid`.execute(app.db);
  const r = row.rows[0];
  if (r && r.count > r.lim) {
    if (r.count === r.lim + 1) {
      await appendAudit(app.db, req.actor(), { action: 'RATE_LIMITED', outcome: 'DENIED', resourceType: 'api_client', resourceId: p.apiClientId, details: { limitPerMinute: r.lim, route: req.routeOptions.url } });
    }
    throw tooMany(`API client rate limit of ${r.lim} requests/minute exceeded`);
  }
  // Opportunistic cleanup of old windows for this client.
  if (Math.random() < 0.02) await sql`DELETE FROM api_client_rate_windows WHERE api_client_id = ${p.apiClientId}::uuid AND window_start < now() - interval '1 hour'`.execute(app.db);
}

export default async function integrationApi(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // Every request: per-client rate limit, then a fail-closed audit record of the call.
  app.addHook('preHandler', async (req) => {
    const p = req.requirePrincipal();
    await rateLimit(app, req, p);
    const query = Object.fromEntries(Object.entries((req.query ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v).slice(0, 100)]));
    await appendAudit(app.db, req.actor(), {
      action: 'INTEGRATION_API_REQUEST', resourceType: 'integration_api', resourceId: `${req.method} ${req.routeOptions.url}`, orgUnitId: p.homeOrgUnitId,
      details: { params: req.params ?? {}, query, principalKind: p.kind },
    });
  });

  app.get('/evidence', {
    preHandler: app.authorize('evidence:read'),
    schema: { tags: ['integration'], summary: 'Search evidence (by FIR, case number, station, officer badge, device serial, date range, evidence number)', querystring: searchQuery },
  }, async (req) => {
    const p = req.requirePrincipal();
    const f = req.query;
    let q = evidenceQuery(app, p);
    if (f.firStation || f.firYear || f.firNumber) {
      q = q.where(sql<boolean>`EXISTS (SELECT 1 FROM case_evidence ce JOIN cases c ON c.id = ce.case_id JOIN firs fr ON fr.id = c.fir_id JOIN org_units fo ON fo.id = fr.org_unit_id
        WHERE ce.evidence_id = e.id AND ce.unlinked_at IS NULL
          AND (${f.firStation ?? null}::text IS NULL OR fo.code = ${f.firStation ?? null})
          AND (${f.firYear ?? null}::int IS NULL OR fr.fir_year = ${f.firYear ?? null})
          AND (${f.firNumber ?? null}::text IS NULL OR ltrim(fr.fir_number, '0') = ltrim(${f.firNumber ?? null}, '0')))`);
    }
    if (f.caseNumber) q = q.where(sql<boolean>`EXISTS (SELECT 1 FROM case_evidence ce JOIN cases c ON c.id = ce.case_id WHERE ce.evidence_id = e.id AND ce.unlinked_at IS NULL AND c.case_number = ${f.caseNumber})`);
    if (f.station) q = q.where(sql<boolean>`e.org_path <@ (SELECT path FROM org_units WHERE code = ${f.station})`);
    if (f.officerBadge) q = q.where('off.badge_number', '=', f.officerBadge);
    if (f.deviceSerial) q = q.where(sql<boolean>`lower(d.serial_number) = lower(${f.deviceSerial})`);
    if (f.evidenceNumber) q = q.where('e.evidence_number', '=', f.evidenceNumber);
    if (f.recordedFrom) q = q.where('e.recorded_at', '>=', f.recordedFrom);
    if (f.recordedTo) q = q.where('e.recorded_at', '<=', f.recordedTo);
    q = q.where('e.status', 'in', ['REGISTERED', 'DISPOSAL_PENDING']);
    const rows = await q
      .select(sql<number>`count(*) OVER ()`.as('total'))
      .orderBy('e.recorded_at', 'desc')
      .orderBy('e.id')
      .limit(f.pageSize)
      .offset((f.page - 1) * f.pageSize)
      .execute();
    const cases = await visibleCases(app, p, rows.map((r) => r.id));
    return { items: rows.map((r) => evidenceDto(r, cases.get(r.id))), total: Number(rows[0]?.total ?? 0), page: f.page, pageSize: f.pageSize };
  });

  app.get('/evidence/:id', {
    preHandler: app.authorize('evidence:read'),
    schema: { tags: ['integration'], summary: 'Evidence metadata and hashes (custody audited)', params: z.object({ id: z.string().uuid() }) },
  }, async (req) => {
    const p = req.requirePrincipal();
    const ev = await loadEvidenceFor(app.db, p, req.params.id, 'evidence:read', req.actor());
    const r = await evidenceQuery(app, p).where('e.id', '=', ev.id).executeTakeFirstOrThrow();
    await appendAudit(app.db, req.actor(), { action: 'EVIDENCE_VIEWED', resourceType: 'evidence', resourceId: ev.id, evidenceId: ev.id, orgUnitId: ev.org_unit_id, details: { via: 'integration_api' } });
    const cases = await visibleCases(app, p, [ev.id]);
    return evidenceDto(r, cases.get(ev.id));
  });

  app.get('/evidence/:id/download', {
    preHandler: app.authorize('evidence:read', 'evidence:download_original'),
    schema: { tags: ['integration'], summary: 'Short-lived tokenised download URL for the original (GET it within the TTL; the download itself is custody audited)', params: z.object({ id: z.string().uuid() }) },
  }, async (req) => {
    const p = req.requirePrincipal();
    const ev = await loadEvidenceFor(app.db, p, req.params.id, 'evidence:download_original', req.actor());
    const row = await app.db.selectFrom('evidence').select(['status', 'storage_key', 'sha256', 'size_bytes', 'original_filename', 'evidence_number']).where('id', '=', ev.id).executeTakeFirstOrThrow();
    if (!DOWNLOADABLE.includes(row.status) || !row.storage_key) throw conflict('The original is not available for download');
    const token = p.kind === 'API_CLIENT'
      ? signMediaToken({ typ: 'API_CLIENT', sub: p.apiClientId!, eid: ev.id, scope: 'download', ttlSeconds: API_CLIENT_DOWNLOAD_TTL_SECONDS })
      : issueUserToken(p, ev.id, 'download', { ttlSeconds: DOWNLOAD_TOKEN_TTL_SECONDS });
    const expiresAt = tokenExpiry(token);
    await appendAudit(app.db, req.actor(), { action: 'EVIDENCE_DOWNLOAD_LINK_ISSUED', resourceType: 'evidence', resourceId: ev.id, evidenceId: ev.id, orgUnitId: ev.org_unit_id, details: { via: 'integration_api', expiresAt } });
    return {
      url: `${API_PREFIX}/media/download/${ev.id}?t=${encodeURIComponent(token)}`,
      expiresAt,
      filename: safeFilename(`${row.evidence_number ?? ev.id}_${row.original_filename}`),
      sha256: row.sha256,
      sizeBytes: Number(row.size_bytes),
    };
  });

  app.get('/cases/:caseNumber', {
    preHandler: app.authorize('cases:read'),
    schema: { tags: ['integration'], summary: 'Case summary by case number, with FIR and linked evidence visible to the caller', params: z.object({ caseNumber: z.string().trim().min(3).max(60) }) },
  }, async (req) => {
    const p = req.requirePrincipal();
    const c = await app.db
      .selectFrom('cases as c')
      .innerJoin('org_units as o', 'o.id', 'c.org_unit_id')
      .leftJoin('firs as f', 'f.id', 'c.fir_id')
      .leftJoin('users as io', 'io.id', 'c.investigating_officer_id')
      .select(['c.id', 'c.case_number', 'c.title', 'c.status', 'c.priority', 'c.opened_at', 'c.closed_at', 'c.court_name', 'c.court_case_number', 'c.external_ref',
        'o.code as org_code', 'o.name as org_name', 'f.fir_number', 'f.fir_year', 'f.acts_sections', 'f.registered_at as fir_registered_at', 'io.full_name as io_name', 'io.badge_number as io_badge'])
      .where('c.case_number', '=', req.params.caseNumber)
      .where(caseVisibleSql(p, 'c'))
      .executeTakeFirst();
    if (!c) throw notFound('Case');
    const links = await app.db
      .selectFrom('case_evidence as ce')
      .innerJoin('evidence as e', 'e.id', 'ce.evidence_id')
      .select(['e.id', 'e.evidence_number', 'e.title', 'e.sha256', 'e.recorded_at', 'e.duration_ms', 'ce.linked_at'])
      .where('ce.case_id', '=', c.id)
      .where('ce.unlinked_at', 'is', null)
      .where(evidenceVisibleSql(p, 'e'))
      .orderBy('ce.linked_at')
      .execute();
    const total = await app.db.selectFrom('case_evidence').select(sql<number>`count(*)::int`.as('n')).where('case_id', '=', c.id).where('unlinked_at', 'is', null).executeTakeFirstOrThrow();
    return {
      caseNumber: c.case_number,
      title: c.title,
      status: c.status,
      priority: c.priority,
      station: { code: c.org_code, name: c.org_name },
      fir: c.fir_number ? { firNumber: c.fir_number, firYear: c.fir_year, actsSections: c.acts_sections, registeredAt: c.fir_registered_at } : null,
      investigatingOfficer: c.io_name ? { fullName: c.io_name, badgeNumber: c.io_badge } : null,
      court: { name: c.court_name, caseNumber: c.court_case_number },
      externalRef: c.external_ref,
      openedAt: c.opened_at,
      closedAt: c.closed_at,
      evidence: links.map((l) => ({ id: l.id, evidenceNumber: l.evidence_number, title: l.title, sha256: l.sha256, recordedAt: l.recorded_at, durationMs: l.duration_ms, linkedAt: l.linked_at })),
      hiddenEvidenceCount: Number(total.n) - links.length,
    };
  });
}
