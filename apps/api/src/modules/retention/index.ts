/**
 * Retention policies (spec module 6). Exactly one default policy; a policy in use cannot be deleted.
 * Changing a policy's retention period recomputes retain_until for all live evidence under it.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';
import { appendAudit, isUniqueViolation, type Tx } from '@ksp/core';
import { hasPermission } from '../../lib/principal.js';
import { conflict, forbidden, notFound, validationFailed } from '../../lib/errors.js';
import { retainUntilSql } from '../evidence/lifecycle.js';

export const prefix = '/retention';

const days = z.number().int().min(0).max(36_500).nullable();
const policyFields = z.object({
  name: z.string().trim().min(3).max(120),
  description: z.string().trim().max(2000).nullable().optional(),
  retentionDays: z.number().int().min(1).max(36_500).nullable(),
  archiveAfterDays: days,
  longTermAfterDays: days,
  isDefault: z.boolean().optional(),
});
const createBody = policyFields.extend({ code: z.string().trim().regex(/^[a-z0-9_]{2,40}$/, 'lowercase letters, digits, underscore (2-40)') }).strict();
const patchBody = policyFields.partial().strict();
const idParams = z.object({ id: z.string().uuid() });

function checkOrdering(v: { retentionDays?: number | null; archiveAfterDays?: number | null; longTermAfterDays?: number | null }) {
  const { retentionDays: r, archiveAfterDays: a, longTermAfterDays: l } = v;
  if (a != null && l != null && l < a) throw validationFailed('Long-term tier must come after the archive tier');
  if (r != null && a != null && a >= r) throw validationFailed('Archive transition must happen before retention expires');
  if (r != null && l != null && l >= r) throw validationFailed('Long-term transition must happen before retention expires');
}

async function recompute(tx: Tx, policyId: string): Promise<number> {
  const res = await sql`UPDATE evidence e SET retain_until = ${retainUntilSql} FROM retention_policies rp
    WHERE rp.id = e.retention_policy_id AND rp.id = ${policyId}::uuid AND e.status NOT IN ('DISPOSED','REJECTED')
      AND e.retain_until IS DISTINCT FROM (${retainUntilSql})`.execute(tx);
  return Number(res.numAffectedRows ?? 0);
}

export default async function retention(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  const load = (id: string) =>
    app.db
      .selectFrom('retention_policies as rp')
      .select(['rp.id', 'rp.code', 'rp.name', 'rp.description', 'rp.retention_days', 'rp.archive_after_days', 'rp.long_term_after_days', 'rp.is_default', 'rp.created_at', 'rp.updated_at'])
      .select(sql<number>`(SELECT count(*) FROM evidence e WHERE e.retention_policy_id = rp.id AND e.status <> 'DISPOSED')`.as('in_use'))
      .where('rp.id', '=', id)
      .executeTakeFirst();
  type Row = NonNullable<Awaited<ReturnType<typeof load>>>;
  const dto = (r: Row) => ({
    id: r.id, code: r.code, name: r.name, description: r.description, retentionDays: r.retention_days, archiveAfterDays: r.archive_after_days,
    longTermAfterDays: r.long_term_after_days, isDefault: r.is_default, evidenceCount: Number(r.in_use), createdAt: r.created_at, updatedAt: r.updated_at,
  });

  app.get('/policies', { schema: { tags: ['retention'], summary: 'Retention policies' } }, async (req) => {
    const p = req.requirePrincipal();
    if (!['retention:manage', 'evidence:read', 'evidence:dispose_request', 'evidence:dispose_approve'].some((x) => hasPermission(p, x as never))) throw forbidden();
    const rows = await app.db
      .selectFrom('retention_policies as rp')
      .select(['rp.id', 'rp.code', 'rp.name', 'rp.description', 'rp.retention_days', 'rp.archive_after_days', 'rp.long_term_after_days', 'rp.is_default', 'rp.created_at', 'rp.updated_at'])
      .select(sql<number>`(SELECT count(*) FROM evidence e WHERE e.retention_policy_id = rp.id AND e.status <> 'DISPOSED')`.as('in_use'))
      .orderBy('rp.is_default', 'desc')
      .orderBy('rp.name')
      .execute();
    return { items: rows.map(dto) };
  });

  app.post('/policies', { preHandler: app.authorize('retention:manage'), schema: { tags: ['retention'], summary: 'Create a retention policy', body: createBody } }, async (req, reply) => {
    const b = req.body;
    checkOrdering(b);
    let id: string;
    try {
      id = await app.db.transaction().execute(async (tx) => {
        if (b.isDefault) await tx.updateTable('retention_policies').set({ is_default: false }).where('is_default', '=', true).execute();
        const row = await tx
          .insertInto('retention_policies')
          .values({ code: b.code, name: b.name, description: b.description ?? null, retention_days: b.retentionDays, archive_after_days: b.archiveAfterDays, long_term_after_days: b.longTermAfterDays, is_default: !!b.isDefault })
          .returning('id')
          .executeTakeFirstOrThrow();
        await appendAudit(tx, req.actor(), { action: 'RETENTION_POLICY_CHANGED', resourceType: 'retention_policy', resourceId: row.id, details: { op: 'create', after: b } });
        return row.id;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('A policy with this code already exists');
      throw err;
    }
    return reply.status(201).send(dto((await load(id))!));
  });

  app.patch('/policies/:id', { preHandler: app.authorize('retention:manage'), schema: { tags: ['retention'], summary: 'Update a retention policy (recomputes retain-until of evidence under it)', params: idParams, body: patchBody } }, async (req) => {
    const b = req.body;
    const cur = await load(req.params.id);
    if (!cur) throw notFound('Retention policy');
    if (b.isDefault === false && cur.is_default) throw conflict('Make another policy the default instead of unsetting the default');
    const merged = {
      retentionDays: b.retentionDays !== undefined ? b.retentionDays : cur.retention_days,
      archiveAfterDays: b.archiveAfterDays !== undefined ? b.archiveAfterDays : cur.archive_after_days,
      longTermAfterDays: b.longTermAfterDays !== undefined ? b.longTermAfterDays : cur.long_term_after_days,
    };
    checkOrdering(merged);
    await app.db.transaction().execute(async (tx) => {
      if (b.isDefault && !cur.is_default) await tx.updateTable('retention_policies').set({ is_default: false }).where('is_default', '=', true).execute();
      const set: Record<string, unknown> = {};
      if (b.name !== undefined) set.name = b.name;
      if (b.description !== undefined) set.description = b.description;
      if (b.retentionDays !== undefined) set.retention_days = b.retentionDays;
      if (b.archiveAfterDays !== undefined) set.archive_after_days = b.archiveAfterDays;
      if (b.longTermAfterDays !== undefined) set.long_term_after_days = b.longTermAfterDays;
      if (b.isDefault) set.is_default = true;
      if (Object.keys(set).length) await tx.updateTable('retention_policies').set(set).where('id', '=', cur.id).execute();
      const affected = b.retentionDays !== undefined && b.retentionDays !== cur.retention_days ? await recompute(tx, cur.id) : 0;
      await appendAudit(tx, req.actor(), {
        action: 'RETENTION_POLICY_CHANGED', resourceType: 'retention_policy', resourceId: cur.id,
        details: { op: 'update', before: { name: cur.name, retentionDays: cur.retention_days, archiveAfterDays: cur.archive_after_days, longTermAfterDays: cur.long_term_after_days, isDefault: cur.is_default }, changes: b, evidenceRecomputed: affected },
      });
    });
    return dto((await load(cur.id))!);
  });

  app.delete('/policies/:id', { preHandler: app.authorize('retention:manage'), schema: { tags: ['retention'], summary: 'Delete an unused, non-default retention policy', params: idParams } }, async (req, reply) => {
    const cur = await load(req.params.id);
    if (!cur) throw notFound('Retention policy');
    if (cur.is_default) throw conflict('The default policy cannot be deleted');
    const used = await app.db.selectFrom('evidence').select('id').where('retention_policy_id', '=', cur.id).limit(1).executeTakeFirst();
    if (used) throw conflict('Policy is assigned to evidence and cannot be deleted');
    await app.db.transaction().execute(async (tx) => {
      await tx.deleteFrom('retention_policies').where('id', '=', cur.id).execute();
      await appendAudit(tx, req.actor(), { action: 'RETENTION_POLICY_CHANGED', resourceType: 'retention_policy', resourceId: cur.id, details: { op: 'delete', code: cur.code, name: cur.name } });
    });
    return reply.status(204).send();
  });
}
