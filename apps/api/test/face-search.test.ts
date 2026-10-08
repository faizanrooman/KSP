/** Tender §20: repository-wide suspect (face) search — API contract, authorisation and visibility filtering. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { Agent, closeApp, getApp, login } from './helpers.js';
import { evidenceTestSetup, evidenceTestTeardown, userId } from './evidence-setup.js';
import { createRegisteredEvidence } from './fixtures/evidence.js';
import { fetchAndRegisterModels } from '../../ai-worker/src/models/manifest.js';

// 1×1 PNG and a JPEG header-only blob (sniffing happens in the API; inference happens in the worker)
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

beforeAll(async () => {
  await evidenceTestSetup();
  // Register the pinned models from the local cache (as ai.test does, so suites agree on the ACTIVE versions); the API
  // only needs an ACTIVE FACE_RECOGNITION registration, so fall back to a synthetic row when the cache is absent.
  const app = await getApp();
  await fetchAndRegisterModels(app.db).catch(() => undefined);
  if (!(await app.db.selectFrom('ai_models').select('id').where('task', '=', 'FACE_RECOGNITION').where('status', '=', 'ACTIVE').executeTakeFirst())) {
    await app.db.insertInto('ai_models').values({ code: `fs-test-${randomUUID().slice(0, 6)}`, name: 'Synthetic SFace', task: 'FACE_RECOGNITION', version: '1', artifact_uri: 'file:///dev/null', status: 'ACTIVE' } as never).execute();
  }
});
afterAll(async () => {
  await evidenceTestTeardown();
  await closeApp();
});

describe('face search API', () => {
  it('requires authentication and the ai:request permission', async () => {
    const app = await getApp();
    expect((await new Agent(app).post('/api/v1/ai/face-searches', { imageBase64: PNG_1PX })).status).toBe(401);
    const ravi = await login('fo.ravi'); // FIELD_OFFICER has no ai:request
    expect((await ravi.post('/api/v1/ai/face-searches', { imageBase64: PNG_1PX })).status).toBe(403);
    expect((await ravi.get('/api/v1/ai/face-searches')).status).toBe(403);
  });

  it('stores the probe in the derived bucket, queues the search, audits it, and rejects non-images', async () => {
    const app = await getApp();
    const meera = await login('io.meera');
    const bad = await meera.post('/api/v1/ai/face-searches', { imageBase64: Buffer.from('not an image at all, really').toString('base64') });
    expect(bad.status).toBe(400);
    const r = await meera.post('/api/v1/ai/face-searches', { imageBase64: `data:image/png;base64,${PNG_1PX}`, threshold: 0.5 });
    expect(r.status).toBe(202);
    const row = await app.db.selectFrom('face_searches').selectAll().where('id', '=', r.body.id).executeTakeFirstOrThrow();
    expect(row.status).toBe('QUEUED');
    expect(row.probe_key).toBe(`ai/face-searches/${row.id}/probe.png`);
    await app.storage.s3.send(new HeadObjectCommand({ Bucket: app.storage.bucket('derived'), Key: row.probe_key }));
    const audit = await app.db.selectFrom('audit_events').select('action').where('resource_id', '=', r.body.id).execute();
    expect(audit.map((a) => a.action)).toContain('AI_FACE_SEARCH_REQUESTED');
    // extra fields are refused (.strict) and the search is private to the requester
    expect((await meera.post('/api/v1/ai/face-searches', { imageBase64: PNG_1PX, requestedBy: 'x' })).status).toBe(400);
    const arjun = await login('io.arjun');
    expect((await arjun.get(`/api/v1/ai/face-searches/${r.body.id}`)).status).toBe(404);
    expect((await arjun.get(`/api/v1/ai/face-searches/${r.body.id}/probe`)).status).toBe(404);
    expect((await meera.get(`/api/v1/ai/face-searches/${r.body.id}`)).status).toBe(200);
  });

  it('returns only matches on evidence the requester may see and counts the rest as hidden', async () => {
    const app = await getApp();
    const meera = await login('io.meera');
    const meeraId = await userId('io.meera');
    const arjunId = await userId('io.arjun');
    const visible = await createRegisteredEvidence({ orgCode: 'ps_cubbonpark', uploadedBy: meeraId });
    const hidden = await createRegisteredEvidence({ orgCode: 'ps_indiranagar', uploadedBy: arjunId });
    const model = await app.db.selectFrom('ai_models').select(['id', 'code', 'version']).where('task', '=', 'FACE_RECOGNITION').where('status', '=', 'ACTIVE').executeTakeFirstOrThrow();
    const mkJob = (evidenceId: string) =>
      app.db.insertInto('ai_jobs').values({ evidence_id: evidenceId, requested_by: meeraId, tasks: ['FACE_RECOGNITION'], input: '{}', params: '{}', model_ids: [model.id], status: 'COMPLETED' }).returning('id').executeTakeFirstOrThrow();
    const mkDet = async (evidenceId: string) => {
      const job = await mkJob(evidenceId);
      return (
        await app.db
          .insertInto('ai_detections')
          .values({ job_id: job.id, evidence_id: evidenceId, model_id: model.id, model_code: model.code, model_version: model.version, task: 'FACE_RECOGNITION', label: 'face', confidence: 0.9, threshold: 0.5, frame_time_ms: 4000, attributes: '{}' })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    };
    const dVisible = await mkDet(visible.id);
    const dHidden = await mkDet(hidden.id);
    const fs = await app.db
      .insertInto('face_searches')
      .values({
        requested_by: meeraId, org_unit_id: visible.orgUnitId, probe_key: `ai/face-searches/${randomUUID()}/probe.png`, status: 'COMPLETED', model_id: model.id,
        result: JSON.stringify([{ detectionId: dHidden, evidenceId: hidden.id, similarity: 0.95, frameTimeMs: 4000 }, { detectionId: dVisible, evidenceId: visible.id, similarity: 0.81, frameTimeMs: 4000 }]),
        stats: JSON.stringify({ candidates: 2, scanMs: 3 }), finished_at: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const r = await meera.get(`/api/v1/ai/face-searches/${fs.id}`);
    expect(r.status).toBe(200);
    expect(r.body.matches.map((m: { evidenceId: string }) => m.evidenceId)).toEqual([visible.id]);
    expect(r.body.hiddenMatches).toBe(1);
    expect(r.body.matches[0].evidenceNumber).toBe(visible.evidenceNumber);
    expect(JSON.stringify(r.body)).not.toContain(hidden.id);
    const audit = await app.db.selectFrom('audit_events').select('details').where('resource_id', '=', fs.id).where('action', '=', 'AI_FACE_SEARCH_VIEWED').executeTakeFirst();
    expect(audit?.details).toMatchObject({ visibleMatches: 1, hiddenMatches: 1 });
  });
});
