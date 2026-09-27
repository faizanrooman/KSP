/**
 * Case team, evidence links, case diary and case timeline (registered inside the /cases prefix).
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';
import { appendAudit } from '@ksp/core';
import { CASE_MEMBER_ROLES, CUSTODY_ACTIONS } from '@ksp/shared';
import { evidenceVisibleSql, loadEvidenceFor } from '../../lib/access.js';
import { AppError, conflict, notFound } from '../../lib/errors.js';
import { hasPermission } from '../../lib/principal.js';
import { thumbnailUrl } from '../evidence/queries.js';
import { loadCaseFor } from './access.js';
import { assertMember } from './queries.js';
import { timelineSummary } from './timeline.js';

const idParams = z.object({ id: z.string().uuid() });
const CLOSED = new Set(['CLOSED', 'ARCHIVED']);
const LINKABLE_STATUSES = new Set(['REGISTERED', 'DISPOSAL_PENDING']);

export default async function linkRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // ------------------------------------------------------------------------------------------ team
  app.post('/:id/members', {
    preHandler: app.authorize('cases:manage'),
    schema: { tags: ['cases'], summary: 'Add a case team member (grants case-based visibility of linked evidence)', params: idParams, body: z.object({ userId: z.string().uuid(), role: z.enum(CASE_MEMBER_ROLES).default('MEMBER') }).strict() },
  }, async (req, reply) => {
    const p = req.requirePrincipal();
    const acc = await loadCaseFor(app.db, p, req.params.id);
    if (!acc.canManage) throw notFound('Case');
    if (CLOSED.has(acc.row.status)) throw conflict('The team of a closed/archived case cannot be changed');
    const { userId, role } = req.body;
    await assertMember(app.db, userId);
    await app.db.transaction().execute(async (tx) => {
      const ins = await tx.insertInto('case_members').values({ case_id: acc.row.id, user_id: userId, role, added_by: p.userId }).onConflict((oc) => oc.columns(['case_id', 'user_id']).doNothing()).returning('user_id').executeTakeFirst();
      if (!ins) throw conflict('User is already a member of this case');
      await appendAudit(tx, req.actor(), { action: 'CASE_MEMBER_CHANGED', resourceType: 'case', resourceId: acc.row.id, caseId: acc.row.id, orgUnitId: acc.row.org_unit_id, details: { change: 'ADDED', userId, role } });
    });
    reply.status(201);
    return { caseId: acc.row.id, userId, role };
  });

  app.delete('/:id/members/:userId', {
    preHandler: app.authorize('cases:manage'),
    schema: { tags: ['cases'], summary: 'Remove a case team member (revokes case-based visibility)', params: z.object({ id: z.string().uuid(), userId: z.string().uuid() }), body: z.object({ reason: z.string().trim().max(2000).optional() }).strict().nullish() },
  }, async (req) => {
    const p = req.requirePrincipal();
    const acc = await loadCaseFor(app.db, p, req.params.id);
    if (!acc.canManage) throw notFound('Case');
    const { userId } = req.params;
    await app.db.transaction().execute(async (tx) => {
      const del = await tx.deleteFrom('case_members').where('case_id', '=', acc.row.id).where('user_id', '=', userId).returning('role').executeTakeFirst();
      if (!del) throw notFound('Case member');
      await appendAudit(tx, req.actor(), { action: 'CASE_MEMBER_CHANGED', resourceType: 'case', resourceId: acc.row.id, caseId: acc.row.id, orgUnitId: acc.row.org_unit_id, details: { change: 'REMOVED', userId, role: del.role, reason: req.body?.reason ?? null } });
    });
    return { removed: true };
  });

  // ------------------------------------------------------------------------------------------ evidence links
  app.post('/:id/evidence', {
    preHandler: app.authorize('cases:link_evidence'),
    schema: {
      tags: ['cases'],
      summary: 'Link evidence items to the case (per-item results; items the caller cannot see report NOT_FOUND)',
      params: idParams,
      body: z.object({ evidenceIds: z.array(z.string().uuid()).min(1).max(100), note: z.string().trim().max(2000).optional() }).strict(),
    },
  }, async (req) => {
    const p = req.requirePrincipal();
    const acc = await loadCaseFor(app.db, p, req.params.id);
    if (!acc.canLink) throw notFound('Case');
    if (CLOSED.has(acc.row.status)) throw conflict('Evidence cannot be linked to a closed or archived case');
    const results: Array<{ evidenceId: string; status: 'LINKED' | 'ALREADY_LINKED' | 'NOT_FOUND' | 'NOT_LINKABLE'; evidenceNumber?: string | null }> = [];
    for (const evidenceId of [...new Set(req.body.evidenceIds)]) {
      let ev;
      try {
        ev = await loadEvidenceFor(app.db, p, evidenceId, 'evidence:read', req.actor());
      } catch (e) {
        if (e instanceof AppError && e.statusCode === 404) {
          results.push({ evidenceId, status: 'NOT_FOUND' });
          continue;
        }
        throw e;
      }
      if (!LINKABLE_STATUSES.has(ev.status)) {
        results.push({ evidenceId, status: 'NOT_LINKABLE', evidenceNumber: ev.evidence_number });
        continue;
      }
      const status = await app.db.transaction().execute(async (tx) => {
        const ins = await tx
          .insertInto('case_evidence')
          .values({ case_id: acc.row.id, evidence_id: ev.id, linked_by: p.userId!, note: req.body.note ?? null })
          .onConflict((oc) => oc.columns(['case_id', 'evidence_id']).where('unlinked_at', 'is', null).doNothing())
          .returning('id')
          .executeTakeFirst();
        if (!ins) return 'ALREADY_LINKED' as const;
        await appendAudit(tx, req.actor(), {
          action: 'EVIDENCE_LINKED_TO_CASE', resourceType: 'case_evidence', resourceId: ins.id, evidenceId: ev.id, caseId: acc.row.id, orgUnitId: ev.org_unit_id,
          details: { caseNumber: acc.row.case_number, evidenceNumber: ev.evidence_number, note: req.body.note ?? null },
        });
        return 'LINKED' as const;
      });
      results.push({ evidenceId, status, evidenceNumber: ev.evidence_number });
    }
    return { results, linked: results.filter((r) => r.status === 'LINKED').length };
  });

  app.delete('/:id/evidence/:evidenceId', {
    preHandler: app.authorize('cases:link_evidence'),
    schema: { tags: ['cases'], summary: 'Unlink evidence from the case (soft; reason recorded)', params: z.object({ id: z.string().uuid(), evidenceId: z.string().uuid() }), body: z.object({ reason: z.string().trim().min(5).max(2000) }).strict() },
  }, async (req) => {
    const p = req.requirePrincipal();
    const acc = await loadCaseFor(app.db, p, req.params.id);
    if (!acc.canLink) throw notFound('Case');
    if (acc.row.status === 'ARCHIVED') throw conflict('Evidence cannot be unlinked from an archived case');
    const ev = await loadEvidenceFor(app.db, p, req.params.evidenceId, 'evidence:read', req.actor());
    await app.db.transaction().execute(async (tx) => {
      const upd = await tx
        .updateTable('case_evidence')
        .set({ unlinked_at: new Date(), unlinked_by: p.userId, unlink_reason: req.body.reason })
        .where('case_id', '=', acc.row.id)
        .where('evidence_id', '=', ev.id)
        .where('unlinked_at', 'is', null)
        .returning('id')
        .executeTakeFirst();
      if (!upd) throw notFound('Evidence link');
      await appendAudit(tx, req.actor(), {
        action: 'EVIDENCE_UNLINKED_FROM_CASE', resourceType: 'case_evidence', resourceId: upd.id, evidenceId: ev.id, caseId: acc.row.id, orgUnitId: ev.org_unit_id,
        details: { caseNumber: acc.row.case_number, evidenceNumber: ev.evidence_number, reason: req.body.reason },
      });
    });
    return { unlinked: true };
  });

  app.get('/:id/evidence', {
    preHandler: app.authorize('cases:read'),
    schema: {
      tags: ['cases'],
      summary: 'Evidence linked to the case (only items the caller may see; hiddenCount = linked items outside the caller\'s access)',
      params: idParams,
      querystring: z.object({
        includeUnlinked: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(25),
      }),
    },
  }, async (req) => {
    const p = req.requirePrincipal();
    const acc = await loadCaseFor(app.db, p, req.params.id);
    const { includeUnlinked, page, pageSize } = req.query;
    let q = app.db
      .selectFrom('case_evidence as ce')
      .innerJoin('evidence as e', 'e.id', 'ce.evidence_id')
      .innerJoin('org_units as o', 'o.id', 'e.org_unit_id')
      .innerJoin('users as lb', 'lb.id', 'ce.linked_by')
      .leftJoin('users as ub', 'ub.id', 'ce.unlinked_by')
      .leftJoin('users as off', 'off.id', 'e.officer_id')
      .where('ce.case_id', '=', acc.row.id)
      .where(evidenceVisibleSql(p, 'e'));
    if (!includeUnlinked) q = q.where('ce.unlinked_at', 'is', null);
    const rows = await q
      .select([
        'ce.id as link_id', 'ce.linked_at', 'ce.note', 'ce.unlinked_at', 'ce.unlink_reason', 'lb.full_name as linked_by_name', 'ub.full_name as unlinked_by_name',
        'e.id', 'e.evidence_number', 'e.title', 'e.status', 'e.media_status', 'e.recorded_at', 'e.duration_ms', 'e.sha256', 'e.legal_hold',
        'o.name as org_name', 'off.full_name as officer_name', 'off.badge_number as officer_badge',
        sql<string | null>`(SELECT dv.id FROM evidence_derivatives dv WHERE dv.evidence_id = e.id AND e.status <> 'DISPOSED' AND dv.kind IN ('THUMBNAIL','POSTER') ORDER BY (dv.kind = 'THUMBNAIL') DESC, dv.created_at DESC LIMIT 1)`.as('thumb_id'),
        sql<number>`count(*) OVER ()`.as('total'),
      ])
      .orderBy('ce.linked_at', 'desc')
      .orderBy('ce.id')
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .execute();
    const counts = await app.db
      .selectFrom('case_evidence as ce')
      .innerJoin('evidence as e', 'e.id', 'ce.evidence_id')
      .select([sql<number>`count(*)::int`.as('total'), sql<number>`count(*) FILTER (WHERE ${evidenceVisibleSql(p, 'e')})::int`.as('visible')])
      .where('ce.case_id', '=', acc.row.id)
      .where('ce.unlinked_at', 'is', null)
      .executeTakeFirstOrThrow();
    let total = Number(rows[0]?.total ?? 0);
    if (!rows.length && page > 1) total = includeUnlinked ? total : Number(counts.visible);
    return {
      items: rows.map((r) => ({
        linkId: r.link_id,
        linkedAt: r.linked_at,
        linkedByName: r.linked_by_name,
        note: r.note,
        unlinkedAt: r.unlinked_at,
        unlinkedByName: r.unlinked_by_name,
        unlinkReason: r.unlink_reason,
        evidence: {
          id: r.id, evidenceNumber: r.evidence_number, title: r.title, status: r.status, mediaStatus: r.media_status, recordedAt: r.recorded_at,
          durationMs: r.duration_ms, sha256: r.sha256, legalHold: r.legal_hold, orgUnitName: r.org_name,
          officer: r.officer_name ? { fullName: r.officer_name, badgeNumber: r.officer_badge } : null,
          thumbnailUrl: thumbnailUrl(p, r.id, r.thumb_id),
        },
      })),
      total,
      page,
      pageSize,
      hiddenCount: Number(counts.total) - Number(counts.visible),
    };
  });

  // ------------------------------------------------------------------------------------------ case diary
  app.post('/:id/notes', {
    preHandler: app.authorize('cases:read'),
    schema: { tags: ['cases'], summary: 'Append a case diary entry (append-only)', params: idParams, body: z.object({ body: z.string().trim().min(1).max(20_000) }).strict() },
  }, async (req, reply) => {
    const p = req.requirePrincipal();
    const acc = await loadCaseFor(app.db, p, req.params.id);
    if (!acc.canAddNote || !p.userId) throw notFound('Case');
    if (acc.row.status === 'ARCHIVED') throw conflict('Archived cases do not accept diary entries');
    const note = await app.db.transaction().execute(async (tx) => {
      const n = await tx.insertInto('case_notes').values({ case_id: acc.row.id, author_id: p.userId!, body: req.body.body }).returning(['id', 'created_at']).executeTakeFirstOrThrow();
      await appendAudit(tx, req.actor(), { action: 'CASE_NOTE_ADDED', resourceType: 'case_note', resourceId: n.id, caseId: acc.row.id, orgUnitId: acc.row.org_unit_id, details: { length: req.body.body.length } });
      return n;
    });
    reply.status(201);
    return { id: note.id, body: req.body.body, createdAt: note.created_at, author: { id: p.userId, fullName: p.displayName } };
  });

  app.get('/:id/notes', {
    preHandler: app.authorize('cases:read'),
    schema: { tags: ['cases'], summary: 'Case diary entries (oldest first)', params: idParams, querystring: z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(50) }) },
  }, async (req) => {
    const p = req.requirePrincipal();
    const acc = await loadCaseFor(app.db, p, req.params.id);
    const { page, pageSize } = req.query;
    const rows = await app.db
      .selectFrom('case_notes as n')
      .innerJoin('users as u', 'u.id', 'n.author_id')
      .select(['n.id', 'n.body', 'n.created_at', 'u.id as uid', 'u.full_name', 'u.badge_number', sql<number>`count(*) OVER ()`.as('total')])
      .where('n.case_id', '=', acc.row.id)
      .orderBy('n.created_at')
      .orderBy('n.id')
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .execute();
    return {
      items: rows.map((r) => ({ id: r.id, body: r.body, createdAt: r.created_at, author: { id: r.uid, fullName: r.full_name, badgeNumber: r.badge_number } })),
      total: Number(rows[0]?.total ?? 0),
      page,
      pageSize,
    };
  });

  // ------------------------------------------------------------------------------------------ timeline
  app.get('/:id/timeline', {
    preHandler: app.authorize('cases:read'),
    schema: {
      tags: ['cases'],
      summary: 'Merged case timeline: case audit events, diary entries, status changes and (with custody:read) custody events of linked evidence while linked',
      params: idParams,
      querystring: z.object({ limit: z.coerce.number().int().min(1).max(1000).default(300), includeViews: z.enum(['true', 'false']).optional().transform((v) => v === 'true') }),
    },
  }, async (req) => {
    const p = req.requirePrincipal();
    const acc = await loadCaseFor(app.db, p, req.params.id);
    const { limit, includeViews } = req.query;
    const custody = hasPermission(p, 'custody:read') ? CUSTODY_ACTIONS.filter((a) => includeViews || (a !== 'EVIDENCE_VIEWED' && a !== 'EVIDENCE_PLAYED')) : [];
    const caseEvents = app.db
      .selectFrom('audit_events as a')
      .select(['a.seq', 'a.occurred_at', 'a.action', 'a.actor_type', 'a.actor_name', 'a.evidence_id', 'a.details', 'a.outcome'])
      .where('a.case_id', '=', acc.row.id)
      .where('a.action', '<>', 'CASE_NOTE_ADDED');
    // Custody events of linked (visible) evidence, only inside each link window, not already tagged with this case.
    const linkedEvents = custody.length
      ? app.db
          .selectFrom('audit_events as a')
          .innerJoin('case_evidence as ce', (j) => j.onRef('ce.evidence_id', '=', 'a.evidence_id').on('ce.case_id', '=', acc.row.id))
          .innerJoin('evidence as e', 'e.id', 'ce.evidence_id')
          .select(['a.seq', 'a.occurred_at', 'a.action', 'a.actor_type', 'a.actor_name', 'a.evidence_id', 'a.details', 'a.outcome'])
          .where(evidenceVisibleSql(p, 'e'))
          .where('a.action', 'in', custody)
          .where(sql<boolean>`a.case_id IS DISTINCT FROM ${acc.row.id}::uuid`)
          .where(sql<boolean>`a.occurred_at >= ce.linked_at AND a.occurred_at <= coalesce(ce.unlinked_at, now())`)
      : null;
    const events = await (linkedEvents ? caseEvents.union(linkedEvents) : caseEvents).orderBy('seq', 'desc').limit(limit).execute();
    const notes = await app.db
      .selectFrom('case_notes as n')
      .innerJoin('users as u', 'u.id', 'n.author_id')
      .select(['n.id', 'n.created_at', 'n.body', 'u.full_name'])
      .where('n.case_id', '=', acc.row.id)
      .orderBy('n.created_at', 'desc')
      .limit(limit)
      .execute();
    // Linked evidence numbers for summaries; hidden evidence ids are never revealed.
    const evIds = [...new Set(events.map((e) => e.evidence_id).filter((x): x is string => !!x))];
    const visible = evIds.length
      ? await app.db.selectFrom('evidence as e').select(['e.id', 'e.evidence_number']).where('e.id', 'in', evIds).where(evidenceVisibleSql(p, 'e')).execute()
      : [];
    const numbers = new Map(visible.map((v) => [v.id, v.evidence_number]));
    const items = [
      ...events.map((e) => {
        const evVisible = !!e.evidence_id && numbers.has(e.evidence_id);
        return {
          at: e.occurred_at,
          type: e.action,
          category: e.action === 'CASE_STATUS_CHANGED' ? 'STATUS' : e.evidence_id ? 'EVIDENCE' : 'CASE',
          actor: { type: e.actor_type, name: e.actor_name },
          outcome: e.outcome,
          summary: timelineSummary(e.action, (e.details ?? {}) as Record<string, unknown>, evVisible ? numbers.get(e.evidence_id!) ?? null : null),
          evidenceId: evVisible ? e.evidence_id : null,
        };
      }),
      ...notes.map((n) => ({
        at: n.created_at,
        type: 'CASE_NOTE',
        category: 'DIARY',
        actor: { type: 'USER', name: n.full_name },
        outcome: 'SUCCESS',
        summary: n.body.length > 280 ? `${n.body.slice(0, 280)}…` : n.body,
        evidenceId: null,
      })),
    ]
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
      .slice(0, limit);
    return { items, includesEvidenceCustody: custody.length > 0 };
  });

  // Guard against accidental misuse: notes are append-only at the DB level (UPDATE/DELETE revoked).
  app.patch('/:id/notes/:noteId', { preHandler: app.authorize('cases:read'), schema: { tags: ['cases'], summary: 'Not supported: diary entries are append-only', params: z.object({ id: z.string().uuid(), noteId: z.string().uuid() }) } }, async () => {
    throw new AppError(405, 'APPEND_ONLY', 'Case diary entries are append-only; add a new entry instead');
  });
}
