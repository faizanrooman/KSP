/**
 * Human review of AI results (spec module 9). No AI output is authoritative until reviewed here.
 *
 *   GET  /review/queue                      PENDING / NEEDS_SECOND_REVIEW detections the reviewer may see
 *   GET  /review/summary                    queue counts by task/status
 *   POST /review/detections/:id             APPROVE | REJECT | REQUEST_SECOND_REVIEW | COMMENT | CORRECT_LABEL
 *   POST /review/detections/bulk            same, per-item results
 *   GET  /review/detections/:id/history     detection + append-only review events
 *
 * Rules: REJECT and COMMENT need a comment; FACE_RECOGNITION matches need two APPROVE actions by different users
 * (first -> NEEDS_SECOND_REVIEW); an item escalated for second review must be approved by someone other than the
 * escalating/approving reviewer; APPROVED / REJECTED are final; approved CLASSIFICATION results become evidence tags
 * (source AI_APPROVED).
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';
import { appendAudit, type AuditActor, type Database } from '@ksp/core';
import { AI_TASKS, DUAL_APPROVAL_TASKS, REVIEW_ACTIONS, type AiTask, type AuditAction, type ReviewAction, type ReviewStatus } from '@ksp/shared';
import { evidenceVisibleSql, loadEvidenceFor, orgScopeSql } from '../../lib/access.js';
import { AppError, conflict, notFound, validationFailed } from '../../lib/errors.js';
import type { Principal } from '../../lib/principal.js';
import { anyOf, detectionDto, detectionQuery, loadEvidenceForAi } from '../ai/common.js';

export const prefix = '/review';

const idParams = z.object({ id: z.string().uuid() });
const TAG_RE = /^[a-z0-9][a-z0-9 _:.-]{0,62}$/;
const csvEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.string().optional().transform((v, ctx) => {
    if (!v) return undefined;
    const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
    for (const x of parts) if (!(values as readonly string[]).includes(x)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid value ${x}` });
    return parts as T[number][];
  });

const actionBody = z.object({
  action: z.enum(REVIEW_ACTIONS),
  comment: z.string().trim().max(2000).optional(),
  correctedLabel: z.string().trim().min(1).max(100).optional(),
}).strict();
type ActionBody = z.infer<typeof actionBody>;

const AUDIT_FOR: Record<ReviewAction, AuditAction> = {
  APPROVE: 'AI_RESULT_APPROVED', REJECT: 'AI_RESULT_REJECTED', REQUEST_SECOND_REVIEW: 'AI_RESULT_ESCALATED',
  COMMENT: 'AI_RESULT_COMMENTED', CORRECT_LABEL: 'AI_RESULT_LABEL_CORRECTED',
};
const OPEN: ReviewStatus[] = ['PENDING', 'NEEDS_SECOND_REVIEW'];

/** Reviewable = visible AND ai:review held for it (jurisdiction grant, or relationship-based visibility). */
function reviewableSql(p: Principal, alias = 'e') {
  return sql<boolean>`(${evidenceVisibleSql(p, alias)} AND (${orgScopeSql(p, 'ai:review', `${alias}.org_path`)} OR ${evidenceVisibleSql(p, alias, { jurisdiction: false })}))`;
}

export interface ReviewResult {
  id: string;
  previousStatus: ReviewStatus;
  status: ReviewStatus;
  tagCreated?: string;
}

/** Apply one review action (own transaction). Throws AppError on rule violations. */
export async function applyReview(db: Database, p: Principal, actor: AuditActor, detectionId: string, body: ActionBody): Promise<ReviewResult> {
  const pre = await db.selectFrom('ai_detections').select(['id', 'evidence_id']).where('id', '=', detectionId).executeTakeFirst();
  if (!pre) throw notFound('Detection');
  const ev = await loadEvidenceFor(db, p, pre.evidence_id, 'ai:review', actor);
  const uid = p.userId;
  if (!uid) throw new AppError(403, 'FORBIDDEN', 'Reviews require an interactive user');
  const comment = body.comment?.trim() || null;
  if ((body.action === 'REJECT' || body.action === 'COMMENT') && (!comment || comment.length < 3)) throw validationFailed(`${body.action} requires a comment (at least 3 characters)`);
  if (body.action === 'CORRECT_LABEL' && !body.correctedLabel) throw validationFailed('CORRECT_LABEL requires correctedLabel');

  return db.transaction().execute(async (tx) => {
    const d = await tx.selectFrom('ai_detections').selectAll().where('id', '=', detectionId).forUpdate().executeTakeFirstOrThrow();
    const prev = d.review_status as ReviewStatus;
    const task = d.task as AiTask;
    const events = await tx.selectFrom('ai_review_events').select(['reviewer_id', 'action']).where('detection_id', '=', d.id).execute();
    const final = prev === 'APPROVED' || prev === 'REJECTED';
    let next: ReviewStatus = prev;
    let corrected = d.corrected_label;

    switch (body.action) {
      case 'APPROVE': {
        if (final) throw conflict(`Detection is already ${prev}`);
        const approvers = new Set(events.filter((e) => e.action === 'APPROVE').map((e) => e.reviewer_id));
        const escalators = new Set(events.filter((e) => e.action === 'REQUEST_SECOND_REVIEW').map((e) => e.reviewer_id));
        if (approvers.has(uid) || (prev === 'NEEDS_SECOND_REVIEW' && escalators.has(uid))) {
          throw new AppError(409, 'SECOND_REVIEWER_REQUIRED', 'A different reviewer must provide the second review');
        }
        if (DUAL_APPROVAL_TASKS.includes(task)) next = approvers.size >= 1 ? 'APPROVED' : 'NEEDS_SECOND_REVIEW';
        else next = 'APPROVED';
        break;
      }
      case 'REJECT':
        if (final) throw conflict(`Detection is already ${prev}`);
        next = 'REJECTED';
        break;
      case 'REQUEST_SECOND_REVIEW':
        if (final) throw conflict(`Detection is already ${prev}`);
        next = 'NEEDS_SECOND_REVIEW';
        break;
      case 'CORRECT_LABEL': {
        if (final) throw conflict(`Detection is already ${prev}; corrections must be made before the final decision`);
        corrected = body.correctedLabel!.trim();
        if (task === 'CLASSIFICATION') {
          corrected = corrected.toLowerCase();
          if (!TAG_RE.test(corrected)) throw validationFailed('Corrected tag must match ^[a-z0-9][a-z0-9 _:.-]{0,62}$');
        }
        break;
      }
      case 'COMMENT':
        break;
    }

    await tx.updateTable('ai_detections').set({
      review_status: next,
      corrected_label: corrected,
      ...(body.action === 'COMMENT' ? { review_comment: comment } : { reviewed_by: uid, reviewed_at: new Date(), review_comment: comment ?? d.review_comment }),
    }).where('id', '=', d.id).execute();
    await tx.insertInto('ai_review_events').values({
      detection_id: d.id, reviewer_id: uid, action: body.action, previous_status: prev, new_status: next, comment,
      corrected_label: body.action === 'CORRECT_LABEL' ? corrected : null, model_id: d.model_id, model_version: d.model_version, confidence: d.confidence,
    }).execute();
    await appendAudit(tx, actor, {
      action: AUDIT_FOR[body.action], resourceType: 'ai_detection', resourceId: d.id, evidenceId: ev.id, orgUnitId: ev.org_unit_id,
      details: {
        task, label: d.label, correctedLabel: body.action === 'CORRECT_LABEL' ? corrected : undefined, previousStatus: prev, newStatus: next,
        model: `${d.model_code}@${d.model_version}`, confidence: d.confidence, threshold: d.threshold, frameTimeMs: Number(d.frame_time_ms),
        dualApproval: DUAL_APPROVAL_TASKS.includes(task) || undefined,
      },
    });
    let tagCreated: string | undefined;
    if (next === 'APPROVED' && task === 'CLASSIFICATION') {
      const tag = (corrected ?? d.label).toLowerCase();
      if (TAG_RE.test(tag)) {
        const ins = await tx.insertInto('evidence_tags').values({ evidence_id: ev.id, tag, source: 'AI_APPROVED', created_by: uid })
          .onConflict((oc) => oc.columns(['evidence_id', 'tag']).doNothing()).returning('tag').executeTakeFirst();
        if (ins) {
          tagCreated = tag;
          await appendAudit(tx, actor, { action: 'EVIDENCE_TAGGED', resourceType: 'evidence', resourceId: ev.id, evidenceId: ev.id, orgUnitId: ev.org_unit_id, details: { added: [tag], source: 'AI_APPROVED', detectionId: d.id } });
        }
      }
    }
    return { id: d.id, previousStatus: prev, status: next, tagCreated };
  });
}

export default async function review(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const guard = app.authorize('ai:review');

  const approvedByMe = (uid: string | null) =>
    sql<boolean>`EXISTS (SELECT 1 FROM ai_review_events re WHERE re.detection_id = d.id AND re.reviewer_id = ${uid ?? '00000000-0000-0000-0000-000000000000'}::uuid AND re.action IN ('APPROVE','REQUEST_SECOND_REVIEW'))`;

  app.get('/queue', {
    preHandler: guard,
    schema: {
      tags: ['review'], summary: 'Review queue (AI results awaiting a human decision)',
      querystring: z.object({
        task: csvEnum(AI_TASKS), status: csvEnum(['PENDING', 'NEEDS_SECOND_REVIEW'] as const), label: z.string().trim().max(100).optional(),
        minConfidence: z.coerce.number().min(0).max(1).optional(), maxConfidence: z.coerce.number().min(0).max(1).optional(),
        evidenceId: z.string().uuid().optional(), orgUnitId: z.string().uuid().optional(), jobId: z.string().uuid().optional(),
        sort: z.enum(['confidence', '-confidence', 'created_at', '-created_at', 'frame_time']).default('-confidence'),
        page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(25),
      }),
    },
  }, async (req) => {
    const p = req.requirePrincipal();
    const q = req.query;
    let base = detectionQuery(app.db).select(approvedByMe(p.userId).as('reviewed_by_me'))
      .where(reviewableSql(p, 'e'))
      .where('d.review_status', 'in', q.status ?? OPEN)
      .where('e.status', '<>', 'DISPOSED');
    if (q.task) base = base.where('d.task', 'in', q.task);
    if (q.label) base = base.where(sql<boolean>`(lower(d.label) LIKE ${`%${q.label.toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%`} OR lower(d.corrected_label) = lower(${q.label}))`);
    if (q.minConfidence !== undefined) base = base.where('d.confidence', '>=', q.minConfidence);
    if (q.maxConfidence !== undefined) base = base.where('d.confidence', '<=', q.maxConfidence);
    if (q.evidenceId) base = base.where('d.evidence_id', '=', q.evidenceId);
    if (q.jobId) base = base.where('d.job_id', '=', q.jobId);
    if (q.orgUnitId) base = base.where(sql<boolean>`e.org_path <@ (SELECT path FROM org_units WHERE id = ${q.orgUnitId}::uuid)`);
    const total = await base.clearSelect().select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow();
    const desc = q.sort.startsWith('-');
    const col = q.sort.replace('-', '');
    let ordered = base;
    if (col === 'confidence') ordered = ordered.orderBy('d.confidence', desc ? 'desc' : 'asc');
    else if (col === 'created_at') ordered = ordered.orderBy('d.created_at', desc ? 'desc' : 'asc');
    else ordered = ordered.orderBy('d.evidence_id').orderBy('d.frame_time_ms');
    const rows = await ordered.orderBy('d.id').limit(q.pageSize).offset((q.page - 1) * q.pageSize).execute();
    return {
      items: rows.map((r) => ({ ...detectionDto(p, r), reviewedByMe: Boolean((r as { reviewed_by_me?: boolean }).reviewed_by_me), dualApproval: DUAL_APPROVAL_TASKS.includes(r.task as AiTask) })),
      total: total.n, page: q.page, pageSize: q.pageSize,
    };
  });

  app.get('/summary', { preHandler: guard, schema: { tags: ['review'], summary: 'Open review items by task and status' } }, async (req) => {
    const p = req.requirePrincipal();
    const rows = await app.db.selectFrom('ai_detections as d').innerJoin('evidence as e', 'e.id', 'd.evidence_id')
      .select(['d.task', 'd.review_status', sql<number>`count(*)::int`.as('n')])
      .where(reviewableSql(p, 'e')).where('d.review_status', 'in', OPEN).where('e.status', '<>', 'DISPOSED')
      .groupBy(['d.task', 'd.review_status']).execute();
    return { items: rows.map((r) => ({ task: r.task, status: r.review_status, count: r.n })), total: rows.reduce((a, r) => a + r.n, 0) };
  });

  app.post('/detections/bulk', {
    preHandler: guard,
    schema: {
      tags: ['review'], summary: 'Apply review actions to several detections (per-item results)',
      body: z.object({ items: z.array(actionBody.extend({ id: z.string().uuid() })).min(1).max(100) }).strict(),
    },
  }, async (req) => {
    const p = req.requirePrincipal();
    const results = [];
    for (const it of req.body.items) {
      try {
        const r = await applyReview(app.db, p, req.actor(), it.id, it);
        results.push({ id: it.id, ok: true, status: r.status, previousStatus: r.previousStatus, tagCreated: r.tagCreated });
      } catch (err) {
        const e = err instanceof AppError ? err : null;
        if (!e) req.log.error({ err }, 'bulk review item failed');
        results.push({ id: it.id, ok: false, error: { code: e?.code ?? 'INTERNAL', message: e?.message ?? 'Internal error', status: e?.statusCode ?? 500 } });
      }
    }
    return { results, succeeded: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
  });

  app.post('/detections/:id', {
    preHandler: guard,
    schema: { tags: ['review'], summary: 'Review one AI detection', params: idParams, body: actionBody },
  }, async (req) => {
    const p = req.requirePrincipal();
    const r = await applyReview(app.db, p, req.actor(), req.params.id, req.body);
    const row = await detectionQuery(app.db).where('d.id', '=', r.id).executeTakeFirstOrThrow();
    return { ...detectionDto(p, row), tagCreated: r.tagCreated ?? null };
  });

  app.get('/detections/:id/history', {
    preHandler: anyOf('ai:review', 'ai:request'),
    schema: { tags: ['review'], summary: 'Detection with its review history', params: idParams },
  }, async (req) => {
    const p = req.requirePrincipal();
    const pre = await app.db.selectFrom('ai_detections').select(['evidence_id']).where('id', '=', req.params.id).executeTakeFirst();
    if (!pre) throw notFound('Detection');
    await loadEvidenceForAi(app.db, req, pre.evidence_id);
    const row = await detectionQuery(app.db).where('d.id', '=', req.params.id).executeTakeFirstOrThrow();
    const events = await app.db.selectFrom('ai_review_events as re').innerJoin('users as u', 'u.id', 're.reviewer_id')
      .select(['re.id', 're.action', 're.previous_status', 're.new_status', 're.comment', 're.corrected_label', 're.reviewer_id', 'u.full_name', 're.model_version', 're.confidence', 're.created_at'])
      .where('re.detection_id', '=', req.params.id).orderBy('re.id').execute();
    return {
      detection: detectionDto(p, row),
      events: events.map((e) => ({
        id: Number(e.id), action: e.action, previousStatus: e.previous_status, newStatus: e.new_status, comment: e.comment, correctedLabel: e.corrected_label,
        reviewer: { id: e.reviewer_id, fullName: e.full_name }, modelVersion: e.model_version, confidence: Number(e.confidence), createdAt: e.created_at.toISOString(),
      })),
    };
  });
}
