/**
 * Directory lookups used by pickers across the UI (org units, users). Deliberately minimal fields.
 * Org unit names are visible to all authenticated personnel; user lookup requires a permission that
 * needs to pick people (users:read, cases:manage, share:create, devices:manage).
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';
import { isPermission } from '@ksp/shared';
import { hasPermission, pathCovers, scopePaths } from '../../lib/principal.js';
import { forbidden } from '../../lib/errors.js';

export const prefix = '/directory';

export default async function directory(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get('/org-units', {
    schema: {
      tags: ['directory'],
      summary: 'Active org units (for pickers); `scope=<permission>` limits the list to units where the caller holds that permission',
      querystring: z.object({
        includeInactive: z.coerce.boolean().default(false),
        // Pickers whose target endpoint is jurisdiction-checked (dashboard, reports, upload, admin forms) only offer units
        // the caller can actually use, instead of letting them pick a unit that the server then refuses with 404.
        scope: z.string().max(64).refine(isPermission, 'unknown permission').optional(),
      }),
    },
  }, async (req) => {
    let q = app.db.selectFrom('org_units').select(['id', 'code', 'name', 'unit_type', 'parent_id', 'path', 'active']).orderBy('path');
    if (!req.query.includeInactive) q = q.where('active', '=', true);
    let rows = await q.execute();
    if (req.query.scope) {
      const paths = scopePaths(req.requirePrincipal(), req.query.scope);
      rows = rows.filter((r) => paths.some((p) => pathCovers(p, r.path)));
    }
    return { items: rows.map((r) => ({ id: r.id, code: r.code, name: r.name, unitType: r.unit_type, parentId: r.parent_id, path: r.path, depth: r.path.split('.').length - 1, active: r.active })) };
  });

  app.get('/users', {
    schema: {
      tags: ['directory'],
      summary: 'Search users by name, username or badge (for pickers)',
      querystring: z.object({ q: z.string().trim().max(64).default(''), orgUnitId: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }),
    },
  }, async (req) => {
    const p = req.requirePrincipal();
    if (!['users:read', 'cases:manage', 'share:create', 'devices:manage', 'cases:read', 'reports:generate'].some((perm) => hasPermission(p, perm as never))) throw forbidden();
    const { q, orgUnitId, limit } = req.query;
    let query = app.db
      .selectFrom('users as u')
      .innerJoin('org_units as o', 'o.id', 'u.home_org_unit_id')
      .select(['u.id', 'u.username', 'u.full_name', 'u.badge_number', 'u.rank', 'o.id as org_id', 'o.name as org_name'])
      .where('u.status', '=', 'ACTIVE')
      .orderBy('u.full_name')
      .limit(limit);
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      query = query.where((eb) => eb.or([eb('u.full_name', 'ilike', like), eb(sql`u.username::text`, 'ilike', like), eb('u.badge_number', 'ilike', like)]));
    }
    if (orgUnitId) query = query.where('u.home_org_unit_id', '=', orgUnitId);
    const rows = await query.execute();
    return { items: rows.map((r) => ({ id: r.id, username: r.username, fullName: r.full_name, badgeNumber: r.badge_number, rank: r.rank, orgUnitId: r.org_id, orgUnitName: r.org_name })) };
  });
}
