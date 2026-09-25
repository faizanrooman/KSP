/**
 * Bookmarks, annotations and evidence relations.
 *
 * Visibility (always in addition to loadEvidenceFor 'evidence:read' on the evidence):
 *  - bookmark without workspace: personal (creator only); with workspace: members of that workspace;
 *  - annotation without workspace: everyone who can read the evidence; with workspace: its members;
 *  - relation: shown when the caller can see BOTH evidence items.
 * Writes attached to a workspace need the EDITOR role there. Every write is a custody event with evidenceId.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { appendAudit, type AuditActor, type Database } from '@ksp/core';
import { evidenceVisibleSql, loadEvidenceFor } from '../../lib/access.js';
import type { Principal } from '../../lib/principal.js';
import { conflict, forbidden, notFound, unprocessable, validationFailed } from '../../lib/errors.js';
import { atLeast, loadWorkspace, requireUser, type WsRole } from './access.js';

const idParams = z.object({ id: z.string().uuid() });
const evQuery = z.object({ evidenceId: z.string().uuid(), workspaceId: z.string().uuid().optional() });
const COLOR = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const region = z
  .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().gt(0).max(1), h: z.number().gt(0).max(1) })
  .strict()
  .refine((r) => r.x + r.w <= 1.0001 && r.y + r.h <= 1.0001, 'region must lie inside the frame (normalised 0..1)');

const bookmarkBody = z.object({ evidenceId: z.string().uuid(), workspaceId: z.string().uuid().optional(), timeMs: z.number().int().min(0), label: z.string().trim().min(1).max(200) }).strict();
const annotationBody = z
  .object({
    evidenceId: z.string().uuid(),
    workspaceId: z.string().uuid().optional(),
    kind: z.enum(['NOTE', 'HIGHLIGHT', 'REGION']),
    startMs: z.number().int().min(0),
    endMs: z.number().int().min(0).nullable().optional(),
    body: z.string().trim().max(5000).nullable().optional(),
    region: region.nullable().optional(),
    color: COLOR.nullable().optional(),
  })
  .strict();
const annotationPatch = z
  .object({ startMs: z.number().int().min(0), endMs: z.number().int().min(0).nullable(), body: z.string().trim().max(5000).nullable(), region: region.nullable(), color: COLOR.nullable() })
  .partial()
  .strict();
const relationBody = z
  .object({ evidenceA: z.string().uuid(), evidenceB: z.string().uuid(), relation: z.enum(['SAME_INCIDENT', 'DIFFERENT_ANGLE', 'CONTINUATION', 'RELATED']), note: z.string().trim().max(1000).optional() })
  .strict()
  .refine((b) => b.evidenceA !== b.evidenceB, 'An item cannot be related to itself');

/** Workspace ids the caller is a member of, with role. */
async function myWorkspaces(db: Database, uid: string): Promise<Map<string, { role: WsRole; title: string }>> {
  const rows = await db.selectFrom('workspace_members as m').innerJoin('workspaces as w', 'w.id', 'm.workspace_id').select(['m.workspace_id', 'm.role', 'w.title']).where('m.user_id', '=', uid).execute();
  return new Map(rows.map((r) => [r.workspace_id, { role: r.role as WsRole, title: r.title }]));
}

/** Workspace attachment for a write: EDITOR+ and the evidence must be an item of the workspace. */
async function attachTarget(db: Database, p: Principal, workspaceId: string | undefined, evidenceId: string) {
  if (!workspaceId) return null;
  const ws = await loadWorkspace(db, p, workspaceId, 'EDITOR');
  const item = await db.selectFrom('workspace_items').select('id').where('workspace_id', '=', ws.id).where('evidence_id', '=', evidenceId).executeTakeFirst();
  if (!item) throw unprocessable('Add the evidence to the workspace before bookmarking or annotating it there');
  return ws;
}

function checkRange(durationMs: number | null, ...times: Array<number | null | undefined>) {
  if (durationMs === null) return;
  for (const t of times) if (t !== null && t !== undefined && t > durationMs) throw validationFailed(`Time ${t} ms is beyond the end of the recording (${durationMs} ms)`);
}

export function mapAnnotation(r: {
  id: string; evidence_id: string; workspace_id: string | null; kind: string; start_ms: string | number; end_ms: string | number | null; body: string | null; region: unknown;
  color: string | null; created_at: Date; updated_at: Date; deleted_at: Date | null; author_id: string; author_name: string; deleted_by_name?: string | null;
}, extra: { workspaceTitle?: string | null; canEdit: boolean }) {
  return {
    id: r.id, evidenceId: r.evidence_id, workspaceId: r.workspace_id, workspaceTitle: extra.workspaceTitle ?? null, kind: r.kind, startMs: Number(r.start_ms),
    endMs: r.end_ms === null ? null : Number(r.end_ms), body: r.body, region: r.region, color: r.color, author: { id: r.author_id, fullName: r.author_name },
    createdAt: r.created_at, updatedAt: r.updated_at, deleted: !!r.deleted_at, deletedAt: r.deleted_at, deletedBy: r.deleted_by_name ?? null, canEdit: extra.canEdit && !r.deleted_at,
  };
}

export default async function notesRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const guard = app.authorize('workspace:use');

  // ---- bookmarks -----------------------------------------------------------------------------
  app.get('/bookmarks', { preValidation: guard, schema: { tags: ['workspaces'], summary: 'Bookmarks on an evidence item (mine + my workspaces)', querystring: evQuery } }, async (req) => {
    const p = req.requirePrincipal();
    const uid = requireUser(p);
    const ev = await loadEvidenceFor(app.db, p, req.query.evidenceId, 'evidence:read', req.actor());
    const wss = await myWorkspaces(app.db, uid);
    if (req.query.workspaceId && !wss.has(req.query.workspaceId)) throw notFound('Workspace');
    const wsIds = req.query.workspaceId ? [req.query.workspaceId] : [...wss.keys()];
    const rows = await app.db
      .selectFrom('bookmarks as b')
      .innerJoin('users as u', 'u.id', 'b.user_id')
      .select(['b.id', 'b.evidence_id', 'b.workspace_id', 'b.time_ms', 'b.label', 'b.created_at', 'u.id as uid', 'u.full_name'])
      .where('b.evidence_id', '=', ev.id)
      .where((eb) => {
        const ors = [eb('b.workspace_id', 'in', wsIds.length ? wsIds : ['00000000-0000-0000-0000-000000000000'])];
        if (!req.query.workspaceId) ors.push(eb.and([eb('b.workspace_id', 'is', null), eb('b.user_id', '=', uid)]));
        return eb.or(ors);
      })
      .orderBy('b.time_ms')
      .execute();
    return {
      items: rows.map((r) => {
        const ws = r.workspace_id ? wss.get(r.workspace_id) : undefined;
        return {
          id: r.id, evidenceId: r.evidence_id, workspaceId: r.workspace_id, workspaceTitle: ws?.title ?? null, timeMs: Number(r.time_ms), label: r.label,
          user: { id: r.uid, fullName: r.full_name }, createdAt: r.created_at, canDelete: r.uid === uid || (!!ws && atLeast(ws.role, 'OWNER')),
        };
      }),
    };
  });

  app.post('/bookmarks', { preValidation: guard, schema: { tags: ['workspaces'], summary: 'Bookmark a moment (personal, or in a workspace as editor)', body: bookmarkBody } }, async (req, reply) => {
    const p = req.requirePrincipal();
    const uid = requireUser(p);
    const ev = await loadEvidenceFor(app.db, p, req.body.evidenceId, 'evidence:read', req.actor());
    const ws = await attachTarget(app.db, p, req.body.workspaceId, ev.id);
    const dur = await app.db.selectFrom('evidence').select('duration_ms').where('id', '=', ev.id).executeTakeFirstOrThrow();
    checkRange(dur.duration_ms === null ? null : Number(dur.duration_ms), req.body.timeMs);
    const b = await app.db.transaction().execute(async (tx) => {
      const r = await tx
        .insertInto('bookmarks')
        .values({ evidence_id: ev.id, workspace_id: ws?.id ?? null, user_id: uid, time_ms: req.body.timeMs, label: req.body.label })
        .returning(['id', 'created_at'])
        .executeTakeFirstOrThrow();
      await appendAudit(tx, req.actor(), { action: 'BOOKMARK_CREATED', resourceType: 'bookmark', resourceId: r.id, evidenceId: ev.id, caseId: ws?.case_id ?? null, orgUnitId: ev.org_unit_id, details: { workspaceId: ws?.id ?? null, timeMs: req.body.timeMs, label: req.body.label } });
      return r;
    });
    return reply.status(201).send({ id: b.id, evidenceId: ev.id, workspaceId: ws?.id ?? null, workspaceTitle: ws?.title ?? null, timeMs: req.body.timeMs, label: req.body.label, user: { id: uid, fullName: p.displayName }, createdAt: b.created_at, canDelete: true });
  });

  app.delete('/bookmarks/:id', { preValidation: guard, schema: { tags: ['workspaces'], summary: 'Delete a bookmark (creator, or workspace owner)', params: idParams } }, async (req, reply) => {
    const p = req.requirePrincipal();
    const uid = requireUser(p);
    const b = await app.db.selectFrom('bookmarks').selectAll().where('id', '=', req.params.id).executeTakeFirst();
    if (!b) throw notFound('Bookmark');
    const wss = await myWorkspaces(app.db, uid);
    const ws = b.workspace_id ? wss.get(b.workspace_id) : undefined;
    if (b.workspace_id ? !ws : b.user_id !== uid) throw notFound('Bookmark');
    const ev = await loadEvidenceFor(app.db, p, b.evidence_id, 'evidence:read', req.actor());
    if (b.user_id !== uid && !(ws && atLeast(ws.role, 'OWNER'))) throw forbidden('Only the creator or the workspace owner can delete this bookmark');
    await app.db.transaction().execute(async (tx) => {
      await tx.deleteFrom('bookmarks').where('id', '=', b.id).execute();
      await appendAudit(tx, req.actor(), { action: 'BOOKMARK_DELETED', resourceType: 'bookmark', resourceId: b.id, evidenceId: ev.id, orgUnitId: ev.org_unit_id, details: { workspaceId: b.workspace_id, timeMs: Number(b.time_ms), label: b.label } });
    });
    return reply.status(204).send();
  });

  // ---- annotations ---------------------------------------------------------------------------
  const annSelect = (db: Database) =>
    db
      .selectFrom('annotations as a')
      .innerJoin('users as u', 'u.id', 'a.author_id')
      .leftJoin('users as du', 'du.id', 'a.deleted_by')
      .select(['a.id', 'a.evidence_id', 'a.workspace_id', 'a.kind', 'a.start_ms', 'a.end_ms', 'a.body', 'a.region', 'a.color', 'a.created_at', 'a.updated_at', 'a.deleted_at', 'a.author_id', 'u.full_name as author_name', 'du.full_name as deleted_by_name']);

  app.get(
    '/annotations',
    { preValidation: guard, schema: { tags: ['workspaces'], summary: 'Annotations on an evidence item (shared + my workspaces)', querystring: evQuery.extend({ includeDeleted: z.enum(['true', 'false']).default('false').transform((v) => v === 'true') }) } },
    async (req) => {
      const p = req.requirePrincipal();
      const uid = requireUser(p);
      const ev = await loadEvidenceFor(app.db, p, req.query.evidenceId, 'evidence:read', req.actor());
      const wss = await myWorkspaces(app.db, uid);
      if (req.query.workspaceId && !wss.has(req.query.workspaceId)) throw notFound('Workspace');
      const wsIds = req.query.workspaceId ? [req.query.workspaceId] : [...wss.keys()];
      let q = annSelect(app.db)
        .where('a.evidence_id', '=', ev.id)
        .where((eb) => {
          const ors = [eb('a.workspace_id', 'in', wsIds.length ? wsIds : ['00000000-0000-0000-0000-000000000000'])];
          if (!req.query.workspaceId) ors.push(eb('a.workspace_id', 'is', null));
          return eb.or(ors);
        });
      if (!req.query.includeDeleted) q = q.where('a.deleted_at', 'is', null);
      const rows = await q.orderBy('a.start_ms').orderBy('a.created_at').execute();
      return {
        items: rows.map((r) => {
          const ws = r.workspace_id ? wss.get(r.workspace_id) : undefined;
          return mapAnnotation(r, { workspaceTitle: ws?.title, canEdit: r.author_id === uid || (!!ws && atLeast(ws.role, 'OWNER')) });
        }),
      };
    },
  );

  app.post('/annotations', { preValidation: guard, schema: { tags: ['workspaces'], summary: 'Create an annotation (NOTE / HIGHLIGHT / REGION)', body: annotationBody } }, async (req, reply) => {
    const p = req.requirePrincipal();
    const uid = requireUser(p);
    const b = req.body;
    if (b.kind === 'REGION' && !b.region) throw validationFailed('REGION annotations need a region {x,y,w,h}');
    if (b.kind !== 'REGION' && b.region) throw validationFailed('Only REGION annotations carry a region');
    if (b.kind === 'NOTE' && !b.body) throw validationFailed('NOTE annotations need a body');
    if (b.endMs !== null && b.endMs !== undefined && b.endMs < b.startMs) throw validationFailed('endMs must not be before startMs');
    const ev = await loadEvidenceFor(app.db, p, b.evidenceId, 'evidence:read', req.actor());
    const ws = await attachTarget(app.db, p, b.workspaceId, ev.id);
    const dur = await app.db.selectFrom('evidence').select('duration_ms').where('id', '=', ev.id).executeTakeFirstOrThrow();
    checkRange(dur.duration_ms === null ? null : Number(dur.duration_ms), b.startMs, b.endMs);
    const id = await app.db.transaction().execute(async (tx) => {
      const r = await tx
        .insertInto('annotations')
        .values({ evidence_id: ev.id, workspace_id: ws?.id ?? null, author_id: uid, kind: b.kind, start_ms: b.startMs, end_ms: b.endMs ?? null, body: b.body ?? null, region: b.region ? JSON.stringify(b.region) : null, color: b.color ?? null })
        .returning('id')
        .executeTakeFirstOrThrow();
      await appendAudit(tx, req.actor(), { action: 'ANNOTATION_CREATED', resourceType: 'annotation', resourceId: r.id, evidenceId: ev.id, caseId: ws?.case_id ?? null, orgUnitId: ev.org_unit_id, details: { workspaceId: ws?.id ?? null, kind: b.kind, startMs: b.startMs, endMs: b.endMs ?? null, region: b.region ?? null } });
      return r.id;
    });
    const row = await annSelect(app.db).where('a.id', '=', id).executeTakeFirstOrThrow();
    return reply.status(201).send(mapAnnotation(row, { workspaceTitle: ws?.title, canEdit: true }));
  });

  /** Load an annotation the caller can see; `write` additionally requires author or workspace owner. */
  async function loadAnnotation(p: Principal, id: string, actor: AuditActor) {
    const uid = requireUser(p);
    const a = await annSelect(app.db).where('a.id', '=', id).executeTakeFirst();
    if (!a) throw notFound('Annotation');
    const wss = await myWorkspaces(app.db, uid);
    const ws = a.workspace_id ? wss.get(a.workspace_id) : undefined;
    if (a.workspace_id && !ws) throw notFound('Annotation');
    const ev = await loadEvidenceFor(app.db, p, a.evidence_id, 'evidence:read', actor);
    if (a.deleted_at) throw conflict('Annotation has been deleted');
    if (a.author_id !== uid && !(ws && atLeast(ws.role, 'OWNER'))) throw forbidden('Only the author or the workspace owner can change this annotation');
    if (a.workspace_id) await loadWorkspace(app.db, p, a.workspace_id, 'EDITOR');
    return { a, ev, ws };
  }

  app.patch('/annotations/:id', { preValidation: guard, schema: { tags: ['workspaces'], summary: 'Edit an annotation (author or workspace owner)', params: idParams, body: annotationPatch } }, async (req) => {
    const p = req.requirePrincipal();
    const { a, ev, ws } = await loadAnnotation(p, req.params.id, req.actor());
    const b = req.body;
    if (!Object.keys(b).length) throw validationFailed('Nothing to update');
    if (a.kind === 'REGION' && b.region === null) throw validationFailed('REGION annotations need a region');
    if (a.kind !== 'REGION' && b.region) throw validationFailed('Only REGION annotations carry a region');
    if (a.kind === 'NOTE' && b.body === null) throw validationFailed('NOTE annotations need a body');
    const start = b.startMs ?? Number(a.start_ms);
    const end = b.endMs !== undefined ? b.endMs : a.end_ms === null ? null : Number(a.end_ms);
    if (end !== null && end < start) throw validationFailed('endMs must not be before startMs');
    const dur = await app.db.selectFrom('evidence').select('duration_ms').where('id', '=', ev.id).executeTakeFirstOrThrow();
    checkRange(dur.duration_ms === null ? null : Number(dur.duration_ms), start, end);
    const set: Record<string, unknown> = {};
    const changes: Record<string, { before: unknown; after: unknown }> = {};
    const cols = { startMs: 'start_ms', endMs: 'end_ms', body: 'body', region: 'region', color: 'color' } as const;
    for (const [k, v] of Object.entries(b) as Array<[keyof typeof cols, unknown]>) {
      const col = cols[k];
      set[col] = col === 'region' && v ? JSON.stringify(v) : v;
      changes[k] = { before: col === 'start_ms' || col === 'end_ms' ? (a[col] === null ? null : Number(a[col])) : a[col], after: v };
    }
    await app.db.transaction().execute(async (tx) => {
      await tx.updateTable('annotations').set(set).where('id', '=', a.id).execute();
      await appendAudit(tx, req.actor(), { action: 'ANNOTATION_UPDATED', resourceType: 'annotation', resourceId: a.id, evidenceId: ev.id, orgUnitId: ev.org_unit_id, details: { workspaceId: a.workspace_id, changes } });
    });
    const row = await annSelect(app.db).where('a.id', '=', a.id).executeTakeFirstOrThrow();
    return mapAnnotation(row, { workspaceTitle: ws?.title, canEdit: true });
  });

  app.delete('/annotations/:id', { preValidation: guard, schema: { tags: ['workspaces'], summary: 'Soft-delete an annotation (kept for the audit trail)', params: idParams, body: z.object({ reason: z.string().trim().max(500).optional() }).strict().optional() } }, async (req, reply) => {
    const p = req.requirePrincipal();
    const uid = requireUser(p);
    const { a, ev } = await loadAnnotation(p, req.params.id, req.actor());
    await app.db.transaction().execute(async (tx) => {
      await tx.updateTable('annotations').set({ deleted_at: new Date(), deleted_by: uid }).where('id', '=', a.id).where('deleted_at', 'is', null).execute();
      await appendAudit(tx, req.actor(), { action: 'ANNOTATION_DELETED', resourceType: 'annotation', resourceId: a.id, evidenceId: ev.id, orgUnitId: ev.org_unit_id, details: { workspaceId: a.workspace_id, kind: a.kind, reason: req.body?.reason ?? null } });
    });
    return reply.status(204).send();
  });

  // ---- relations -----------------------------------------------------------------------------
  const relSelect = (db: Database, p: Principal) =>
    db
      .selectFrom('evidence_relations as r')
      .innerJoin('evidence as ea', 'ea.id', 'r.evidence_a')
      .innerJoin('evidence as eb', 'eb.id', 'r.evidence_b')
      .innerJoin('users as u', 'u.id', 'r.created_by')
      .select(['r.id', 'r.evidence_a', 'r.evidence_b', 'r.relation', 'r.note', 'r.created_at', 'u.id as uid', 'u.full_name', 'ea.evidence_number as a_number', 'ea.title as a_title', 'eb.evidence_number as b_number', 'eb.title as b_title'])
      .where(evidenceVisibleSql(p, 'ea'))
      .where(evidenceVisibleSql(p, 'eb'));
  type RelRow = Awaited<ReturnType<ReturnType<typeof relSelect>['execute']>>[number];
  const mapRel = (r: RelRow) => ({
    id: r.id, relation: r.relation, note: r.note, createdAt: r.created_at, createdBy: { id: r.uid, fullName: r.full_name },
    evidenceA: { id: r.evidence_a, evidenceNumber: r.a_number, title: r.a_title }, evidenceB: { id: r.evidence_b, evidenceNumber: r.b_number, title: r.b_title },
  });

  app.get('/relations', { preValidation: guard, schema: { tags: ['workspaces'], summary: 'Explicit relations of an evidence item (both items visible to me)', querystring: z.object({ evidenceId: z.string().uuid() }) } }, async (req) => {
    const p = req.requirePrincipal();
    const ev = await loadEvidenceFor(app.db, p, req.query.evidenceId, 'evidence:read', req.actor());
    const rows = await relSelect(app.db, p).where((eb) => eb.or([eb('r.evidence_a', '=', ev.id), eb('r.evidence_b', '=', ev.id)])).orderBy('r.created_at').execute();
    return { items: rows.map(mapRel) };
  });

  app.post('/relations', { preValidation: guard, schema: { tags: ['workspaces'], summary: 'Relate two evidence items (SAME_INCIDENT / DIFFERENT_ANGLE / CONTINUATION a→b / RELATED)', body: relationBody } }, async (req, reply) => {
    const p = req.requirePrincipal();
    const uid = requireUser(p);
    const a0 = await loadEvidenceFor(app.db, p, req.body.evidenceA, 'evidence:read', req.actor());
    const b0 = await loadEvidenceFor(app.db, p, req.body.evidenceB, 'evidence:read', req.actor());
    // symmetric relations are stored in canonical order so (a,b) and (b,a) are the same row; CONTINUATION is directional
    const [a, b] = req.body.relation !== 'CONTINUATION' && a0.id > b0.id ? [b0, a0] : [a0, b0];
    const id = await app.db.transaction().execute(async (tx) => {
      const r = await tx
        .insertInto('evidence_relations')
        .values({ evidence_a: a.id, evidence_b: b.id, relation: req.body.relation, note: req.body.note ?? null, created_by: uid })
        .onConflict((oc) => oc.columns(['evidence_a', 'evidence_b', 'relation']).doNothing())
        .returning('id')
        .executeTakeFirst();
      if (!r) throw conflict('These items already have this relation');
      for (const [self, other] of [[a, b], [b, a]] as const) {
        await appendAudit(tx, req.actor(), { action: 'EVIDENCE_RELATION_CHANGED', resourceType: 'evidence_relation', resourceId: r.id, evidenceId: self.id, orgUnitId: self.org_unit_id, details: { op: 'created', relation: req.body.relation, otherEvidenceId: other.id } });
      }
      return r.id;
    });
    return reply.status(201).send(mapRel(await relSelect(app.db, p).where('r.id', '=', id).executeTakeFirstOrThrow()));
  });

  app.delete('/relations/:id', { preValidation: guard, schema: { tags: ['workspaces'], summary: 'Remove a relation (both items must be visible to me)', params: idParams } }, async (req, reply) => {
    const p = req.requirePrincipal();
    const r = await relSelect(app.db, p).where('r.id', '=', req.params.id).executeTakeFirst();
    if (!r) throw notFound('Relation');
    const a = await loadEvidenceFor(app.db, p, r.evidence_a, 'evidence:read', req.actor());
    const b = await loadEvidenceFor(app.db, p, r.evidence_b, 'evidence:read', req.actor());
    await app.db.transaction().execute(async (tx) => {
      await tx.deleteFrom('evidence_relations').where('id', '=', r.id).execute();
      for (const [self, other] of [[a, b], [b, a]] as const) {
        await appendAudit(tx, req.actor(), { action: 'EVIDENCE_RELATION_CHANGED', resourceType: 'evidence_relation', resourceId: r.id, evidenceId: self.id, orgUnitId: self.org_unit_id, details: { op: 'deleted', relation: r.relation, otherEvidenceId: other.id } });
      }
    });
    return reply.status(204).send();
  });
}
