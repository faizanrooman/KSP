/**
 * Model registry (ai:models_manage). Lifecycle: register STAGED (with evaluation metrics) -> activate (retires the
 * previous ACTIVE version of the same task+code) -> retire. The worker verifies artefact SHA-256 before loading.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';
import { appendAudit, isUniqueViolation } from '@ksp/core';
import { AI_MODEL_STATUSES, AI_TASKS } from '@ksp/shared';
import { conflict, notFound, unprocessable } from '../../lib/errors.js';
import { modelDto } from './common.js';

const idParams = z.object({ id: z.string().uuid() });
const ARTIFACT_URI = /^(models:\/\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*|builtin:[a-z0-9._/-]+)$/;
const ARCHITECTURES = ['yolox', 'yunet', 'sface', 'yolov9-plate+cct-ocr', 'rules'] as const;

const registerBody = z.object({
  code: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,62}$/),
  name: z.string().trim().min(2).max(200),
  task: z.enum(AI_TASKS),
  version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,62}$/),
  runtime: z.enum(['onnxruntime', 'rules']).default('onnxruntime'),
  artifactUri: z.string().regex(ARTIFACT_URI, 'artifactUri must be models://<file> (relative to AI_MODELS_DIR) or builtin:<id>').refine((v) => !v.includes('..'), 'no parent segments'),
  artifactSha256: z.string().regex(/^[0-9a-f]{64}$/),
  labels: z.array(z.string().min(1).max(100)).max(1000).default([]),
  defaultThreshold: z.number().min(0.01).max(0.99),
  config: z.object({ architecture: z.enum(ARCHITECTURES) }).passthrough(),
  metrics: z.record(z.unknown()).default({}),
  notes: z.string().max(4000).optional(),
});

export default async function modelRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const guard = app.authorize('ai:models_manage');

  app.get('/models', {
    preHandler: guard,
    schema: { tags: ['ai'], summary: 'List AI model versions', querystring: z.object({ task: z.enum(AI_TASKS).optional(), status: z.enum(AI_MODEL_STATUSES).optional() }) },
  }, async (req) => {
    let q = app.db.selectFrom('ai_models').selectAll();
    if (req.query.task) q = q.where('task', '=', req.query.task);
    if (req.query.status) q = q.where('status', '=', req.query.status);
    const rows = await q.orderBy('task').orderBy('code').orderBy('created_at', 'desc').execute();
    return { items: rows.map(modelDto) };
  });

  app.post('/models', {
    preHandler: guard,
    schema: { tags: ['ai'], summary: 'Register a new model version (STAGED)', body: registerBody },
  }, async (req, reply) => {
    const b = req.body;
    try {
      const row = await app.db.transaction().execute(async (tx) => {
        const r = await tx.insertInto('ai_models').values({
          code: b.code, name: b.name, task: b.task, version: b.version, runtime: b.runtime, artifact_uri: b.artifactUri, artifact_sha256: b.artifactSha256,
          labels: b.labels, default_threshold: b.defaultThreshold, config: JSON.stringify(b.config), metrics: JSON.stringify(b.metrics), notes: b.notes ?? null,
          status: 'STAGED', created_by: req.requirePrincipal().userId,
        }).returningAll().executeTakeFirstOrThrow();
        await appendAudit(tx, req.actor(), { action: 'AI_MODEL_REGISTERED', resourceType: 'ai_model', resourceId: r.id, details: { code: b.code, version: b.version, task: b.task, sha256: b.artifactSha256 } });
        return r;
      });
      return reply.status(201).send(modelDto(row));
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('A model with this code and version already exists');
      throw err;
    }
  });

  app.patch('/models/:id', {
    preHandler: guard,
    schema: {
      tags: ['ai'], summary: 'Update threshold / metrics / notes of a model version', params: idParams,
      body: z.object({ name: z.string().trim().min(2).max(200).optional(), defaultThreshold: z.number().min(0.01).max(0.99).optional(), metrics: z.record(z.unknown()).optional(), notes: z.string().max(4000).nullable().optional() }),
    },
  }, async (req) => {
    const b = req.body;
    const row = await app.db.transaction().execute(async (tx) => {
      const cur = await tx.selectFrom('ai_models').selectAll().where('id', '=', req.params.id).forUpdate().executeTakeFirst();
      if (!cur) throw notFound('Model');
      const r = await tx.updateTable('ai_models').set({
        ...(b.name !== undefined ? { name: b.name } : {}),
        ...(b.defaultThreshold !== undefined ? { default_threshold: b.defaultThreshold } : {}),
        ...(b.metrics !== undefined ? { metrics: JSON.stringify(b.metrics) } : {}),
        ...(b.notes !== undefined ? { notes: b.notes } : {}),
      }).where('id', '=', cur.id).returningAll().executeTakeFirstOrThrow();
      await appendAudit(tx, req.actor(), {
        action: 'AI_MODEL_UPDATED', resourceType: 'ai_model', resourceId: cur.id,
        details: { code: cur.code, version: cur.version, changed: Object.keys(b), previousThreshold: Number(cur.default_threshold), defaultThreshold: b.defaultThreshold },
      });
      return r;
    });
    return modelDto(row);
  });

  app.post('/models/:id/activate', {
    preHandler: guard,
    schema: { tags: ['ai'], summary: 'Activate a model version (retires the current ACTIVE version of the same task/code)', params: idParams },
  }, async (req) => {
    const row = await app.db.transaction().execute(async (tx) => {
      const cur = await tx.selectFrom('ai_models').selectAll().where('id', '=', req.params.id).forUpdate().executeTakeFirst();
      if (!cur) throw notFound('Model');
      if (cur.status === 'ACTIVE') throw conflict('Model version is already ACTIVE');
      if (!cur.artifact_sha256) throw unprocessable('Model has no artefact SHA-256');
      if (!Object.keys((cur.metrics as object) ?? {}).length) throw unprocessable('Record evaluation metrics before activating a model version');
      const { rows: retired } = await sql<{ id: string; version: string }>`
        UPDATE ai_models SET status = 'RETIRED', retired_at = now() WHERE task = ${cur.task} AND code = ${cur.code} AND status = 'ACTIVE' RETURNING id, version`.execute(tx);
      for (const r of retired) {
        await appendAudit(tx, req.actor(), { action: 'AI_MODEL_RETIRED', resourceType: 'ai_model', resourceId: r.id, details: { code: cur.code, version: r.version, supersededBy: cur.version } });
      }
      const r = await tx.updateTable('ai_models').set({ status: 'ACTIVE', activated_at: new Date(), retired_at: null }).where('id', '=', cur.id).returningAll().executeTakeFirstOrThrow();
      await appendAudit(tx, req.actor(), { action: 'AI_MODEL_ACTIVATED', resourceType: 'ai_model', resourceId: cur.id, details: { code: cur.code, version: cur.version, task: cur.task, previous: retired.map((x) => x.version) } });
      return r;
    });
    return modelDto(row);
  });

  app.post('/models/:id/retire', {
    preHandler: guard,
    schema: { tags: ['ai'], summary: 'Retire a model version', params: idParams },
  }, async (req) => {
    const row = await app.db.transaction().execute(async (tx) => {
      const cur = await tx.selectFrom('ai_models').selectAll().where('id', '=', req.params.id).forUpdate().executeTakeFirst();
      if (!cur) throw notFound('Model');
      if (cur.status === 'RETIRED') throw conflict('Model version is already RETIRED');
      const r = await tx.updateTable('ai_models').set({ status: 'RETIRED', retired_at: new Date() }).where('id', '=', cur.id).returningAll().executeTakeFirstOrThrow();
      await appendAudit(tx, req.actor(), { action: 'AI_MODEL_RETIRED', resourceType: 'ai_model', resourceId: cur.id, details: { code: cur.code, version: cur.version, task: cur.task, previousStatus: cur.status } });
      return r;
    });
    return modelDto(row);
  });
}
