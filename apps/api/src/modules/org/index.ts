/**
 * Organisation hierarchy administration (STATE > ZONE/RANGE/COMMISSIONERATE > DISTRICT > SUBDIVISION/CIRCLE > STATION).
 * The ltree `path` is derived from the parent path and the unit code at creation and is IMMUTABLE afterwards:
 * evidence.org_path (and other org_path columns) are denormalised copies used for jurisdiction checks, so
 * re-parenting or re-coding a unit would silently move evidence between jurisdictions. Enforced by the
 * org_units_guard trigger (0100). To restructure, create a new unit and deactivate the old one.
 *
 * Org unit names/codes are not secret (visible to all personnel through /directory/org-units), so an
 * out-of-jurisdiction write answers 403 rather than 404.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';
import { appendAudit, isUniqueViolation } from '@ksp/core';
import { hasPermissionAt } from '../../lib/principal.js';
import { invalidatePrincipals } from '../../lib/load-principal.js';
import { conflict, notFound, validationFailed } from '../../lib/errors.js';
import { adminDenied, uuidParam } from '../users/admin-lib.js';

export const prefix = '/org';

export const UNIT_TYPES = ['STATE', 'ZONE', 'RANGE', 'COMMISSIONERATE', 'DISTRICT', 'SUBDIVISION', 'CIRCLE', 'STATION', 'UNIT'] as const;

const optText = (max: number) => z.string().trim().max(max).transform((v) => (v === '' ? null : v)).nullable().optional();
const editable = {
  name: z.string().trim().min(2).max(200),
  address: optText(500),
  phone: z.string().trim().regex(/^[0-9+() -]{6,20}$/, 'Invalid phone number').nullable().optional().or(z.literal('').transform(() => null)),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
};
const createBody = z.object({
  code: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{2,40}$/, 'Code: 2-40 lowercase letters, digits, underscore'),
  unitType: z.enum(UNIT_TYPES).refine((t) => t !== 'STATE', 'Only one STATE (root) unit exists'),
  parentId: z.string().uuid(),
  ...editable,
}).strict();
const patchBody = z.object({ ...editable, active: z.boolean() }).partial().strict();

export default async function org(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const db = app.db;

  const base = () =>
    db.selectFrom('org_units as o')
      .select(['o.id', 'o.code', 'o.name', 'o.unit_type', 'o.parent_id', 'o.path', 'o.address', 'o.phone', 'o.latitude', 'o.longitude', 'o.active', 'o.created_at', 'o.updated_at'])
      .select(sql<number>`(SELECT count(*)::int FROM org_units c WHERE c.parent_id = o.id)`.as('child_count'))
      .select(sql<number>`(SELECT count(*)::int FROM users u WHERE u.home_org_unit_id = o.id AND u.status <> 'DISABLED')`.as('user_count'))
      .select(sql<number>`(SELECT count(*)::int FROM devices d WHERE d.org_unit_id = o.id AND d.status <> 'RETIRED')`.as('device_count'));
  type Row = Awaited<ReturnType<ReturnType<typeof base>['executeTakeFirstOrThrow']>>;
  const dto = (r: Row, canManage: boolean) => ({
    id: r.id, code: r.code, name: r.name, unitType: r.unit_type, parentId: r.parent_id, path: r.path, depth: r.path.split('.').length - 1,
    address: r.address, phone: r.phone, latitude: r.latitude, longitude: r.longitude, active: r.active,
    childCount: r.child_count, userCount: r.user_count, deviceCount: r.device_count, createdAt: r.created_at, updatedAt: r.updated_at, canManage,
  });

  app.get('/', {
    preHandler: app.authorize('org:read'),
    schema: { tags: ['org'], summary: 'Organisation units in tree order (path)', querystring: z.object({ includeInactive: z.enum(['true', 'false']).default('true').transform((v) => v === 'true') }) },
  }, async (req) => {
    const p = req.requirePrincipal();
    let q = base().orderBy('o.path');
    if (!req.query.includeInactive) q = q.where('o.active', '=', true);
    const rows = await q.execute();
    return { items: rows.map((r) => dto(r, hasPermissionAt(p, 'org:manage', r.path))) };
  });

  app.get('/:id', { preHandler: app.authorize('org:read'), schema: { tags: ['org'], summary: 'Org unit detail', params: uuidParam } }, async (req) => {
    const p = req.requirePrincipal();
    const r = await base().where('o.id', '=', req.params.id).executeTakeFirst();
    if (!r) throw notFound('Org unit');
    return dto(r, hasPermissionAt(p, 'org:manage', r.path));
  });

  app.post('/', { preHandler: app.authorize('org:manage'), schema: { tags: ['org'], summary: 'Create an org unit under a parent', body: createBody } }, async (req, reply) => {
    const p = req.requirePrincipal();
    const b = req.body;
    const parent = await db.selectFrom('org_units').select(['id', 'path', 'active', 'unit_type']).where('id', '=', b.parentId).executeTakeFirst();
    if (!parent) throw validationFailed('Parent org unit not found');
    if (!hasPermissionAt(p, 'org:manage', parent.path)) throw await adminDenied(db, req, 'OUT_OF_SCOPE', 'You cannot create units outside your jurisdiction', { parentId: parent.id });
    if (!parent.active) throw conflict('Cannot create a unit under an inactive parent');
    if (parent.unit_type === 'STATION' && b.unitType !== 'UNIT') throw validationFailed('Only UNIT-type sub-units can be created under a station');
    const path = `${parent.path}.${b.code}`;
    let id: string;
    try {
      id = await db.transaction().execute(async (tx) => {
        const r = await tx.insertInto('org_units').values({
          code: b.code, name: b.name, unit_type: b.unitType, parent_id: parent.id, path, address: b.address ?? null, phone: b.phone ?? null,
          latitude: b.latitude ?? null, longitude: b.longitude ?? null,
        }).returning('id').executeTakeFirstOrThrow();
        await appendAudit(tx, req.actor(), { action: 'ORG_UNIT_CREATED', resourceType: 'org_unit', resourceId: r.id, orgUnitId: r.id, details: { code: b.code, name: b.name, unitType: b.unitType, path } });
        return r.id;
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('An org unit with this code already exists');
      throw e;
    }
    reply.status(201);
    return dto(await base().where('o.id', '=', id).executeTakeFirstOrThrow(), true);
  });

  app.patch('/:id', {
    preHandler: app.authorize('org:manage'),
    schema: { tags: ['org'], summary: 'Update an org unit (name, contact, location, active). Code/parent/type are immutable.', params: uuidParam, body: patchBody },
  }, async (req) => {
    const p = req.requirePrincipal();
    const unit = await db.selectFrom('org_units').select(['id', 'code', 'name', 'path', 'parent_id', 'address', 'phone', 'latitude', 'longitude', 'active']).where('id', '=', req.params.id).executeTakeFirst();
    if (!unit) throw notFound('Org unit');
    if (!hasPermissionAt(p, 'org:manage', unit.path)) throw await adminDenied(db, req, 'OUT_OF_SCOPE', 'This org unit is outside your jurisdiction', { orgUnitId: unit.id });
    const b = req.body;
    if (!Object.keys(b).length) throw validationFailed('Nothing to update');
    if (b.active === false && unit.active) {
      if (!unit.parent_id) throw conflict('The root org unit cannot be deactivated');
      // Deactivating the unit where the caller's own roles:manage/org:manage grant sits would be self-demotion.
      if (p.grants.some((g) => g.orgUnitId === unit.id)) throw await adminDenied(db, req, 'SELF_MODIFICATION', 'You cannot deactivate an org unit at which you hold a role', { orgUnitId: unit.id });
      const kids = await db.selectFrom('org_units').select(sql<number>`count(*)::int`.as('n')).where('parent_id', '=', unit.id).where('active', '=', true).executeTakeFirstOrThrow();
      if (kids.n > 0) throw conflict('Deactivate the child units first');
    }
    if (b.active === true && !unit.active && unit.parent_id) {
      const parent = await db.selectFrom('org_units').select('active').where('id', '=', unit.parent_id).executeTakeFirstOrThrow();
      if (!parent.active) throw conflict('Re-activate the parent unit first');
    }
    const set: Record<string, unknown> = {};
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const k of ['name', 'address', 'phone', 'latitude', 'longitude', 'active'] as const) {
      if (b[k] !== undefined && b[k] !== unit[k]) {
        set[k] = b[k];
        changes[k] = { from: unit[k], to: b[k] };
      }
    }
    if (Object.keys(set).length) {
      await db.transaction().execute(async (tx) => {
        await tx.updateTable('org_units').set(set).where('id', '=', unit.id).execute();
        await appendAudit(tx, req.actor(), { action: 'ORG_UNIT_UPDATED', resourceType: 'org_unit', resourceId: unit.id, orgUnitId: unit.id, details: { code: unit.code, changes } });
      });
      // Grants at inactive units stop applying (loadGrants filters o.active).
      if ('active' in set) invalidatePrincipals();
    }
    return dto(await base().where('o.id', '=', unit.id).executeTakeFirstOrThrow(), true);
  });
}
