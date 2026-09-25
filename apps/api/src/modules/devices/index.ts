/**
 * Capture device registry (body-worn cameras, dash cams, handhelds, CCTV, drones).
 * Scoped by the device's org unit: devices:read to see (out of scope => 404), devices:manage to change.
 * Serial numbers are unique (case-insensitive, stored upper-case). Devices are never deleted — they are
 * retired, because evidence rows reference them for provenance.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';
import { appendAudit, isUniqueViolation, type Database, type Tx } from '@ksp/core';
import { hasPermissionAt, type Principal } from '../../lib/principal.js';
import { orgScopeSql } from '../../lib/access.js';
import { conflict, forbidden, notFound, validationFailed } from '../../lib/errors.js';
import { adminDenied, likePattern, loadOrgUnit, pageFields, reasonField, uuidParam } from '../users/admin-lib.js';

export const prefix = '/devices';

export const DEVICE_TYPES = ['BODY_WORN_CAMERA', 'DASH_CAMERA', 'HANDHELD', 'CCTV', 'DRONE', 'OTHER'] as const;
export const DEVICE_STATUSES = ['ACTIVE', 'IN_REPAIR', 'LOST', 'RETIRED'] as const;
const SORTS = { serialNumber: 'd.serial_number', createdAt: 'd.created_at', updatedAt: 'd.updated_at', status: 'd.status', deviceType: 'd.device_type' } as const;
const sortValues = Object.keys(SORTS).flatMap((k) => [k, `-${k}`]) as [string, ...string[]];

const optText = (max: number) => z.string().trim().max(max).transform((v) => (v === '' ? null : v)).nullable().optional();
const serial = z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9._\-/]{2,63}$/, 'Serial: 3-64 letters, digits, . _ - /');
const createBody = z.object({
  serialNumber: serial,
  deviceType: z.enum(DEVICE_TYPES).default('BODY_WORN_CAMERA'),
  make: optText(100),
  model: optText(100),
  firmwareVersion: optText(100),
  orgUnitId: z.string().uuid(),
  assignedOfficerId: z.string().uuid().nullable().optional(),
  notes: optText(2000),
}).strict();
const patchBody = z.object({
  deviceType: z.enum(DEVICE_TYPES),
  make: optText(100),
  model: optText(100),
  firmwareVersion: optText(100),
  orgUnitId: z.string().uuid(),
  status: z.enum(['ACTIVE', 'IN_REPAIR', 'LOST']),
  notes: optText(2000),
}).partial().strict();
const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  serial: z.string().trim().max(64).optional(),
  type: z.enum(DEVICE_TYPES).optional(),
  status: z.enum(DEVICE_STATUSES).optional(),
  orgUnitId: z.string().uuid().optional(),
  officerId: z.string().uuid().optional(),
  assigned: z.enum(['true', 'false']).optional(),
  sort: z.enum(sortValues).default('serialNumber'),
  ...pageFields,
});

export default async function devices(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const db = app.db;

  const base = (dbx: Database | Tx = db) =>
    dbx.selectFrom('devices as d')
      .innerJoin('org_units as o', 'o.id', 'd.org_unit_id')
      .leftJoin('users as u', 'u.id', 'd.assigned_officer_id')
      .select([
        'd.id', 'd.serial_number', 'd.device_type', 'd.make', 'd.model', 'd.firmware_version', 'd.status', 'd.notes', 'd.created_at', 'd.updated_at',
        'o.id as org_id', 'o.name as org_name', 'o.code as org_code', 'o.path as org_path',
        'u.id as officer_id', 'u.full_name as officer_name', 'u.badge_number as officer_badge', 'u.username as officer_username',
      ]);
  type Row = Awaited<ReturnType<ReturnType<typeof base>['executeTakeFirstOrThrow']>>;
  const dto = (r: Row, p: Principal) => ({
    id: r.id, serialNumber: r.serial_number, deviceType: r.device_type, make: r.make, model: r.model, firmwareVersion: r.firmware_version,
    status: r.status, notes: r.notes, createdAt: r.created_at, updatedAt: r.updated_at,
    orgUnit: { id: r.org_id, name: r.org_name, code: r.org_code },
    assignedOfficer: r.officer_id ? { id: r.officer_id, fullName: r.officer_name, badgeNumber: r.officer_badge, username: r.officer_username } : null,
    canManage: hasPermissionAt(p, 'devices:manage', r.org_path),
  });

  /** Load a device visible to the caller (devices:read or devices:manage at its unit) — else 404; `manage` => 403 if not manageable. */
  async function loadDevice(p: Principal, id: string, manage: boolean) {
    const r = await base().where('d.id', '=', id).executeTakeFirst();
    if (!r || !(hasPermissionAt(p, 'devices:read', r.org_path) || hasPermissionAt(p, 'devices:manage', r.org_path))) throw notFound('Device');
    if (manage && !hasPermissionAt(p, 'devices:manage', r.org_path)) throw forbidden();
    return r;
  }

  /** The officer must be an ACTIVE user whose home unit is within the caller's devices:manage scope. */
  async function checkOfficer(p: Principal, officerId: string) {
    const u = await db.selectFrom('users as u').innerJoin('org_units as o', 'o.id', 'u.home_org_unit_id').select(['u.id', 'u.status', 'u.full_name', 'o.path']).where('u.id', '=', officerId).executeTakeFirst();
    if (!u || !hasPermissionAt(p, 'devices:manage', u.path)) throw validationFailed('Officer not found within your jurisdiction');
    if (u.status !== 'ACTIVE') throw conflict('Devices can only be assigned to active users');
    return u;
  }

  app.get('/', { preHandler: app.authorize('devices:read'), schema: { tags: ['devices'], summary: 'List devices within jurisdiction', querystring: listQuery } }, async (req) => {
    const p = req.requirePrincipal();
    const { q, serial: s, type, status, orgUnitId, officerId, assigned, sort, page, pageSize } = req.query;
    let qb = base().where(orgScopeSql(p, 'devices:read', 'o.path'));
    if (q) {
      const like = likePattern(q);
      qb = qb.where((eb) => eb.or([eb('d.serial_number', 'ilike', like), eb('d.make', 'ilike', like), eb('d.model', 'ilike', like), eb('u.full_name', 'ilike', like), eb('u.badge_number', 'ilike', like)]));
    }
    if (s) qb = qb.where('d.serial_number', 'ilike', likePattern(s));
    if (type) qb = qb.where('d.device_type', '=', type);
    if (status) qb = qb.where('d.status', '=', status);
    if (orgUnitId) qb = qb.where(sql<boolean>`o.path <@ (SELECT path FROM org_units WHERE id = ${orgUnitId}::uuid)`);
    if (officerId) qb = qb.where('d.assigned_officer_id', '=', officerId);
    if (assigned) qb = qb.where('d.assigned_officer_id', assigned === 'true' ? 'is not' : 'is', null);
    const total = await qb.clearSelect().select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow();
    const col = SORTS[sort.replace(/^-/, '') as keyof typeof SORTS];
    const rows = await qb.orderBy(sql.ref(col), sort.startsWith('-') ? 'desc' : 'asc').orderBy('d.id').limit(pageSize).offset((page - 1) * pageSize).execute();
    return { items: rows.map((r) => dto(r, p)), total: total.n, page, pageSize };
  });

  app.get('/:id', { preHandler: app.authorize('devices:read'), schema: { tags: ['devices'], summary: 'Device detail with recent history', params: uuidParam } }, async (req) => {
    const p = req.requirePrincipal();
    const r = await loadDevice(p, req.params.id, false);
    const history = await db.selectFrom('audit_events')
      .select(['seq', 'occurred_at', 'action', 'actor_name', 'details'])
      .where('resource_type', '=', 'device').where('resource_id', '=', r.id)
      .orderBy('seq', 'desc').limit(50).execute();
    const evidence = await db.selectFrom('evidence').select(sql<number>`count(*)::int`.as('n')).where('device_id', '=', r.id).executeTakeFirstOrThrow();
    return {
      ...dto(r, p),
      evidenceCount: evidence.n,
      history: history.map((h) => ({ seq: h.seq, occurredAt: h.occurred_at, action: h.action, actorName: h.actor_name, details: h.details })),
    };
  });

  app.post('/', { preHandler: app.authorize('devices:manage'), schema: { tags: ['devices'], summary: 'Register a device', body: createBody } }, async (req, reply) => {
    const p = req.requirePrincipal();
    const b = req.body;
    const org = await loadOrgUnit(db, b.orgUnitId).catch(() => { throw validationFailed('Org unit not found'); });
    if (!hasPermissionAt(p, 'devices:manage', org.path)) throw await adminDenied(db, req, 'OUT_OF_SCOPE', 'You cannot register devices outside your jurisdiction', { orgUnitId: org.id });
    if (!org.active) throw conflict('Devices cannot be registered to an inactive org unit');
    if (b.assignedOfficerId) await checkOfficer(p, b.assignedOfficerId);
    let id: string;
    try {
      id = await db.transaction().execute(async (tx) => {
        const r = await tx.insertInto('devices').values({
          serial_number: b.serialNumber, device_type: b.deviceType, make: b.make ?? null, model: b.model ?? null, firmware_version: b.firmwareVersion ?? null,
          org_unit_id: org.id, assigned_officer_id: b.assignedOfficerId ?? null, notes: b.notes ?? null, created_by: p.userId,
        }).returning('id').executeTakeFirstOrThrow();
        await appendAudit(tx, req.actor(), { action: 'DEVICE_REGISTERED', resourceType: 'device', resourceId: r.id, orgUnitId: org.id, details: { serialNumber: b.serialNumber, deviceType: b.deviceType, assignedOfficerId: b.assignedOfficerId ?? null } });
        return r.id;
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('A device with this serial number is already registered');
      throw e;
    }
    reply.status(201);
    return dto(await base().where('d.id', '=', id).executeTakeFirstOrThrow(), p);
  });

  app.patch('/:id', { schema: { tags: ['devices'], summary: 'Update device details, status or owning unit', params: uuidParam, body: patchBody } }, async (req) => {
    const p = req.requirePrincipal();
    const d = await loadDevice(p, req.params.id, true);
    if (d.status === 'RETIRED') throw conflict('Retired devices cannot be modified');
    const b = req.body;
    if (!Object.keys(b).length) throw validationFailed('Nothing to update');
    if (b.orgUnitId && b.orgUnitId !== d.org_id) {
      const org = await loadOrgUnit(db, b.orgUnitId).catch(() => { throw validationFailed('Org unit not found'); });
      if (!hasPermissionAt(p, 'devices:manage', org.path)) throw await adminDenied(db, req, 'OUT_OF_SCOPE', 'You cannot transfer a device outside your jurisdiction', { orgUnitId: org.id });
      if (!org.active) throw conflict('Devices cannot be transferred to an inactive org unit');
    }
    const map = { deviceType: 'device_type', make: 'make', model: 'model', firmwareVersion: 'firmware_version', orgUnitId: 'org_unit_id', status: 'status', notes: 'notes' } as const;
    const before: Record<string, unknown> = { device_type: d.device_type, make: d.make, model: d.model, firmware_version: d.firmware_version, org_unit_id: d.org_id, status: d.status, notes: d.notes };
    const set: Record<string, unknown> = {};
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [k, col] of Object.entries(map)) {
      const v = (b as Record<string, unknown>)[k];
      if (v !== undefined && v !== before[col]) {
        set[col] = v;
        changes[col] = { from: before[col], to: v };
      }
    }
    if (Object.keys(set).length) {
      await db.transaction().execute(async (tx) => {
        await tx.updateTable('devices').set(set).where('id', '=', d.id).execute();
        await appendAudit(tx, req.actor(), { action: 'DEVICE_UPDATED', resourceType: 'device', resourceId: d.id, orgUnitId: (set.org_unit_id as string) ?? d.org_id, details: { serialNumber: d.serial_number, changes } });
      });
    }
    return dto(await base().where('d.id', '=', d.id).executeTakeFirstOrThrow(), p);
  });

  app.post('/:id/assign', { schema: { tags: ['devices'], summary: 'Assign the device to an officer', params: uuidParam, body: z.object({ officerId: z.string().uuid() }).strict() } }, async (req) => {
    const p = req.requirePrincipal();
    const d = await loadDevice(p, req.params.id, true);
    if (d.status === 'RETIRED') throw conflict('Retired devices cannot be assigned');
    if (d.officer_id === req.body.officerId) throw conflict('Device is already assigned to this officer');
    const officer = await checkOfficer(p, req.body.officerId);
    await db.transaction().execute(async (tx) => {
      await tx.updateTable('devices').set({ assigned_officer_id: officer.id }).where('id', '=', d.id).execute();
      await appendAudit(tx, req.actor(), { action: 'DEVICE_ASSIGNED', resourceType: 'device', resourceId: d.id, orgUnitId: d.org_id, details: { serialNumber: d.serial_number, officerId: officer.id, previousOfficerId: d.officer_id } });
    });
    return dto(await base().where('d.id', '=', d.id).executeTakeFirstOrThrow(), p);
  });

  app.post('/:id/unassign', { schema: { tags: ['devices'], summary: 'Remove the officer assignment', params: uuidParam } }, async (req) => {
    const p = req.requirePrincipal();
    const d = await loadDevice(p, req.params.id, true);
    if (!d.officer_id) throw conflict('Device is not assigned');
    await db.transaction().execute(async (tx) => {
      await tx.updateTable('devices').set({ assigned_officer_id: null }).where('id', '=', d.id).execute();
      await appendAudit(tx, req.actor(), { action: 'DEVICE_UNASSIGNED', resourceType: 'device', resourceId: d.id, orgUnitId: d.org_id, details: { serialNumber: d.serial_number, previousOfficerId: d.officer_id } });
    });
    return dto(await base().where('d.id', '=', d.id).executeTakeFirstOrThrow(), p);
  });

  app.post('/:id/retire', { schema: { tags: ['devices'], summary: 'Retire a device (permanent; unassigns the officer)', params: uuidParam, body: z.object({ reason: reasonField }).strict() } }, async (req) => {
    const p = req.requirePrincipal();
    const d = await loadDevice(p, req.params.id, true);
    if (d.status === 'RETIRED') throw conflict('Device is already retired');
    await db.transaction().execute(async (tx) => {
      await tx.updateTable('devices').set({ status: 'RETIRED', assigned_officer_id: null }).where('id', '=', d.id).execute();
      await appendAudit(tx, req.actor(), { action: 'DEVICE_RETIRED', resourceType: 'device', resourceId: d.id, orgUnitId: d.org_id, details: { serialNumber: d.serial_number, reason: req.body.reason, previousStatus: d.status, previousOfficerId: d.officer_id } });
    });
    return dto(await base().where('d.id', '=', d.id).executeTakeFirstOrThrow(), p);
  });
}
