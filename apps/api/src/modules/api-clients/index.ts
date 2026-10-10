/**
 * Integration API clients admin (integrations:manage). Clients authenticate to /api/v1/integration/* with
 * HTTP Basic `client_id:secret`. The secret is shown ONCE (create / rotate); only an argon2id hash is stored.
 * Scopes are limited to INTEGRATION_SCOPES; jurisdiction = the client's org unit subtree.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { isIP } from 'node:net';
import { randomBytes } from 'node:crypto';
import { appendAudit, hashSecret, randomToken } from '@ksp/core';
import { INTEGRATION_SCOPES, type Permission } from '@ksp/shared';
import { hasPermissionAt, type Principal } from '../../lib/principal.js';
import { conflict, forbidden, notFound, validationFailed } from '../../lib/errors.js';
import { invalidateApiClientCache } from '../../lib/api-client-auth.js';

export const prefix = '/api-clients';

const idParams = z.object({ id: z.string().uuid() });

/** IPv4 CIDR with zero host bits, bare IPv4, or exact IPv6 address. Returns the normalised form. */
export function normaliseCidr(v: string): string | null {
  const [addr = '', bits] = v.trim().split('/');
  if (isIP(addr) === 6) return bits === undefined || bits === '128' ? `${addr.toLowerCase()}/128` : null;
  if (isIP(addr) !== 4) return null;
  const n = bits === undefined ? 32 : Number(bits);
  if (!Number.isInteger(n) || n < 0 || n > 32) return null;
  const int = addr.split('.').reduce((a, o) => ((a << 8) + Number(o)) >>> 0, 0);
  const hostMask = n === 32 ? 0 : (0xffffffff >>> n) >>> 0;
  return (int & hostMask) === 0 ? `${addr}/${n}` : null;
}

const ips = z.array(z.string().trim().max(64)).max(50).transform((list, ctx) => {
  const out: string[] = [];
  for (const v of list) {
    const c = normaliseCidr(v);
    if (!c) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid IP/CIDR ${v} (IPv4 CIDR with zero host bits, or an exact IPv6 address)` });
    else out.push(c);
  }
  return out;
});

const createBody = z.object({
  name: z.string().trim().min(3).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  scopes: z.array(z.enum(INTEGRATION_SCOPES)).min(1),
  orgUnitId: z.string().uuid(),
  allowedIps: ips.default([]),
  expiresAt: z.coerce.date().nullable().optional(),
  rateLimitPerMinute: z.number().int().min(1).max(10_000).default(60),
}).strict();

const patchBody = z.object({
  name: z.string().trim().min(3).max(200),
  description: z.string().trim().max(2000).nullable(),
  scopes: z.array(z.enum(INTEGRATION_SCOPES)).min(1),
  allowedIps: ips,
  expiresAt: z.coerce.date().nullable(),
  rateLimitPerMinute: z.number().int().min(1).max(10_000),
}).partial().strict();

type Row = {
  id: string; name: string; description: string | null; client_id: string; scopes: string[]; org_unit_id: string; org_name: string; org_path: string;
  allowed_ips: string[]; rate_limit_per_minute: number; created_at: Date; expires_at: Date | null; revoked_at: Date | null; revoke_reason: string | null;
  last_used_at: Date | null; secret_rotated_at: Date | null; created_by_name: string | null;
};

function dto(r: Row) {
  const now = new Date();
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    clientId: r.client_id,
    scopes: r.scopes,
    orgUnit: { id: r.org_unit_id, name: r.org_name },
    allowedIps: r.allowed_ips,
    rateLimitPerMinute: r.rate_limit_per_minute,
    status: r.revoked_at ? 'REVOKED' : r.expires_at && r.expires_at <= now ? 'EXPIRED' : 'ACTIVE',
    createdAt: r.created_at,
    createdByName: r.created_by_name,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
    revokeReason: r.revoke_reason,
    lastUsedAt: r.last_used_at,
    secretRotatedAt: r.secret_rotated_at,
  };
}

const newSecret = () => `ksps_${randomToken(32)}`;

/**
 * An API client can only hold rights its creator holds at that unit: an administrator (integrations:manage, no
 * evidence access) must not mint a credential that reads or downloads evidence. Evidence scopes therefore need a creator
 * who also holds evidence:read / evidence:download_original there (e.g. a custom "Integration officer" role).
 */
function scopesBeyondCreator(p: Principal, scopes: readonly string[], orgPath: string): string[] {
  return scopes.filter((s) => !hasPermissionAt(p, s as Permission, orgPath));
}

export default async function apiClients(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const guard = app.authorize('integrations:manage');
  const q = () =>
    app.db
      .selectFrom('api_clients as c')
      .innerJoin('org_units as o', 'o.id', 'c.org_unit_id')
      .leftJoin('users as u', 'u.id', 'c.created_by')
      .select([
        'c.id', 'c.name', 'c.description', 'c.client_id', 'c.scopes', 'c.org_unit_id', 'o.name as org_name', 'o.path as org_path', 'c.allowed_ips',
        'c.rate_limit_per_minute', 'c.created_at', 'c.expires_at', 'c.revoked_at', 'c.revoke_reason', 'c.last_used_at', 'c.secret_rotated_at', 'u.full_name as created_by_name',
      ]);
  const refuseScopesBeyondCreator = async (req: FastifyRequest, p: Principal, scopes: readonly string[], orgPath: string, orgUnitId: string) => {
    const missing = scopesBeyondCreator(p, scopes, orgPath);
    if (!missing.length) return;
    await appendAudit(app.db, req.actor(), { action: 'ACCESS_DENIED', outcome: 'DENIED', resourceType: 'api_client', orgUnitId, details: { reason: 'scopes beyond the creator\'s own rights', scopes: missing } });
    throw forbidden(`You can only give an API client rights you hold yourself at this unit: missing ${missing.join(', ')}`);
  };
  const load = async (id: string, p: Principal) => {
    const r = await q().where('c.id', '=', id).executeTakeFirst();
    if (!r || !hasPermissionAt(p, 'integrations:manage', r.org_path)) throw notFound('API client');
    return r;
  };

  app.get('/', { preHandler: guard, schema: { tags: ['integrations'], summary: 'List integration API clients' } }, async (req) => {
    const p = req.requirePrincipal();
    const rows = await q().orderBy('c.created_at', 'desc').execute();
    return { items: rows.filter((r) => hasPermissionAt(p, 'integrations:manage', r.org_path)).map(dto), availableScopes: INTEGRATION_SCOPES };
  });

  app.get('/:id', { preHandler: guard, schema: { tags: ['integrations'], summary: 'API client detail', params: idParams } }, async (req) => dto(await load(req.params.id, req.requirePrincipal())));

  app.post('/', { preHandler: guard, schema: { tags: ['integrations'], summary: 'Create an API client; the secret is returned ONCE', body: createBody } }, async (req, reply) => {
    const p = req.requirePrincipal();
    const b = req.body;
    const org = await app.db.selectFrom('org_units').select(['id', 'path', 'active']).where('id', '=', b.orgUnitId).executeTakeFirst();
    if (!org || !hasPermissionAt(p, 'integrations:manage', org.path)) throw notFound('Org unit');
    if (!org.active) throw validationFailed('Org unit is inactive');
    if (b.expiresAt && b.expiresAt <= new Date()) throw validationFailed('expiresAt must be in the future');
    await refuseScopesBeyondCreator(req, p, b.scopes, org.path, org.id);
    const clientId = `kspc_${randomBytes(12).toString('hex')}`;
    const secret = newSecret();
    const hash = await hashSecret(secret);
    const id = await app.db.transaction().execute(async (tx) => {
      const r = await tx
        .insertInto('api_clients')
        .values({
          name: b.name, description: b.description ?? null, client_id: clientId, secret_hash: hash, scopes: [...new Set(b.scopes)], org_unit_id: org.id,
          allowed_ips: b.allowedIps, expires_at: b.expiresAt ?? null, rate_limit_per_minute: b.rateLimitPerMinute, created_by: p.userId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await appendAudit(tx, req.actor(), { action: 'API_CLIENT_CREATED', resourceType: 'api_client', resourceId: r.id, orgUnitId: org.id, details: { clientId, name: b.name, scopes: b.scopes, allowedIps: b.allowedIps, expiresAt: b.expiresAt ?? null } });
      return r.id;
    });
    reply.status(201);
    reply.header('cache-control', 'no-store');
    return { client: dto(await load(id, p)), clientId, clientSecret: secret, secretShownOnce: true };
  });

  app.patch('/:id', { preHandler: guard, schema: { tags: ['integrations'], summary: 'Update scopes, IP allow-list, expiry, rate limit', params: idParams, body: patchBody } }, async (req) => {
    const p = req.requirePrincipal();
    const cur = await load(req.params.id, p);
    if (cur.revoked_at) throw conflict('Revoked clients cannot be changed');
    const b = req.body;
    if (!Object.keys(b).length) throw validationFailed('No changes supplied');
    if (b.scopes) await refuseScopesBeyondCreator(req, p, b.scopes, cur.org_path, cur.org_unit_id);
    const set: Record<string, unknown> = {};
    if (b.name) set.name = b.name;
    if ('description' in b) set.description = b.description ?? null;
    if (b.scopes) set.scopes = [...new Set(b.scopes)];
    if (b.allowedIps) set.allowed_ips = b.allowedIps;
    if ('expiresAt' in b) set.expires_at = b.expiresAt ?? null;
    if (b.rateLimitPerMinute) set.rate_limit_per_minute = b.rateLimitPerMinute;
    await app.db.transaction().execute(async (tx) => {
      await tx.updateTable('api_clients').set(set).where('id', '=', cur.id).execute();
      await appendAudit(tx, req.actor(), { action: 'API_CLIENT_UPDATED', resourceType: 'api_client', resourceId: cur.id, orgUnitId: cur.org_unit_id, details: { clientId: cur.client_id, fields: Object.keys(b), scopes: b.scopes, allowedIps: b.allowedIps } });
    });
    return dto(await load(cur.id, p));
  });

  app.post('/:id/revoke', { preHandler: guard, schema: { tags: ['integrations'], summary: 'Revoke an API client (immediate)', params: idParams, body: z.object({ reason: z.string().trim().min(5).max(2000) }).strict() } }, async (req) => {
    const p = req.requirePrincipal();
    const cur = await load(req.params.id, p);
    if (cur.revoked_at) throw conflict('API client is already revoked');
    await app.db.transaction().execute(async (tx) => {
      await tx.updateTable('api_clients').set({ revoked_at: new Date(), revoked_by: p.userId, revoke_reason: req.body.reason }).where('id', '=', cur.id).execute();
      await appendAudit(tx, req.actor(), { action: 'API_CLIENT_REVOKED', resourceType: 'api_client', resourceId: cur.id, orgUnitId: cur.org_unit_id, details: { clientId: cur.client_id, reason: req.body.reason } });
    });
    invalidateApiClientCache(cur.id);
    return dto(await load(cur.id, p));
  });

  app.post('/:id/rotate-secret', { preHandler: guard, schema: { tags: ['integrations'], summary: 'Rotate the client secret; the new secret is returned ONCE and the old one stops working', params: idParams } }, async (req, reply) => {
    const p = req.requirePrincipal();
    const cur = await load(req.params.id, p);
    if (cur.revoked_at) throw conflict('Revoked clients cannot be rotated');
    const secret = newSecret();
    const hash = await hashSecret(secret);
    await app.db.transaction().execute(async (tx) => {
      await tx.updateTable('api_clients').set({ secret_hash: hash, secret_rotated_at: new Date() }).where('id', '=', cur.id).execute();
      await appendAudit(tx, req.actor(), { action: 'API_CLIENT_SECRET_ROTATED', resourceType: 'api_client', resourceId: cur.id, orgUnitId: cur.org_unit_id, details: { clientId: cur.client_id } });
    });
    invalidateApiClientCache(cur.id);
    reply.header('cache-control', 'no-store');
    return { client: dto(await load(cur.id, p)), clientId: cur.client_id, clientSecret: secret, secretShownOnce: true };
  });
}
