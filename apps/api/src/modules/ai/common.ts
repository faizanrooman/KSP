/** Shared helpers for the AI (/ai) and review (/review) modules. */
import type { FastifyRequest } from 'fastify';
import { sql, type SelectQueryBuilder } from 'kysely';
import { appendAudit, type Database, type Tx } from '@ksp/core';
import { AI_JOBS_CHANNEL, type AiDetectionDto, type AiJobDto, type AiModelDto, type AiTask, type Permission, type ReviewStatus } from '@ksp/shared';
import { loadEvidenceFor, type EvidenceAccessRow } from '../../lib/access.js';
import { AppError, forbidden } from '../../lib/errors.js';
import { hasPermission, type Principal } from '../../lib/principal.js';
import { IMAGE_TOKEN_TTL_SECONDS, issueUserToken } from '../media/tokens.js';
import { API_PREFIX } from '@ksp/shared';

export const AI_READ_PERMS: Permission[] = ['ai:request', 'ai:review'];

/** preHandler: ANY of the listed permissions (app.authorize requires ALL). */
export function anyOf(...perms: Permission[]) {
  return async (req: FastifyRequest) => {
    const p = req.requirePrincipal();
    if (perms.some((perm) => hasPermission(p, perm))) return;
    await appendAudit(req.server.db, req.actor(), {
      action: 'ACCESS_DENIED', outcome: 'DENIED', resourceType: 'route', resourceId: `${req.method} ${req.routeOptions.url}`, details: { anyOf: perms },
    });
    throw forbidden();
  };
}

/**
 * Evidence the caller may see AND for which it holds ai:review or ai:request (jurisdiction or relationship based).
 * Not visible -> 404; visible without either permission -> 403 (+ EVIDENCE_ACCESS_DENIED).
 */
export async function loadEvidenceForAi(db: Database | Tx, req: FastifyRequest, evidenceId: string, prefer?: Permission): Promise<EvidenceAccessRow> {
  const p = req.requirePrincipal();
  const order: Permission[] = prefer ? [prefer] : AI_READ_PERMS.filter((x) => hasPermission(p, x));
  if (!order.length) order.push('ai:request');
  let last: unknown;
  for (const perm of order) {
    try {
      return await loadEvidenceFor(db, p, evidenceId, perm, req.actor());
    } catch (err) {
      last = err;
      if (!(err instanceof AppError) || err.statusCode !== 403) throw err;
    }
  }
  throw last;
}

export async function notifyAiWorker(db: Database | Tx, payload: string): Promise<void> {
  await sql`SELECT pg_notify(${AI_JOBS_CHANNEL}, ${payload})`.execute(db);
}

export function cropUrl(p: Principal, evidenceId: string, detectionId: string, hasCrop: boolean): string | null {
  if (!hasCrop || !p.userId || !p.sessionId) return null;
  const t = issueUserToken(p, evidenceId, 'image', { ref: `ai:${detectionId}`, ttlSeconds: IMAGE_TOKEN_TTL_SECONDS });
  return `${API_PREFIX}/ai/crops/${detectionId}?t=${encodeURIComponent(t)}`;
}

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function modelDto(m: any): AiModelDto {
  return {
    id: m.id, code: m.code, name: m.name, task: m.task, version: m.version, runtime: m.runtime, artifactSha256: m.artifact_sha256,
    labels: m.labels ?? [], defaultThreshold: Number(m.default_threshold), config: m.config ?? {}, metrics: m.metrics ?? {}, status: m.status,
    notes: m.notes, createdAt: iso(m.created_at)!, activatedAt: iso(m.activated_at), retiredAt: iso(m.retired_at),
  };
}

export interface JobRow {
  id: string; evidence_id: string; tasks: string[]; status: string; progress: number; params: unknown; model_ids: string[]; stats: unknown;
  error: string | null; created_at: Date; started_at: Date | null; finished_at: Date | null; requested_by: string; requester_name: string;
}

export async function jobDtos(db: Database, rows: JobRow[]): Promise<AiJobDto[]> {
  const ids = [...new Set(rows.flatMap((r) => r.model_ids))];
  const models = ids.length ? await db.selectFrom('ai_models').select(['id', 'code', 'version', 'task']).where('id', 'in', ids).execute() : [];
  const byId = new Map(models.map((m) => [m.id, m]));
  return rows.map((r) => ({
    id: r.id, evidenceId: r.evidence_id, tasks: r.tasks as AiTask[], status: r.status as AiJobDto['status'], progress: Number(r.progress),
    params: r.params as AiJobDto['params'],
    models: r.model_ids.map((id) => byId.get(id)).filter((m): m is NonNullable<typeof m> => !!m).map((m) => ({ id: m.id, code: m.code, version: m.version, task: m.task as AiTask })),
    stats: r.stats as AiJobDto['stats'], error: r.error, requestedBy: { id: r.requested_by, fullName: r.requester_name },
    createdAt: iso(r.created_at)!, startedAt: iso(r.started_at), finishedAt: iso(r.finished_at),
  }));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function jobQuery(db: Database): SelectQueryBuilder<any, any, any> {
  return db
    .selectFrom('ai_jobs as j')
    .innerJoin('users as u', 'u.id', 'j.requested_by')
    .select(['j.id', 'j.evidence_id', 'j.tasks', 'j.status', 'j.progress', 'j.params', 'j.model_ids', 'j.stats', 'j.error', 'j.created_at', 'j.started_at', 'j.finished_at', 'j.requested_by', 'u.full_name as requester_name']);
}

/** Detection columns for DTO mapping (joined with evidence as e and reviewer as ru). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function detectionQuery(db: Database): SelectQueryBuilder<any, any, any> {
  return db
    .selectFrom('ai_detections as d')
    .innerJoin('evidence as e', 'e.id', 'd.evidence_id')
    .leftJoin('users as ru', 'ru.id', 'd.reviewed_by')
    .select([
      'd.id', 'd.job_id', 'd.evidence_id', 'e.evidence_number', 'd.task', 'd.label', 'd.corrected_label', 'd.confidence', 'd.threshold',
      'd.model_id', 'd.model_code', 'd.model_version', 'd.frame_time_ms', 'd.frame_number', 'd.bbox_x', 'd.bbox_y', 'd.bbox_w', 'd.bbox_h',
      'd.track_id', 'd.attributes', 'd.crop_key', 'd.review_status', 'd.reviewed_by', 'ru.full_name as reviewer_name', 'd.reviewed_at',
      'd.review_comment', 'd.created_at',
      sql<number>`(SELECT count(*)::int FROM ai_review_events re WHERE re.detection_id = d.id AND re.action = 'APPROVE')`.as('approvals'),
    ]);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function detectionDto(p: Principal, r: any): AiDetectionDto {
  return {
    id: r.id, jobId: r.job_id, evidenceId: r.evidence_id, evidenceNumber: r.evidence_number, task: r.task, label: r.label, correctedLabel: r.corrected_label,
    confidence: Number(r.confidence), threshold: Number(r.threshold), model: { id: r.model_id, code: r.model_code, version: r.model_version },
    frameTimeMs: Number(r.frame_time_ms), frameNumber: r.frame_number === null ? null : Number(r.frame_number),
    bbox: r.bbox_x === null ? null : { x: Number(r.bbox_x), y: Number(r.bbox_y), w: Number(r.bbox_w), h: Number(r.bbox_h) },
    trackId: r.track_id, attributes: publicAttributes(r.attributes ?? {}), cropUrl: cropUrl(p, r.evidence_id, r.id, !!r.crop_key),
    reviewStatus: r.review_status as ReviewStatus, reviewedBy: r.reviewed_by ? { id: r.reviewed_by, fullName: r.reviewer_name } : null,
    reviewedAt: iso(r.reviewed_at), reviewComment: r.review_comment, approvals: Number(r.approvals ?? 0), createdAt: iso(r.created_at)!,
  };
}

/** Attributes safe to show (no internal ids beyond watchlist references). */
function publicAttributes(a: Record<string, unknown>): Record<string, unknown> {
  const { cocoClass: _c, sampleIndex: _s, ...rest } = a;
  return rest;
}

/** Evidence audit throttle for passive result views (per API instance). */
const viewSeen = new Map<string, number>();
export async function auditResultsViewed(db: Database, req: FastifyRequest, ev: EvidenceAccessRow, details: Record<string, unknown>): Promise<void> {
  const p = req.requirePrincipal();
  const key = `${p.userId ?? p.apiClientId}:${ev.id}`;
  const now = Date.now();
  if ((viewSeen.get(key) ?? 0) > now - 10 * 60_000) return;
  await appendAudit(db, req.actor(), { action: 'AI_RESULTS_VIEWED', resourceType: 'evidence', resourceId: ev.id, evidenceId: ev.id, orgUnitId: ev.org_unit_id, details: { ...details, throttleMinutes: 10 } });
  viewSeen.set(key, now);
  if (viewSeen.size > 10_000) viewSeen.clear();
}
