/**
 * Training dataset exports (ai:models_manage). Reviewed detections (APPROVED + label corrections as positives,
 * REJECTED as negatives) from evidence inside the requester's ai:models_manage jurisdiction are written by the
 * worker (queue ai.training_export) to the reports bucket under ai-training/<exportId>/.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { appendAudit, enqueue } from '@ksp/core';
import { AI_TASKS, QUEUES, type AiTrainingExportPayload } from '@ksp/shared';
import { scopePaths } from '../../lib/principal.js';
import { notFound, unprocessable, AppError } from '../../lib/errors.js';
import { sendObject } from '../media/stream.js';

const idParams = z.object({ id: z.string().uuid() });
const FILE_RE = /^(manifest\.json|dataset\.jsonl|coco\.json|crops\/[0-9a-f-]{36}\.jpg)$/;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dto = (r: any) => ({
  id: r.id, task: r.task, modelId: r.model_id, filter: r.filter, sampleCount: r.sample_count, status: r.status, error: r.error,
  createdBy: { id: r.created_by, fullName: r.creator_name }, createdAt: new Date(r.created_at).toISOString(), finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
  files: r.status === 'COMPLETED' ? ['manifest.json', 'dataset.jsonl', 'coco.json'] : [],
});

export default async function trainingRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const guard = app.authorize('ai:models_manage');
  const base = () => app.db.selectFrom('ai_training_exports as t').innerJoin('users as u', 'u.id', 't.created_by').selectAll('t').select('u.full_name as creator_name');

  app.post('/training-exports', {
    preHandler: guard,
    schema: {
      tags: ['ai'], summary: 'Export reviewed detections as a labelled training dataset',
      body: z.object({ task: z.enum(AI_TASKS), modelId: z.string().uuid().optional(), from: z.coerce.date(), to: z.coerce.date() }),
    },
  }, async (req, reply) => {
    const p = req.requirePrincipal();
    const b = req.body;
    if (b.to <= b.from) throw unprocessable('"to" must be after "from"');
    if (b.modelId) {
      const m = await app.db.selectFrom('ai_models').select(['id', 'task']).where('id', '=', b.modelId).executeTakeFirst();
      if (!m || m.task !== b.task) throw unprocessable('modelId does not exist for this task');
    }
    const paths = scopePaths(p, 'ai:models_manage');
    const row = await app.db.transaction().execute(async (tx) => {
      const r = await tx.insertInto('ai_training_exports').values({
        task: b.task, model_id: b.modelId ?? null, created_by: p.userId!,
        filter: JSON.stringify({ from: b.from.toISOString(), to: b.to.toISOString(), orgPaths: paths }),
      }).returning('id').executeTakeFirstOrThrow();
      await appendAudit(tx, req.actor(), { action: 'AI_TRAINING_EXPORT_REQUESTED', resourceType: 'ai_training_export', resourceId: r.id, details: { task: b.task, modelId: b.modelId, from: b.from, to: b.to } });
      return r;
    });
    await enqueue<AiTrainingExportPayload>(QUEUES.AI_TRAINING_EXPORT, { trainingExportId: row.id }, { singletonKey: row.id });
    return reply.status(202).send(dto(await base().where('t.id', '=', row.id).executeTakeFirstOrThrow()));
  });

  app.get('/training-exports', { preHandler: guard, schema: { tags: ['ai'], summary: 'Training dataset exports' } }, async (req) => {
    const p = req.requirePrincipal();
    const rows = await base().where('t.created_by', '=', p.userId ?? '00000000-0000-0000-0000-000000000000').orderBy('t.created_at', 'desc').limit(100).execute();
    return { items: rows.map(dto) };
  });

  app.get('/training-exports/:id', { preHandler: guard, schema: { tags: ['ai'], summary: 'Training export status', params: idParams } }, async (req) => {
    const r = await base().where('t.id', '=', req.params.id).where('t.created_by', '=', req.requirePrincipal().userId ?? '').executeTakeFirst();
    if (!r) throw notFound('Training export');
    return dto(r);
  });

  app.get('/training-exports/:id/files/*', {
    preHandler: guard,
    schema: { tags: ['ai'], summary: 'Download a file of a completed training export', params: idParams.extend({ '*': z.string().max(200) }) },
  }, async (req, reply) => {
    const r = await app.db.selectFrom('ai_training_exports').selectAll().where('id', '=', req.params.id).where('created_by', '=', req.requirePrincipal().userId ?? '').executeTakeFirst();
    if (!r) throw notFound('Training export');
    if (r.status !== 'COMPLETED' || !r.bucket || !r.object_key) throw new AppError(409, 'NOT_READY', 'Export is not complete');
    const file = req.params['*'];
    if (!FILE_RE.test(file)) throw notFound('File');
    const type = file.endsWith('.jpg') ? 'image/jpeg' : file.endsWith('.jsonl') ? 'application/x-ndjson' : 'application/json';
    return sendObject(app.storage, req, reply, { bucket: r.bucket, key: `${r.object_key}${file}`, contentType: type }, { 'Content-Disposition': `attachment; filename="${r.id.slice(0, 8)}_${file.replace('/', '_')}"` });
  });
}
