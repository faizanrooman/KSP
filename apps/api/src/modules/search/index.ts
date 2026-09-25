/**
 * Advanced search & discovery (spec module 10). Permission `search:use`; results are ALWAYS restricted by
 * evidenceVisibleSql (jurisdiction, own, case membership, shares). See docs/SEARCH.md.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { appendAudit } from '@ksp/core';
import { loadEvidenceFor } from '../../lib/access.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import type { Principal } from '../../lib/principal.js';
import { auditCriteria, criteriaObject, criteriaSchema, refineCriteria } from './criteria.js';
import { runSearch, SEARCH_SORTS } from './service.js';
import { relatedEvidence } from './related.js';

export const prefix = '/search';

const searchBody = criteriaObject
  .extend({
    sort: z.enum(SEARCH_SORTS).optional(),
    page: z.number().int().min(1).max(10_000).default(1),
    pageSize: z.number().int().min(1).max(200).default(25),
    includeFacets: z.boolean().default(true),
  })
  .strict()
  .superRefine(refineCriteria);

const savedBody = z.object({ name: z.string().trim().min(1).max(120), criteria: criteriaSchema }).strict();
const idParams = z.object({ id: z.string().uuid() });

/** Saved searches belong to a user account (API clients have none). */
function ownerId(p: Principal): string {
  if (!p.userId) throw forbidden('Saved searches require a user account');
  return p.userId;
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';
}

export default async function search(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const guard = app.authorize('search:use');

  app.post(
    '/evidence',
    { preValidation: guard, schema: { tags: ['search'], summary: 'Permission-aware advanced evidence search (text, metadata, location, case/FIR, AI-derived) with facets', body: searchBody } },
    async (req) => {
      const p = req.requirePrincipal();
      const { sort, page, pageSize, includeFacets, ...criteria } = req.body;
      const result = await runSearch(app.db, p, criteria, { sort, page, pageSize, includeFacets });
      await appendAudit(app.db, req.actor(), {
        action: 'SEARCH_PERFORMED',
        resourceType: 'evidence_search',
        details: { criteria: auditCriteria(criteria), resultCount: result.total, page, pageSize, sort: result.sort, unreviewedAi: result.includesUnreviewedAi },
      });
      return result;
    },
  );

  app.get(
    '/evidence/:id/related',
    { preValidation: guard, schema: { tags: ['search'], summary: 'Related-evidence suggestions (same case / officer / device / place & time / approved AI hits / explicit relations) — visible items only', params: idParams } },
    async (req) => {
      const p = req.requirePrincipal();
      const ev = await loadEvidenceFor(app.db, p, req.params.id, 'evidence:read', req.actor());
      const result = await relatedEvidence(app.db, p, ev.id);
      await appendAudit(app.db, req.actor(), {
        action: 'SEARCH_PERFORMED',
        resourceType: 'evidence_search',
        details: { kind: 'related', sourceEvidenceId: ev.id, resultCount: result.total },
      });
      return result;
    },
  );

  app.get('/saved', { preValidation: guard, schema: { tags: ['search'], summary: 'My saved searches' } }, async (req) => {
    const p = req.requirePrincipal();
    const rows = await app.db.selectFrom('saved_searches').select(['id', 'name', 'criteria', 'created_at', 'updated_at']).where('user_id', '=', ownerId(p)).orderBy('name').execute();
    return { items: rows.map((r) => ({ id: r.id, name: r.name, criteria: r.criteria, createdAt: r.created_at, updatedAt: r.updated_at })) };
  });

  app.post('/saved', { preValidation: guard, schema: { tags: ['search'], summary: 'Save a search (criteria are validated like POST /search/evidence)', body: savedBody } }, async (req, reply) => {
    const p = req.requirePrincipal();
    try {
      const row = await app.db.transaction().execute(async (tx) => {
        const r = await tx
          .insertInto('saved_searches')
          .values({ user_id: ownerId(p), name: req.body.name, criteria: JSON.stringify(req.body.criteria) })
          .returning(['id', 'name', 'criteria', 'created_at', 'updated_at'])
          .executeTakeFirstOrThrow();
        await appendAudit(tx, req.actor(), { action: 'SAVED_SEARCH_CHANGED', resourceType: 'saved_search', resourceId: r.id, details: { op: 'created', name: r.name } });
        return r;
      });
      return reply.status(201).send({ id: row.id, name: row.name, criteria: row.criteria, createdAt: row.created_at, updatedAt: row.updated_at });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('You already have a saved search with this name');
      throw e;
    }
  });

  app.delete('/saved/:id', { preValidation: guard, schema: { tags: ['search'], summary: 'Delete one of my saved searches', params: idParams } }, async (req, reply) => {
    const p = req.requirePrincipal();
    await app.db.transaction().execute(async (tx) => {
      const r = await tx.deleteFrom('saved_searches').where('id', '=', req.params.id).where('user_id', '=', ownerId(p)).returning(['id', 'name']).executeTakeFirst();
      if (!r) throw notFound('Saved search');
      await appendAudit(tx, req.actor(), { action: 'SAVED_SEARCH_CHANGED', resourceType: 'saved_search', resourceId: r.id, details: { op: 'deleted', name: r.name } });
    });
    return reply.status(204).send();
  });
}
