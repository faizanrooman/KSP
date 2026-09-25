/**
 * Watchlists (ai:watchlist_manage, org-scoped: a list belongs to an org unit and applies to evidence in its subtree).
 * FACE entries carry a reference image (stored in the derived bucket under ai/watchlists/<listId>/<entryId>.<ext>);
 * the isolated ai-worker computes the embedding. VEHICLE entries carry a plate (normalised A-Z0-9).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { appendAudit, sha256Hex } from '@ksp/core';
import { normalizePlate } from '@ksp/shared';
import { orgScopeSql } from '../../lib/access.js';
import { hasPermissionAt } from '../../lib/principal.js';
import { notFound, unprocessable, validationFailed } from '../../lib/errors.js';
import { sendObject } from '../media/stream.js';
import { notifyAiWorker } from './common.js';

const idParams = z.object({ id: z.string().uuid() });
const entryParams = z.object({ id: z.string().uuid(), entryId: z.string().uuid() });
export const MAX_REFERENCE_IMAGE_BYTES = 2 * 1024 * 1024;

function sniffImage(buf: Buffer): { ext: 'jpg' | 'png'; mime: string } | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', mime: 'image/png' };
  return null;
}

export default async function watchlistRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const guard = app.authorize('ai:watchlist_manage');

  const loadList = async (req: FastifyRequest, id: string) => {
    const p = req.requirePrincipal();
    const w = await app.db.selectFrom('ai_watchlists as w').innerJoin('org_units as ou', 'ou.id', 'w.org_unit_id')
      .select(['w.id', 'w.name', 'w.kind', 'w.org_unit_id', 'w.description', 'w.created_at', 'ou.name as org_name', 'ou.path'])
      .where('w.id', '=', id).where(orgScopeSql(p, 'ai:watchlist_manage', 'ou.path')).executeTakeFirst();
    if (!w) throw notFound('Watchlist');
    return w;
  };

  const entryDto = (listId: string) => (e: { id: string; label: string; plate_normalized: string | null; notes: string | null; image_key: string | null; embedding_ready: unknown; embedding_error: string | null; embedded_at: Date | null; created_at: Date; model_code: string | null; model_version: string | null }) => ({
    id: e.id, label: e.label, plate: e.plate_normalized, notes: e.notes, hasImage: !!e.image_key,
    imageUrl: e.image_key ? `/api/v1/ai/watchlists/${listId}/entries/${e.id}/image` : null,
    embeddingStatus: e.embedding_ready ? 'READY' : e.embedding_error ? 'FAILED' : e.image_key ? 'PENDING' : 'N/A',
    embeddingError: e.embedding_error, embeddedAt: e.embedded_at?.toISOString() ?? null,
    model: e.model_code ? { code: e.model_code, version: e.model_version } : null, createdAt: e.created_at.toISOString(),
  });

  app.get('/watchlists', {
    preHandler: guard,
    schema: { tags: ['ai'], summary: 'Watchlists in your jurisdiction', querystring: z.object({ kind: z.enum(['FACE', 'VEHICLE']).optional() }) },
  }, async (req) => {
    const p = req.requirePrincipal();
    let q = app.db.selectFrom('ai_watchlists as w').innerJoin('org_units as ou', 'ou.id', 'w.org_unit_id')
      .select((eb) => ['w.id', 'w.name', 'w.kind', 'w.org_unit_id', 'w.description', 'w.created_at', 'ou.name as org_name',
        eb.selectFrom('ai_watchlist_entries as x').select(eb.fn.countAll<number>().as('n')).whereRef('x.watchlist_id', '=', 'w.id').as('entries')])
      .where(orgScopeSql(p, 'ai:watchlist_manage', 'ou.path'));
    if (req.query.kind) q = q.where('w.kind', '=', req.query.kind);
    const rows = await q.orderBy('w.name').execute();
    return { items: rows.map((w) => ({ id: w.id, name: w.name, kind: w.kind, orgUnit: { id: w.org_unit_id, name: w.org_name }, description: w.description, entries: Number(w.entries ?? 0), createdAt: w.created_at.toISOString() })) };
  });

  app.post('/watchlists', {
    preHandler: guard,
    schema: { tags: ['ai'], summary: 'Create a watchlist', body: z.object({ name: z.string().trim().min(2).max(200), kind: z.enum(['FACE', 'VEHICLE']), orgUnitId: z.string().uuid(), description: z.string().max(2000).optional() }) },
  }, async (req, reply) => {
    const p = req.requirePrincipal();
    const ou = await app.db.selectFrom('org_units').select(['id', 'path']).where('id', '=', req.body.orgUnitId).executeTakeFirst();
    if (!ou || !hasPermissionAt(p, 'ai:watchlist_manage', ou.path)) throw notFound('Org unit');
    const w = await app.db.transaction().execute(async (tx) => {
      const r = await tx.insertInto('ai_watchlists').values({ name: req.body.name, kind: req.body.kind, org_unit_id: ou.id, description: req.body.description ?? null, created_by: p.userId }).returningAll().executeTakeFirstOrThrow();
      await appendAudit(tx, req.actor(), { action: 'AI_WATCHLIST_CHANGED', resourceType: 'ai_watchlist', resourceId: r.id, orgUnitId: ou.id, details: { op: 'CREATE', name: r.name, kind: r.kind } });
      return r;
    });
    return reply.status(201).send({ id: w.id, name: w.name, kind: w.kind, orgUnitId: w.org_unit_id, description: w.description });
  });

  app.get('/watchlists/:id', {
    preHandler: guard,
    schema: { tags: ['ai'], summary: 'Watchlist with entries (embeddings are never returned)', params: idParams },
  }, async (req) => {
    const w = await loadList(req, req.params.id);
    const entries = await app.db.selectFrom('ai_watchlist_entries as e').leftJoin('ai_models as m', 'm.id', 'e.model_id')
      .select((eb) => ['e.id', 'e.label', 'e.plate_normalized', 'e.notes', 'e.image_key', 'e.embedding_error', 'e.embedded_at', 'e.created_at', 'm.code as model_code', 'm.version as model_version',
        eb('e.embedding', 'is not', null).as('embedding_ready')])
      .where('e.watchlist_id', '=', w.id).orderBy('e.label').execute();
    return { id: w.id, name: w.name, kind: w.kind, orgUnit: { id: w.org_unit_id, name: w.org_name }, description: w.description, createdAt: w.created_at.toISOString(), entries: entries.map(entryDto(w.id)) };
  });

  app.patch('/watchlists/:id', {
    preHandler: guard,
    schema: { tags: ['ai'], summary: 'Rename / describe a watchlist', params: idParams, body: z.object({ name: z.string().trim().min(2).max(200).optional(), description: z.string().max(2000).nullable().optional() }) },
  }, async (req) => {
    const w = await loadList(req, req.params.id);
    await app.db.transaction().execute(async (tx) => {
      await tx.updateTable('ai_watchlists').set({ ...(req.body.name ? { name: req.body.name } : {}), ...(req.body.description !== undefined ? { description: req.body.description } : {}) }).where('id', '=', w.id).execute();
      await appendAudit(tx, req.actor(), { action: 'AI_WATCHLIST_CHANGED', resourceType: 'ai_watchlist', resourceId: w.id, orgUnitId: w.org_unit_id, details: { op: 'UPDATE', changed: Object.keys(req.body) } });
    });
    return { ok: true };
  });

  app.delete('/watchlists/:id', {
    preHandler: guard,
    schema: { tags: ['ai'], summary: 'Delete a watchlist and its entries', params: idParams },
  }, async (req) => {
    const w = await loadList(req, req.params.id);
    const keys = await app.db.selectFrom('ai_watchlist_entries').select('image_key').where('watchlist_id', '=', w.id).where('image_key', 'is not', null).execute();
    await app.db.transaction().execute(async (tx) => {
      const n = await tx.deleteFrom('ai_watchlist_entries').where('watchlist_id', '=', w.id).executeTakeFirst();
      await tx.deleteFrom('ai_watchlists').where('id', '=', w.id).execute();
      await appendAudit(tx, req.actor(), { action: 'AI_WATCHLIST_CHANGED', resourceType: 'ai_watchlist', resourceId: w.id, orgUnitId: w.org_unit_id, details: { op: 'DELETE', name: w.name, entries: Number(n.numDeletedRows) } });
    });
    for (const k of keys) await app.storage.delete(app.storage.bucket('derived'), k.image_key!).catch(() => undefined);
    return { ok: true };
  });

  app.post('/watchlists/:id/entries', {
    preHandler: guard,
    bodyLimit: 4 * 1024 * 1024,
    schema: {
      tags: ['ai'], summary: 'Add a watchlist entry (FACE: reference image base64; VEHICLE: plate)', params: idParams,
      body: z.object({ label: z.string().trim().min(1).max(200), notes: z.string().max(2000).optional(), plate: z.string().max(20).optional(), imageBase64: z.string().max(3 * 1024 * 1024).optional() }),
    },
  }, async (req, reply) => {
    const p = req.requirePrincipal();
    const w = await loadList(req, req.params.id);
    const b = req.body;
    let plate: string | null = null;
    let image: { buf: Buffer; ext: string; mime: string } | null = null;
    if (w.kind === 'VEHICLE') {
      plate = normalizePlate(b.plate ?? '');
      if (plate.length < 2 || plate.length > 12) throw validationFailed('VEHICLE entries need a plate of 2-12 letters/digits');
    } else {
      if (!b.imageBase64) throw validationFailed('FACE entries need a reference image (imageBase64)');
      const buf = Buffer.from(b.imageBase64.replace(/^data:image\/[a-z]+;base64,/, ''), 'base64');
      if (buf.length > MAX_REFERENCE_IMAGE_BYTES) throw unprocessable(`Reference image exceeds ${MAX_REFERENCE_IMAGE_BYTES} bytes`);
      const kind = sniffImage(buf);
      if (!kind) throw unprocessable('Reference image must be JPEG or PNG');
      image = { buf, ...kind };
    }
    const entry = await app.db.transaction().execute(async (tx) => {
      const e = await tx.insertInto('ai_watchlist_entries').values({ watchlist_id: w.id, label: b.label, plate_normalized: plate, notes: b.notes ?? null, created_by: p.userId }).returning(['id', 'created_at']).executeTakeFirstOrThrow();
      let imageKey: string | null = null;
      if (image) {
        imageKey = `ai/watchlists/${w.id}/${e.id}.${image.ext}`;
        await app.storage.put(app.storage.bucket('derived'), imageKey, image.buf, { contentType: image.mime, metadata: { 'watchlist-entry': e.id } });
        await tx.updateTable('ai_watchlist_entries').set({ image_key: imageKey }).where('id', '=', e.id).execute();
      }
      await appendAudit(tx, req.actor(), {
        action: 'AI_WATCHLIST_CHANGED', resourceType: 'ai_watchlist_entry', resourceId: e.id, orgUnitId: w.org_unit_id,
        details: { op: 'ADD_ENTRY', watchlistId: w.id, kind: w.kind, imageSha256: image ? sha256Hex(image.buf) : undefined },
      });
      if (image) await notifyAiWorker(tx, 'watchlist');
      return { id: e.id, imageKey };
    });
    return reply.status(201).send({ id: entry.id, label: b.label, plate, embeddingStatus: image ? 'PENDING' : 'N/A' });
  });

  app.delete('/watchlists/:id/entries/:entryId', {
    preHandler: guard,
    schema: { tags: ['ai'], summary: 'Remove a watchlist entry', params: entryParams },
  }, async (req) => {
    const w = await loadList(req, req.params.id);
    const e = await app.db.selectFrom('ai_watchlist_entries').select(['id', 'image_key', 'label']).where('id', '=', req.params.entryId).where('watchlist_id', '=', w.id).executeTakeFirst();
    if (!e) throw notFound('Watchlist entry');
    await app.db.transaction().execute(async (tx) => {
      await tx.deleteFrom('ai_watchlist_entries').where('id', '=', e.id).execute();
      await appendAudit(tx, req.actor(), { action: 'AI_WATCHLIST_CHANGED', resourceType: 'ai_watchlist_entry', resourceId: e.id, orgUnitId: w.org_unit_id, details: { op: 'REMOVE_ENTRY', watchlistId: w.id } });
    });
    if (e.image_key) await app.storage.delete(app.storage.bucket('derived'), e.image_key).catch(() => undefined);
    return { ok: true };
  });

  app.post('/watchlists/:id/entries/:entryId/reembed', {
    preHandler: guard,
    schema: { tags: ['ai'], summary: 'Retry embedding a FACE entry (clears a previous failure)', params: entryParams },
  }, async (req) => {
    const w = await loadList(req, req.params.id);
    const r = await app.db.updateTable('ai_watchlist_entries').set({ embedding_error: null, embedding: null, model_id: null, embedded_at: null })
      .where('id', '=', req.params.entryId).where('watchlist_id', '=', w.id).where('image_key', 'is not', null).executeTakeFirst();
    if (!Number(r.numUpdatedRows)) throw notFound('Watchlist entry');
    await appendAudit(app.db, req.actor(), { action: 'AI_WATCHLIST_CHANGED', resourceType: 'ai_watchlist_entry', resourceId: req.params.entryId, orgUnitId: w.org_unit_id, details: { op: 'REEMBED', watchlistId: w.id } });
    await notifyAiWorker(app.db, 'watchlist');
    return { ok: true };
  });

  app.get('/watchlists/:id/entries/:entryId/image', {
    preHandler: guard,
    schema: { tags: ['ai'], summary: 'Reference image of a FACE watchlist entry', params: entryParams },
  }, async (req, reply) => {
    const w = await loadList(req, req.params.id);
    const e = await app.db.selectFrom('ai_watchlist_entries').select(['image_key']).where('id', '=', req.params.entryId).where('watchlist_id', '=', w.id).executeTakeFirst();
    if (!e?.image_key) throw notFound('Image');
    return sendObject(app.storage, req, reply, { bucket: app.storage.bucket('derived'), key: e.image_key, contentType: e.image_key.endsWith('.png') ? 'image/png' : 'image/jpeg' });
  });
}
