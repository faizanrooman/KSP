/**
 * Incident reconstruction timeline for a workspace.
 *
 * Merges, in wall-clock order:
 *   - RECORDING spans of the workspace items the caller can see (recorded_at → recorded_end_at, falling back to
 *     recorded_at + duration_ms);
 *   - manual timeline_events;
 *   - workspace bookmarks and (non-deleted) annotations, placed at evidence.recorded_at + time_ms.
 * Overlapping recordings ("same moment, different angle") are reported pairwise with the local time in each
 * video at which the overlap starts, and `suggestedOffsetMs` aligns every item on the shared sync timeline.
 * Items without a recorded_at cannot be placed; their bookmarks/annotations are returned under `unplaced`.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { appendAudit, type AuditActor, type Database } from '@ksp/core';
import { evidenceVisibleSql, loadEvidenceFor } from '../../lib/access.js';
import type { Principal } from '../../lib/principal.js';
import { notFound, unprocessable, validationFailed } from '../../lib/errors.js';
import { loadWorkspace, requireUser } from './access.js';
import { wsParams } from './workspace-routes.js';

const eventParams = z.object({ id: z.string().uuid(), eventId: z.string().uuid() });
const eventBody = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(5000).nullable().optional(),
    occurredAt: z.coerce.date(),
    evidenceId: z.string().uuid().nullable().optional(),
    timeMs: z.number().int().min(0).nullable().optional(),
  })
  .strict();
const eventPatch = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(5000).nullable(),
    occurredAt: z.coerce.date(),
    evidenceId: z.string().uuid().nullable(),
    timeMs: z.number().int().min(0).nullable(),
  })
  .partial()
  .strict();

export interface Lane {
  itemId: string;
  evidenceId: string;
  evidenceNumber: string | null;
  title: string | null;
  start: string;
  end: string;
  durationMs: number;
  syncOffsetMs: number;
  suggestedOffsetMs: number;
}

export type TimelineEntry =
  | { kind: 'RECORDING'; at: string; end: string; evidenceId: string; itemId: string; label: string }
  | { kind: 'EVENT'; at: string; id: string; title: string; description: string | null; evidenceId: string | null; timeMs: number | null; restricted: boolean; createdBy: string }
  | { kind: 'BOOKMARK'; at: string; id: string; evidenceId: string; timeMs: number; label: string; user: string }
  | { kind: 'ANNOTATION'; at: string; end: string | null; id: string; evidenceId: string; annotationKind: string; startMs: number; endMs: number | null; body: string | null; color: string | null; author: string };

export interface Overlap {
  a: string;
  b: string;
  start: string;
  end: string;
  durationMs: number;
  /** local playback time in a / b at which the overlap starts */
  aTimeMs: number;
  bTimeMs: number;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Pairwise overlaps between recording spans (pure; exported for tests). */
export function detectOverlaps(lanes: Array<{ evidenceId: string; startMs: number; endMs: number }>): Overlap[] {
  const out: Overlap[] = [];
  const sorted = [...lanes].sort((x, y) => x.startMs - y.startMs);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]!;
      const b = sorted[j]!;
      if (b.startMs >= a.endMs) break; // sorted by start: no later lane can overlap a
      const start = Math.max(a.startMs, b.startMs);
      const end = Math.min(a.endMs, b.endMs);
      if (end <= start) continue;
      out.push({ a: a.evidenceId, b: b.evidenceId, start: iso(start), end: iso(end), durationMs: end - start, aTimeMs: start - a.startMs, bTimeMs: start - b.startMs });
    }
  }
  return out;
}

export async function buildTimeline(db: Database, p: Principal, wsId: string) {
  const items = await db
    .selectFrom('workspace_items as wi')
    .innerJoin('evidence as e', 'e.id', 'wi.evidence_id')
    .select(['wi.id as item_id', 'wi.sync_offset_ms', 'e.id', 'e.evidence_number', 'e.title', 'e.recorded_at', 'e.recorded_end_at', 'e.duration_ms'])
    .where('wi.workspace_id', '=', wsId)
    .where(evidenceVisibleSql(p, 'e'))
    .orderBy('wi.sort_order')
    .execute();
  const visible = new Set(items.map((i) => i.id));
  const startOf = new Map<string, number>();
  const rawLanes = items
    .filter((i) => i.recorded_at)
    .map((i) => {
      const s = i.recorded_at!.getTime();
      const dur = i.duration_ms === null ? 0 : Number(i.duration_ms);
      const e = i.recorded_end_at ? i.recorded_end_at.getTime() : s + dur;
      startOf.set(i.id, s);
      return { i, s, e: Math.max(e, s) };
    });
  const minStart = rawLanes.length ? Math.min(...rawLanes.map((l) => l.s)) : 0;
  const lanes: Lane[] = rawLanes.map(({ i, s, e }) => ({
    itemId: i.item_id, evidenceId: i.id, evidenceNumber: i.evidence_number, title: i.title, start: iso(s), end: iso(e), durationMs: e - s,
    syncOffsetMs: Number(i.sync_offset_ms), suggestedOffsetMs: s - minStart,
  }));
  const entries: TimelineEntry[] = rawLanes.map(({ i, s, e }) => ({ kind: 'RECORDING', at: iso(s), end: iso(e), evidenceId: i.id, itemId: i.item_id, label: i.evidence_number ?? i.id }));
  const unplaced: TimelineEntry[] = [];

  const events = await db
    .selectFrom('timeline_events as t')
    .innerJoin('users as u', 'u.id', 't.created_by')
    .select(['t.id', 't.title', 't.description', 't.occurred_at', 't.evidence_id', 't.time_ms', 'u.full_name'])
    .where('t.workspace_id', '=', wsId)
    .where('t.deleted_at', 'is', null)
    .execute();
  for (const ev of events) {
    const restricted = !!ev.evidence_id && !visible.has(ev.evidence_id);
    entries.push({
      kind: 'EVENT', at: ev.occurred_at.toISOString(), id: ev.id, title: ev.title, description: ev.description, evidenceId: restricted ? null : ev.evidence_id,
      timeMs: restricted || ev.time_ms === null ? null : Number(ev.time_ms), restricted, createdBy: ev.full_name,
    });
  }
  if (visible.size) {
    const ids = [...visible];
    const bms = await db
      .selectFrom('bookmarks as b')
      .innerJoin('users as u', 'u.id', 'b.user_id')
      .select(['b.id', 'b.evidence_id', 'b.time_ms', 'b.label', 'u.full_name'])
      .where('b.workspace_id', '=', wsId)
      .where('b.evidence_id', 'in', ids)
      .execute();
    for (const b of bms) {
      const s = startOf.get(b.evidence_id);
      const t = Number(b.time_ms);
      const e: TimelineEntry = { kind: 'BOOKMARK', at: s === undefined ? '' : iso(s + t), id: b.id, evidenceId: b.evidence_id, timeMs: t, label: b.label, user: b.full_name };
      (s === undefined ? unplaced : entries).push(e);
    }
    const anns = await db
      .selectFrom('annotations as a')
      .innerJoin('users as u', 'u.id', 'a.author_id')
      .select(['a.id', 'a.evidence_id', 'a.kind', 'a.start_ms', 'a.end_ms', 'a.body', 'a.color', 'u.full_name'])
      .where('a.workspace_id', '=', wsId)
      .where('a.evidence_id', 'in', ids)
      .where('a.deleted_at', 'is', null)
      .execute();
    for (const a of anns) {
      const s = startOf.get(a.evidence_id);
      const st = Number(a.start_ms);
      const en = a.end_ms === null ? null : Number(a.end_ms);
      const e: TimelineEntry = {
        kind: 'ANNOTATION', at: s === undefined ? '' : iso(s + st), end: s === undefined || en === null ? null : iso(s + en), id: a.id, evidenceId: a.evidence_id,
        annotationKind: a.kind, startMs: st, endMs: en, body: a.body, color: a.color, author: a.full_name,
      };
      (s === undefined ? unplaced : entries).push(e);
    }
  }
  const order: Record<TimelineEntry['kind'], number> = { RECORDING: 0, EVENT: 1, ANNOTATION: 2, BOOKMARK: 3 };
  entries.sort((x, y) => x.at.localeCompare(y.at) || order[x.kind] - order[y.kind]);
  const overlaps = detectOverlaps(rawLanes.map((l) => ({ evidenceId: l.i.id, startMs: l.s, endMs: l.e })));
  const times = entries.flatMap((e) => [Date.parse(e.at), 'end' in e && e.end ? Date.parse(e.end) : NaN]).filter((n) => Number.isFinite(n));
  return {
    range: times.length ? { start: iso(Math.min(...times)), end: iso(Math.max(...times)) } : null,
    lanes,
    entries,
    overlaps,
    unplaced,
    unplacedItems: items.filter((i) => !i.recorded_at).map((i) => ({ itemId: i.item_id, evidenceId: i.id, evidenceNumber: i.evidence_number })),
  };
}

export default async function timelineRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const guard = app.authorize('workspace:use');

  app.get('/:id/timeline', { preValidation: guard, schema: { tags: ['workspaces'], summary: 'Chronological incident reconstruction (recordings, events, bookmarks, annotations, overlaps)', params: wsParams } }, async (req) => {
    const p = req.requirePrincipal();
    const ws = await loadWorkspace(app.db, p, req.params.id);
    return buildTimeline(app.db, p, ws.id);
  });

  /** evidence referenced by an event must be readable by the caller and be an item of the workspace */
  async function checkEventEvidence(p: Principal, wsId: string, evidenceId: string | null | undefined, actor: AuditActor) {
    if (!evidenceId) return null;
    const ev = await loadEvidenceFor(app.db, p, evidenceId, 'evidence:read', actor);
    const it = await app.db.selectFrom('workspace_items').select('id').where('workspace_id', '=', wsId).where('evidence_id', '=', ev.id).executeTakeFirst();
    if (!it) throw unprocessable('The evidence must be an item of this workspace');
    return ev;
  }

  app.post('/:id/timeline/events', { preValidation: guard, schema: { tags: ['workspaces'], summary: 'Add a manual timeline event (editor)', params: wsParams, body: eventBody } }, async (req, reply) => {
    const p = req.requirePrincipal();
    const uid = requireUser(p);
    const ws = await loadWorkspace(app.db, p, req.params.id, 'EDITOR');
    const b = req.body;
    if (b.timeMs !== null && b.timeMs !== undefined && !b.evidenceId) throw validationFailed('timeMs requires evidenceId');
    const ev = await checkEventEvidence(p, ws.id, b.evidenceId, req.actor());
    const id = await app.db.transaction().execute(async (tx) => {
      const r = await tx
        .insertInto('timeline_events')
        .values({ workspace_id: ws.id, title: b.title, description: b.description ?? null, occurred_at: b.occurredAt, evidence_id: ev?.id ?? null, time_ms: b.timeMs ?? null, created_by: uid })
        .returning('id')
        .executeTakeFirstOrThrow();
      await appendAudit(tx, req.actor(), { action: 'TIMELINE_EVENT_CHANGED', resourceType: 'timeline_event', resourceId: r.id, evidenceId: ev?.id ?? null, caseId: ws.case_id, orgUnitId: ws.org_unit_id, details: { op: 'created', workspaceId: ws.id, title: b.title, occurredAt: b.occurredAt.toISOString() } });
      return r.id;
    });
    return reply.status(201).send({ id, ...(await buildTimeline(app.db, p, ws.id)) });
  });

  app.patch('/:id/timeline/events/:eventId', { preValidation: guard, schema: { tags: ['workspaces'], summary: 'Edit a manual timeline event (editor)', params: eventParams, body: eventPatch } }, async (req) => {
    const p = req.requirePrincipal();
    const ws = await loadWorkspace(app.db, p, req.params.id, 'EDITOR');
    const cur = await app.db.selectFrom('timeline_events').selectAll().where('id', '=', req.params.eventId).where('workspace_id', '=', ws.id).where('deleted_at', 'is', null).executeTakeFirst();
    if (!cur) throw notFound('Timeline event');
    const b = req.body;
    if (!Object.keys(b).length) throw validationFailed('Nothing to update');
    const evidenceId = b.evidenceId !== undefined ? b.evidenceId : cur.evidence_id;
    const timeMs = b.timeMs !== undefined ? b.timeMs : cur.time_ms === null ? null : Number(cur.time_ms);
    if (timeMs !== null && !evidenceId) throw validationFailed('timeMs requires evidenceId');
    // referencing (or keeping a reference to) evidence requires being able to read it
    const ev = await checkEventEvidence(p, ws.id, evidenceId, req.actor());
    const set: Record<string, unknown> = {};
    if (b.title !== undefined) set.title = b.title;
    if (b.description !== undefined) set.description = b.description;
    if (b.occurredAt !== undefined) set.occurred_at = b.occurredAt;
    if (b.evidenceId !== undefined) set.evidence_id = b.evidenceId;
    if (b.timeMs !== undefined || b.evidenceId === null) set.time_ms = b.evidenceId === null ? null : timeMs;
    await app.db.transaction().execute(async (tx) => {
      await tx.updateTable('timeline_events').set(set).where('id', '=', cur.id).execute();
      await appendAudit(tx, req.actor(), { action: 'TIMELINE_EVENT_CHANGED', resourceType: 'timeline_event', resourceId: cur.id, evidenceId: ev?.id ?? null, caseId: ws.case_id, orgUnitId: ws.org_unit_id, details: { op: 'updated', workspaceId: ws.id, changed: Object.keys(b) } });
    });
    return buildTimeline(app.db, p, ws.id);
  });

  app.delete('/:id/timeline/events/:eventId', { preValidation: guard, schema: { tags: ['workspaces'], summary: 'Delete a manual timeline event (editor)', params: eventParams } }, async (req, reply) => {
    const p = req.requirePrincipal();
    const ws = await loadWorkspace(app.db, p, req.params.id, 'EDITOR');
    const cur = await app.db.selectFrom('timeline_events').select(['id', 'title', 'evidence_id']).where('id', '=', req.params.eventId).where('workspace_id', '=', ws.id).where('deleted_at', 'is', null).executeTakeFirst();
    if (!cur) throw notFound('Timeline event');
    await app.db.transaction().execute(async (tx) => {
      // FN-12: soft delete (the row and its content stay for the record, like annotations).
      const upd = await tx.updateTable('timeline_events').set({ deleted_at: new Date(), deleted_by: p.userId }).where('id', '=', cur.id).where('deleted_at', 'is', null).executeTakeFirst();
      if (!Number(upd.numUpdatedRows ?? 0)) throw notFound('Timeline event');
      await appendAudit(tx, req.actor(), { action: 'TIMELINE_EVENT_CHANGED', resourceType: 'timeline_event', resourceId: cur.id, caseId: ws.case_id, orgUnitId: ws.org_unit_id, details: { op: 'deleted', workspaceId: ws.id, title: cur.title } });
    });
    return reply.status(204).send();
  });
}
