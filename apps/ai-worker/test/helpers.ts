import { createDb, loadConfig, sql, type Database } from '@ksp/core';
import type { AiJobInput, AiJobParams, AiTask } from '@ksp/shared';
import { createRegisteredEvidence } from '../../api/test/fixtures/evidence.js';
import { createAiContext } from '../src/main.js';
import { attachProxy } from './media.js';

let app: { db: Database } | undefined;
/** Application-role connection (what the API uses) — for arranging fixtures only. */
export function appDb(): Database {
  return (app ??= createDb(loadConfig().DATABASE_URL, 4)).db;
}
let ai: ReturnType<typeof createAiContext> | undefined;
/** The isolated worker context (ksp_ai). */
export function aiCtx() {
  return (ai ??= createAiContext());
}
export async function closeAll() {
  await ai?.destroy();
  await app?.db.destroy();
  ai = undefined;
  app = undefined;
}

export async function userId(username: string): Promise<string> {
  return (await appDb().selectFrom('users').select('id').where('username', '=', username).executeTakeFirstOrThrow()).id;
}

export async function evidenceWithProxy(video: string, orgCode = 'ps_cubbonpark') {
  const uploader = await userId('io.meera');
  const ev = await createRegisteredEvidence({ orgCode, uploadedBy: uploader, db: appDb() });
  const proxy = await attachProxy(appDb(), ev.id, video);
  return { ...ev, proxyKey: proxy.key, uploader };
}

/** Insert a job exactly as POST /ai/evidence/:id/jobs does (ACTIVE models incl. dependencies, input snapshot). */
export async function queueJob(ev: { id: string; orgUnitId: string; proxyKey: string }, tasks: AiTask[], params: Partial<AiJobParams> = {}, inputOverride: Partial<AiJobInput> = {}) {
  const db = appDb();
  const active = await db.selectFrom('ai_models').select(['id', 'task']).where('status', '=', 'ACTIVE').execute();
  const need = new Set<AiTask>(tasks);
  if (need.has('FACE_RECOGNITION')) need.add('FACE_DETECTION');
  if (need.has('CLASSIFICATION')) need.add('OBJECT_DETECTION');
  const ids = active.filter((m) => need.has(m.task as AiTask)).map((m) => m.id);
  const input: AiJobInput = { derivativeBucket: loadConfig().S3_BUCKET_DERIVED, derivativeKey: ev.proxyKey, durationMs: null, frameRate: 25, width: 1280, height: 720, orgUnitId: ev.orgUnitId, ...inputOverride };
  const full: AiJobParams = { sampleFps: 1, thresholds: {}, watchlistIds: [], keepEveryMs: 10_000, crowdMinPersons: 8, ...params };
  const j = await db.insertInto('ai_jobs').values({ evidence_id: ev.id, requested_by: await userId('io.meera'), tasks, input: JSON.stringify(input), params: JSON.stringify(full), model_ids: ids }).returning('id').executeTakeFirstOrThrow();
  return j.id;
}

export async function auditFor(resourceId: string) {
  const { rows } = await sql<{ action: string; actor_type: string; actor_id: string; evidence_id: string | null; outcome: string; details: Record<string, unknown> }>`
    SELECT action, actor_type, actor_id, evidence_id, outcome, details FROM audit_events WHERE resource_id = ${resourceId} ORDER BY seq`.execute(appDb());
  return rows;
}
