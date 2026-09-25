/** Workspaces CRUD, members and evidence items. */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';
import { appendAudit, type Database } from '@ksp/core';
import { evidenceVisibleSql, loadEvidenceFor, type EvidenceAccessRow } from '../../lib/access.js';
import type { Principal } from '../../lib/principal.js';
import { conflict, notFound, unprocessable, validationFailed } from '../../lib/errors.js';
import { loadListItems } from '../evidence/queries.js';
import { caseVisibleSql, escapeLike } from '../search/criteria.js';
import { loadWorkspace, requireUser } from './access.js';

export const wsParams = z.object({ id: z.string().uuid() });
const itemParams = z.object({ id: z.string().uuid(), itemId: z.string().uuid() });
const memberParams = z.object({ id: z.string().uuid(), userId: z.string().uuid() });
const OFFSET_LIMIT = 86_400_000 * 7; // ±7 days on the shared timeline

const listQuery = z.object({
  scope: z.enum(['all', 'mine', 'shared']).default('all'),
  status: z.enum(['ACTIVE', 'ARCHIVED', 'ANY']).default('ACTIVE'),
  q: z.string().trim().max(200).optional(),
  caseId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});
const createBody = z.object({ title: z.string().trim().min(1).max(200), description: z.string().trim().max(5000).optional(), caseId: z.string().uuid().optional() }).strict();
const patchBody = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(5000).nullable(),
    caseId: z.string().uuid().nullable(),
    status: z.enum(['ACTIVE', 'ARCHIVED']),
  })
  .partial()
  .strict();
const memberBody = z.object({ userId: z.string().uuid(), role: z.enum(['EDITOR', 'VIEWER']) }).strict();
const addItemsBody = z.object({ evidenceIds: z.array(z.string().uuid()).min(1).max(50), notes: z.string().trim().max(2000).optional() }).strict();
const patchItemBody = z
  .object({ syncOffsetMs: z.number().int().min(-OFFSET_LIMIT).max(OFFSET_LIMIT), sortOrder: z.number().int().min(0).max(100_000), notes: z.string().trim().max(2000).nullable() })
  .partial()
  .strict();
const offsetsBody = z.object({ items: z.array(z.object({ itemId: z.string().uuid(), syncOffsetMs: z.number().int().min(-OFFSET_LIMIT).max(OFFSET_LIMIT) }).strict()).min(1).max(50) }).strict();

/** A case the caller can read (404 otherwise, no existence leak). */
async function assertCaseReadable(db: Database, p: Principal, caseId: string) {
  const c = await db.selectFrom('cases as c').select(['c.id', 'c.case_number']).where('c.id', '=', caseId).where(caseVisibleSql(p, 'c')).executeTakeFirst();
  if (!c) throw notFound('Case');
  return c;
}

async function workspaceDetail(db: Database, p: Principal, id: string, myRole: string) {
  const w = await db
    .selectFrom('workspaces as w')
    .innerJoin('users as ow', 'ow.id', 'w.owner_id')
    .innerJoin('org_units as o', 'o.id', 'w.org_unit_id')
    .leftJoin('cases as c', 'c.id', 'w.case_id')
    .select([
      'w.id', 'w.title', 'w.description', 'w.status', 'w.case_id', 'w.created_at', 'w.updated_at', 'ow.id as owner_id', 'ow.full_name as owner_name',
      'o.id as org_id', 'o.name as org_name', 'c.case_number', 'c.title as case_title', 'c.status as case_status',
      sql<boolean>`${caseVisibleSql(p, 'c')}`.as('case_visible'),
      sql<number>`(SELECT count(*) FROM workspace_items wi WHERE wi.workspace_id = w.id)`.as('item_count'),
    ])
    .where('w.id', '=', id)
    .executeTakeFirstOrThrow();
  const members = await db
    .selectFrom('workspace_members as m')
    .innerJoin('users as u', 'u.id', 'm.user_id')
    .select(['u.id', 'u.full_name', 'u.username', 'u.badge_number', 'm.role', 'm.added_at'])
    .where('m.workspace_id', '=', id)
    .orderBy(sql`CASE m.role WHEN 'OWNER' THEN 0 WHEN 'EDITOR' THEN 1 ELSE 2 END`)
    .orderBy('u.full_name')
    .execute();
  return {
    id: w.id,
    title: w.title,
    description: w.description,
    status: w.status,
    case: w.case_id && w.case_visible ? { id: w.case_id, caseNumber: w.case_number, title: w.case_title, status: w.case_status } : null,
    caseRestricted: !!w.case_id && !w.case_visible,
    owner: { id: w.owner_id, fullName: w.owner_name },
    orgUnit: { id: w.org_id, name: w.org_name },
    myRole,
    itemCount: Number(w.item_count),
    members: members.map((m) => ({ userId: m.id, fullName: m.full_name, username: m.username, badgeNumber: m.badge_number, role: m.role, addedAt: m.added_at })),
    createdAt: w.created_at,
    updatedAt: w.updated_at,
  };
}

/** Items with evidence metadata for items the CALLER can see; others are returned as restricted stubs. */
export async function workspaceItems(db: Database, p: Principal, wsId: string) {
  const rows = await db
    .selectFrom('workspace_items as wi')
    .innerJoin('users as ab', 'ab.id', 'wi.added_by')
    .select([
      'wi.id', 'wi.evidence_id', 'wi.sync_offset_ms', 'wi.sort_order', 'wi.notes', 'wi.added_at', 'ab.id as ab_id', 'ab.full_name as ab_name',
      sql<boolean>`EXISTS (SELECT 1 FROM evidence e WHERE e.id = wi.evidence_id AND ${evidenceVisibleSql(p, 'e')})`.as('visible'),
    ])
    .where('wi.workspace_id', '=', wsId)
    .orderBy('wi.sort_order')
    .orderBy('wi.added_at')
    .execute();
  const visibleIds = rows.filter((r) => r.visible).map((r) => r.evidence_id);
  const ev = new Map((await loadListItems(db, p, visibleIds)).map((e) => [e.id, e]));
  const extra = visibleIds.length
    ? new Map(
        (await db.selectFrom('evidence').select(['id', 'recorded_end_at', 'frame_rate', 'gps_latitude', 'gps_longitude']).where('id', 'in', visibleIds).execute()).map((r) => [r.id, r]),
      )
    : new Map();
  return rows.map((r) => {
    const e = r.visible ? ev.get(r.evidence_id) : undefined;
    if (!e) return { id: r.id, restricted: true as const, sortOrder: r.sort_order, addedAt: r.added_at };
    const x = extra.get(r.evidence_id);
    return {
      id: r.id,
      restricted: false as const,
      evidenceId: r.evidence_id,
      syncOffsetMs: Number(r.sync_offset_ms),
      sortOrder: r.sort_order,
      notes: r.notes,
      addedBy: { id: r.ab_id, fullName: r.ab_name },
      addedAt: r.added_at,
      evidence: { ...e, recordedEndAt: x?.recorded_end_at ?? null, frameRate: x?.frame_rate === null || x?.frame_rate === undefined ? null : Number(x.frame_rate), gpsLatitude: x?.gps_latitude ?? null, gpsLongitude: x?.gps_longitude ?? null },
    };
  });
}

async function userCanUseWorkspaces(db: Database, userId: string): Promise<boolean> {
  const r = await sql<{ ok: boolean }>`SELECT EXISTS (SELECT 1 FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
      JOIN org_units o ON o.id = ur.org_unit_id
    WHERE u.id = ${userId}::uuid AND u.status = 'ACTIVE' AND o.active AND 'workspace:use' = ANY(r.permissions)
      AND (ur.expires_at IS NULL OR ur.expires_at > now())) AS ok`.execute(db);
  return !!r.rows[0]?.ok;
}

export default async function workspaceRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const guard = app.authorize('workspace:use');

  app.get('/', { preValidation: guard, schema: { tags: ['workspaces'], summary: 'Workspaces I own or am a member of', querystring: listQuery } }, async (req) => {
    const p = req.requirePrincipal();
    const uid = requireUser(p);
    const { scope, status, q, caseId, page, pageSize } = req.query;
    let qb = app.db
      .selectFrom('workspaces as w')
      .innerJoin('workspace_members as m', (j) => j.onRef('m.workspace_id', '=', 'w.id').on('m.user_id', '=', uid))
      .innerJoin('users as ow', 'ow.id', 'w.owner_id')
      .leftJoin('cases as c', 'c.id', 'w.case_id');
    if (scope === 'mine') qb = qb.where('w.owner_id', '=', uid);
    if (scope === 'shared') qb = qb.where('w.owner_id', '<>', uid);
    if (status !== 'ANY') qb = qb.where('w.status', '=', status);
    if (q) qb = qb.where('w.title', 'ilike', `%${escapeLike(q)}%`);
    if (caseId) qb = qb.where('w.case_id', '=', caseId);
    const rows = await qb
      .select([
        'w.id', 'w.title', 'w.description', 'w.status', 'w.case_id', 'w.created_at', 'w.updated_at', 'm.role', 'ow.id as owner_id', 'ow.full_name as owner_name',
        'c.case_number', sql<boolean>`${caseVisibleSql(p, 'c')}`.as('case_visible'),
        sql<number>`(SELECT count(*) FROM workspace_items wi WHERE wi.workspace_id = w.id)`.as('item_count'),
        sql<number>`(SELECT count(*) FROM workspace_members wm WHERE wm.workspace_id = w.id)`.as('member_count'),
        sql<number>`count(*) OVER ()`.as('total'),
      ])
      .orderBy('w.updated_at', 'desc')
      .orderBy('w.id')
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .execute();
    return {
      items: rows.map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        status: r.status,
        case: r.case_id && r.case_visible ? { id: r.case_id, caseNumber: r.case_number } : null,
        caseRestricted: !!r.case_id && !r.case_visible,
        owner: { id: r.owner_id, fullName: r.owner_name },
        myRole: r.role,
        itemCount: Number(r.item_count),
        memberCount: Number(r.member_count),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
      total: Number(rows[0]?.total ?? 0),
      page,
      pageSize,
    };
  });

  app.post('/', { preValidation: guard, schema: { tags: ['workspaces'], summary: 'Create a workspace (optionally for a case I can read)', body: createBody } }, async (req, reply) => {
    const p = req.requirePrincipal();
    const uid = requireUser(p);
    if (req.body.caseId) await assertCaseReadable(app.db, p, req.body.caseId);
    const id = await app.db.transaction().execute(async (tx) => {
      const w = await tx
        .insertInto('workspaces')
        .values({ title: req.body.title, description: req.body.description ?? null, case_id: req.body.caseId ?? null, owner_id: uid, org_unit_id: p.homeOrgUnitId })
        .returning('id')
        .executeTakeFirstOrThrow();
      await tx.insertInto('workspace_members').values({ workspace_id: w.id, user_id: uid, role: 'OWNER' }).execute();
      await appendAudit(tx, req.actor(), { action: 'WORKSPACE_CREATED', resourceType: 'workspace', resourceId: w.id, caseId: req.body.caseId ?? null, orgUnitId: p.homeOrgUnitId, details: { title: req.body.title } });
      return w.id;
    });
    return reply.status(201).send(await workspaceDetail(app.db, p, id, 'OWNER'));
  });

  app.get('/:id', { preValidation: guard, schema: { tags: ['workspaces'], summary: 'Workspace detail with members', params: wsParams } }, async (req) => {
    const p = req.requirePrincipal();
    const ws = await loadWorkspace(app.db, p, req.params.id);
    return workspaceDetail(app.db, p, ws.id, ws.role);
  });

  app.patch('/:id', { preValidation: guard, schema: { tags: ['workspaces'], summary: 'Edit title/description (editor), case link / archive state (owner)', params: wsParams, body: patchBody } }, async (req) => {
    const p = req.requirePrincipal();
    const b = req.body;
    if (!Object.keys(b).length) throw validationFailed('Nothing to update');
    const ownerOnly = b.caseId !== undefined || b.status !== undefined;
    const ws = await loadWorkspace(app.db, p, req.params.id, ownerOnly ? 'OWNER' : 'EDITOR', { allowArchived: b.status === 'ACTIVE' && Object.keys(b).length === 1 });
    if (b.caseId) await assertCaseReadable(app.db, p, b.caseId);
    const set: Record<string, unknown> = {};
    if (b.title !== undefined) set.title = b.title;
    if (b.description !== undefined) set.description = b.description || null;
    if (b.caseId !== undefined) set.case_id = b.caseId;
    if (b.status !== undefined) set.status = b.status;
    await app.db.transaction().execute(async (tx) => {
      await tx.updateTable('workspaces').set(set).where('id', '=', ws.id).execute();
      await appendAudit(tx, req.actor(), { action: 'WORKSPACE_UPDATED', resourceType: 'workspace', resourceId: ws.id, caseId: b.caseId ?? ws.case_id, orgUnitId: ws.org_unit_id, details: { changed: Object.keys(b), status: b.status } });
    });
    return workspaceDetail(app.db, p, ws.id, ws.role);
  });

  // ---- members -------------------------------------------------------------------------------
  app.post('/:id/members', { preValidation: guard, schema: { tags: ['workspaces'], summary: 'Add a member (owner). Membership never grants evidence access.', params: wsParams, body: memberBody } }, async (req, reply) => {
    const p = req.requirePrincipal();
    const ws = await loadWorkspace(app.db, p, req.params.id, 'OWNER');
    if (!(await userCanUseWorkspaces(app.db, req.body.userId))) throw unprocessable('User not found, inactive, or not permitted to use investigation workspaces');
    await app.db.transaction().execute(async (tx) => {
      const ins = await tx.insertInto('workspace_members').values({ workspace_id: ws.id, user_id: req.body.userId, role: req.body.role }).onConflict((oc) => oc.doNothing()).returning('user_id').executeTakeFirst();
      if (!ins) throw conflict('User is already a member');
      await appendAudit(tx, req.actor(), { action: 'WORKSPACE_MEMBER_CHANGED', resourceType: 'workspace', resourceId: ws.id, orgUnitId: ws.org_unit_id, details: { op: 'added', userId: req.body.userId, role: req.body.role } });
    });
    return reply.status(201).send(await workspaceDetail(app.db, p, ws.id, ws.role));
  });

  app.patch('/:id/members/:userId', { preValidation: guard, schema: { tags: ['workspaces'], summary: 'Change a member role (owner)', params: memberParams, body: z.object({ role: z.enum(['EDITOR', 'VIEWER']) }).strict() } }, async (req) => {
    const p = req.requirePrincipal();
    const ws = await loadWorkspace(app.db, p, req.params.id, 'OWNER');
    await app.db.transaction().execute(async (tx) => {
      const r = await tx.updateTable('workspace_members').set({ role: req.body.role }).where('workspace_id', '=', ws.id).where('user_id', '=', req.params.userId).where('role', '<>', 'OWNER').returning('user_id').executeTakeFirst();
      if (!r) throw notFound('Member');
      await appendAudit(tx, req.actor(), { action: 'WORKSPACE_MEMBER_CHANGED', resourceType: 'workspace', resourceId: ws.id, orgUnitId: ws.org_unit_id, details: { op: 'role', userId: req.params.userId, role: req.body.role } });
    });
    return workspaceDetail(app.db, p, ws.id, ws.role);
  });

  app.delete('/:id/members/:userId', { preValidation: guard, schema: { tags: ['workspaces'], summary: 'Remove a member (owner) or leave (self)', params: memberParams } }, async (req, reply) => {
    const p = req.requirePrincipal();
    const self = req.params.userId === p.userId;
    const ws = await loadWorkspace(app.db, p, req.params.id, self ? 'VIEWER' : 'OWNER', { allowArchived: true });
    if (req.params.userId === ws.owner_id) throw conflict('The owner cannot be removed from the workspace');
    await app.db.transaction().execute(async (tx) => {
      const r = await tx.deleteFrom('workspace_members').where('workspace_id', '=', ws.id).where('user_id', '=', req.params.userId).returning('user_id').executeTakeFirst();
      if (!r) throw notFound('Member');
      await appendAudit(tx, req.actor(), { action: 'WORKSPACE_MEMBER_CHANGED', resourceType: 'workspace', resourceId: ws.id, orgUnitId: ws.org_unit_id, details: { op: self ? 'left' : 'removed', userId: req.params.userId } });
    });
    return reply.status(204).send();
  });

  // ---- items ---------------------------------------------------------------------------------
  app.get('/:id/items', { preValidation: guard, schema: { tags: ['workspaces'], summary: 'Evidence items (items I cannot see are listed as restricted, without metadata)', params: wsParams } }, async (req) => {
    const p = req.requirePrincipal();
    const ws = await loadWorkspace(app.db, p, req.params.id);
    return { items: await workspaceItems(app.db, p, ws.id) };
  });

  app.post('/:id/items', { preValidation: guard, schema: { tags: ['workspaces'], summary: 'Add evidence (each item must be readable by me)', params: wsParams, body: addItemsBody } }, async (req, reply) => {
    const p = req.requirePrincipal();
    const uid = requireUser(p);
    const ws = await loadWorkspace(app.db, p, req.params.id, 'EDITOR');
    const evs: EvidenceAccessRow[] = [];
    for (const eid of [...new Set(req.body.evidenceIds)]) evs.push(await loadEvidenceFor(app.db, p, eid, 'evidence:read', req.actor()));
    const added = await app.db.transaction().execute(async (tx) => {
      const max = await tx.selectFrom('workspace_items').select(sql<number>`coalesce(max(sort_order), -1)`.as('m')).where('workspace_id', '=', ws.id).executeTakeFirst();
      let order = Number(max?.m ?? -1);
      const out: string[] = [];
      for (const ev of evs) {
        const ins = await tx
          .insertInto('workspace_items')
          .values({ workspace_id: ws.id, evidence_id: ev.id, sort_order: ++order, notes: req.body.notes ?? null, added_by: uid })
          .onConflict((oc) => oc.columns(['workspace_id', 'evidence_id']).doNothing())
          .returning('id')
          .executeTakeFirst();
        if (!ins) continue;
        out.push(ev.id);
        await appendAudit(tx, req.actor(), { action: 'WORKSPACE_EVIDENCE_ADDED', resourceType: 'workspace', resourceId: ws.id, evidenceId: ev.id, caseId: ws.case_id, orgUnitId: ev.org_unit_id, details: { workspaceId: ws.id, itemId: ins.id } });
      }
      if (out.length) await tx.updateTable('workspaces').set({ updated_at: new Date() }).where('id', '=', ws.id).execute();
      return out;
    });
    return reply.status(added.length ? 201 : 200).send({ added, items: await workspaceItems(app.db, p, ws.id) });
  });

  async function visibleItem(p: Principal, wsId: string, itemId: string) {
    const it = await app.db
      .selectFrom('workspace_items as wi')
      .innerJoin('evidence as e', 'e.id', 'wi.evidence_id')
      .select(['wi.id', 'wi.evidence_id', 'wi.sync_offset_ms', 'wi.sort_order', 'wi.notes', 'e.org_unit_id'])
      .where('wi.id', '=', itemId)
      .where('wi.workspace_id', '=', wsId)
      .where(evidenceVisibleSql(p, 'e'))
      .executeTakeFirst();
    if (!it) throw notFound('Workspace item');
    return it;
  }

  app.patch('/:id/items/:itemId', { preValidation: guard, schema: { tags: ['workspaces'], summary: 'Update sync offset / order / notes of an item', params: itemParams, body: patchItemBody } }, async (req) => {
    const p = req.requirePrincipal();
    const ws = await loadWorkspace(app.db, p, req.params.id, 'EDITOR');
    const it = await visibleItem(p, ws.id, req.params.itemId);
    const b = req.body;
    if (!Object.keys(b).length) throw validationFailed('Nothing to update');
    const set: Record<string, unknown> = {};
    if (b.syncOffsetMs !== undefined) set.sync_offset_ms = b.syncOffsetMs;
    if (b.sortOrder !== undefined) set.sort_order = b.sortOrder;
    if (b.notes !== undefined) set.notes = b.notes || null;
    await app.db.transaction().execute(async (tx) => {
      await tx.updateTable('workspace_items').set(set).where('id', '=', it.id).execute();
      await appendAudit(tx, req.actor(), { action: 'WORKSPACE_ITEM_UPDATED', resourceType: 'workspace', resourceId: ws.id, evidenceId: it.evidence_id, orgUnitId: it.org_unit_id, details: { itemId: it.id, changed: Object.keys(b), syncOffsetMs: b.syncOffsetMs } });
    });
    return { items: await workspaceItems(app.db, p, ws.id) };
  });

  app.put('/:id/items/offsets', { preValidation: guard, schema: { tags: ['workspaces'], summary: 'Persist synchronised-playback offsets for several items at once', params: wsParams, body: offsetsBody } }, async (req) => {
    const p = req.requirePrincipal();
    const ws = await loadWorkspace(app.db, p, req.params.id, 'EDITOR');
    const items: Array<Awaited<ReturnType<typeof visibleItem>> & { next: number }> = [];
    for (const x of req.body.items) items.push({ ...(await visibleItem(p, ws.id, x.itemId)), next: x.syncOffsetMs });
    await app.db.transaction().execute(async (tx) => {
      for (const it of items) {
        if (Number(it.sync_offset_ms) === it.next) continue;
        await tx.updateTable('workspace_items').set({ sync_offset_ms: it.next }).where('id', '=', it.id).execute();
        await appendAudit(tx, req.actor(), { action: 'WORKSPACE_ITEM_UPDATED', resourceType: 'workspace', resourceId: ws.id, evidenceId: it.evidence_id, orgUnitId: it.org_unit_id, details: { itemId: it.id, changed: ['syncOffsetMs'], syncOffsetMs: it.next } });
      }
    });
    return { items: await workspaceItems(app.db, p, ws.id) };
  });

  app.delete('/:id/items/:itemId', { preValidation: guard, schema: { tags: ['workspaces'], summary: 'Remove an item from the workspace (the evidence itself is untouched)', params: itemParams } }, async (req, reply) => {
    const p = req.requirePrincipal();
    const ws = await loadWorkspace(app.db, p, req.params.id, 'EDITOR');
    const it = await visibleItem(p, ws.id, req.params.itemId);
    await app.db.transaction().execute(async (tx) => {
      await tx.deleteFrom('workspace_items').where('id', '=', it.id).execute();
      await appendAudit(tx, req.actor(), { action: 'WORKSPACE_EVIDENCE_REMOVED', resourceType: 'workspace', resourceId: ws.id, evidenceId: it.evidence_id, caseId: ws.case_id, orgUnitId: it.org_unit_id, details: { workspaceId: ws.id, itemId: it.id } });
    });
    return reply.status(204).send();
  });
}
