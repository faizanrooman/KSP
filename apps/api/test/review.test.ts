/** /review: queue visibility, review rules (comment on reject, dual approval for face matches, finality), tags, bulk, history, audit. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';
import type { AiTask } from '@ksp/shared';
import { Agent, closeApp, createUser, login } from './helpers.js';
import { evidenceTestSetup, evidenceTestTeardown, userId } from './evidence-setup.js';
import { createRegisteredEvidence, type CreatedEvidence } from './fixtures/evidence.js';
import { fetchAndRegisterModels } from '../../ai-worker/src/models/manifest.js';

let app: FastifyInstance;
let A: CreatedEvidence; // Cubbon Park
let M: CreatedEvidence; // Mysuru
const agents: Record<string, Agent> = {};
const as = async (u: string) => (agents[u] ??= await login(u));
const R = (id: string) => `/api/v1/review/detections/${id}`;
let fa2: Agent; // second FORENSIC_ANALYST in blr_city

/** Insert detections the way the worker does (job RUNNING while inserting, then COMPLETED). */
async function detections(ev: CreatedEvidence, task: AiTask, rows: Array<{ label: string; confidence: number; attributes?: Record<string, unknown> }>): Promise<string[]> {
  const model = await app.db.selectFrom('ai_models').select(['id', 'code', 'version', 'default_threshold']).where('task', '=', task).where('status', '=', 'ACTIVE').executeTakeFirstOrThrow();
  const job = await app.db.insertInto('ai_jobs').values({
    evidence_id: ev.id, requested_by: await userId('io.meera'), tasks: [task], status: 'RUNNING', model_ids: [model.id],
    input: JSON.stringify({ derivativeBucket: 'x', derivativeKey: 'x', orgUnitId: ev.orgUnitId }),
  }).returning('id').executeTakeFirstOrThrow();
  const ids: string[] = [];
  for (const [i, r] of rows.entries()) {
    const d = await app.db.insertInto('ai_detections').values({
      job_id: job.id, evidence_id: ev.id, model_id: model.id, model_code: model.code, model_version: model.version, task, label: r.label,
      confidence: r.confidence, threshold: model.default_threshold, frame_time_ms: 1000 * i, bbox_x: 0.1, bbox_y: 0.1, bbox_w: 0.2, bbox_h: 0.3, attributes: JSON.stringify(r.attributes ?? {}),
    }).returning('id').executeTakeFirstOrThrow();
    ids.push(d.id);
  }
  await app.db.updateTable('ai_jobs').set({ status: 'COMPLETED', progress: 1 }).where('id', '=', job.id).execute();
  return ids;
}

beforeAll(async () => {
  app = await evidenceTestSetup();
  await fetchAndRegisterModels(app.db);
  A = await createRegisteredEvidence({ orgCode: 'ps_cubbonpark', uploadedBy: await userId('io.meera') });
  M = await createRegisteredEvidence({ orgCode: 'ps_nazarbad', uploadedBy: await userId('io.mysuru') });
  const u = await createUser({ role: 'FORENSIC_ANALYST', org: 'blr_city' });
  fa2 = await login(u.username, u.password);
}, 180_000);

afterAll(async () => {
  await evidenceTestTeardown();
  await closeApp();
});

describe('review queue', () => {
  it('401 / 403 / only evidence the reviewer may review; filters and sorting', async () => {
    const [p1, p2] = await detections(A, 'PERSON_DETECTION', [{ label: 'person', confidence: 0.91 }, { label: 'person', confidence: 0.52 }]);
    const [m1] = await detections(M, 'PERSON_DETECTION', [{ label: 'person', confidence: 0.8 }]);
    expect((await new Agent(app).get('/api/v1/review/queue')).status).toBe(401);
    expect((await (await as('io.meera')).get('/api/v1/review/queue')).status).toBe(403); // IO has ai:request but not ai:review
    const fa = await as('fa.naveen');
    const q = await fa.get(`/api/v1/review/queue?evidenceId=${A.id}&sort=-confidence`);
    expect(q.status).toBe(200);
    expect(q.body.items.map((x: { id: string }) => x.id)).toEqual([p1, p2]);
    expect(q.body.items[0]).toMatchObject({ evidenceNumber: A.evidenceNumber, model: { code: 'yolox-s-person' }, reviewStatus: 'PENDING', frameTimeMs: 0, reviewedByMe: false });
    expect(q.body.items[0].threshold).toBeGreaterThan(0);
    const all = await fa.get('/api/v1/review/queue?pageSize=200');
    expect(all.body.items.some((x: { id: string }) => x.id === m1)).toBe(false); // Mysuru is outside blr_city
    const lo = await fa.get(`/api/v1/review/queue?evidenceId=${A.id}&maxConfidence=0.6`);
    expect(lo.body.items.map((x: { id: string }) => x.id)).toEqual([p2]);
    // a Mysuru reviewer sees Mysuru only; 404 when acting on Bengaluru items
    const mys = await createUser({ role: 'FORENSIC_ANALYST', org: 'mysuru_dist' });
    const fm = await login(mys.username, mys.password);
    const mq = await fm.get('/api/v1/review/queue?pageSize=200');
    expect(mq.body.items.map((x: { id: string }) => x.id)).toContain(m1);
    expect(mq.body.items.map((x: { id: string }) => x.id)).not.toContain(p1);
    expect((await fm.post(R(p1), { action: 'APPROVE' })).status).toBe(404);
    expect((await fm.get(`${R(p1)}/history`)).status).toBe(404);
    expect((await (await as('io.meera')).post(R(p1), { action: 'APPROVE' })).status).toBe(403);
    expect((await new Agent(app).post(R(p1), { action: 'APPROVE' })).status).toBe(401);
    const summary = await fa.get('/api/v1/review/summary');
    expect(summary.body.total).toBeGreaterThanOrEqual(2);
  });
});

describe('review rules', () => {
  it('REJECT requires a comment; decisions are final; history and custody audit are recorded', async () => {
    const [d] = await detections(A, 'OBJECT_DETECTION', [{ label: 'knife', confidence: 0.61 }]);
    const fa = await as('fa.naveen');
    const noComment = await fa.post(R(d!), { action: 'REJECT' });
    expect(noComment.status).toBe(400);
    const rej = await fa.post(R(d!), { action: 'REJECT', comment: 'Kitchen utensil, not a weapon' });
    expect(rej.status).toBe(200);
    expect(rej.body).toMatchObject({ reviewStatus: 'REJECTED', reviewComment: 'Kitchen utensil, not a weapon', reviewedBy: { fullName: expect.any(String) } });
    expect((await fa.post(R(d!), { action: 'APPROVE' })).status).toBe(409);
    expect((await fa.post(R(d!), { action: 'COMMENT', comment: 'noted for retraining' })).status).toBe(200);
    const h = await fa.get(`${R(d!)}/history`);
    expect(h.body.events.map((e: { action: string }) => e.action)).toEqual(['REJECT', 'COMMENT']);
    expect(h.body.events[0]).toMatchObject({ previousStatus: 'PENDING', newStatus: 'REJECTED', modelVersion: '0.1.1rc0', confidence: expect.closeTo(0.61, 3) });
    const audit = await app.db.selectFrom('audit_events').select(['action', 'evidence_id', 'category']).where('resource_id', '=', d!).orderBy('seq').execute();
    expect(audit).toEqual([
      { action: 'AI_RESULT_REJECTED', evidence_id: A.id, category: 'REVIEW' },
      { action: 'AI_RESULT_COMMENTED', evidence_id: A.id, category: 'REVIEW' },
    ]);
    // review events are append-only for the app role
    const upd = await sql`UPDATE ai_review_events SET comment = 'x' WHERE detection_id = ${d!}::uuid`.execute(app.db).then(() => null, (e: { code: string }) => e.code);
    expect(upd).toBe('42501');
  });

  it('FACE_RECOGNITION matches need two approvals by different reviewers', async () => {
    const [d] = await detections(A, 'FACE_RECOGNITION', [{ label: 'POI Alpha', confidence: 0.71, attributes: { watchlistEntryId: '00000000-0000-0000-0000-000000000001', similarity: 0.71 } }]);
    const fa = await as('fa.naveen');
    const first = await fa.post(R(d!), { action: 'APPROVE' });
    expect(first.body).toMatchObject({ reviewStatus: 'NEEDS_SECOND_REVIEW', approvals: 1 });
    const again = await fa.post(R(d!), { action: 'APPROVE' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('SECOND_REVIEWER_REQUIRED');
    const q = await fa2.get(`/api/v1/review/queue?status=NEEDS_SECOND_REVIEW&evidenceId=${A.id}`);
    expect(q.body.items.find((x: { id: string }) => x.id === d)).toMatchObject({ dualApproval: true, reviewedByMe: false });
    const second = await fa2.post(R(d!), { action: 'APPROVE' });
    expect(second.body).toMatchObject({ reviewStatus: 'APPROVED', approvals: 2 });
    const actions = (await app.db.selectFrom('audit_events').select('action').where('resource_id', '=', d!).execute()).map((a) => a.action);
    expect(actions).toEqual(['AI_RESULT_APPROVED', 'AI_RESULT_APPROVED']);
  });

  it('escalation: the escalating reviewer cannot approve; another can', async () => {
    const [d] = await detections(A, 'ANPR', [{ label: 'KA01AB1234', confidence: 0.66, attributes: { plateText: 'KA01AB1234' } }]);
    const sup = await as('sup.kavya');
    expect((await sup.post(R(d!), { action: 'REQUEST_SECOND_REVIEW', comment: 'Plate partly occluded' })).body.reviewStatus).toBe('NEEDS_SECOND_REVIEW');
    expect((await sup.post(R(d!), { action: 'APPROVE' })).status).toBe(409);
    expect((await (await as('fa.naveen')).post(R(d!), { action: 'APPROVE' })).body.reviewStatus).toBe('APPROVED');
    const esc = await app.db.selectFrom('audit_events').select('action').where('resource_id', '=', d!).where('action', '=', 'AI_RESULT_ESCALATED').execute();
    expect(esc).toHaveLength(1);
  });

  it('approved CLASSIFICATION results become AI_APPROVED evidence tags (corrected label wins)', async () => {
    const [crowd, weapon] = await detections(A, 'CLASSIFICATION', [{ label: 'crowd', confidence: 0.74 }, { label: 'weapon:knife', confidence: 0.58 }]);
    const fa = await as('fa.naveen');
    const ok = await fa.post(R(crowd!), { action: 'APPROVE' });
    expect(ok.body.tagCreated).toBe('crowd');
    expect((await fa.post(R(weapon!), { action: 'CORRECT_LABEL', correctedLabel: 'Weapon:Machete' })).body.correctedLabel).toBe('weapon:machete');
    expect((await fa.post(R(weapon!), { action: 'APPROVE' })).body.tagCreated).toBe('weapon:machete');
    const tags = await app.db.selectFrom('evidence_tags').select(['tag', 'source']).where('evidence_id', '=', A.id).orderBy('tag').execute();
    expect(tags).toEqual(expect.arrayContaining([{ tag: 'crowd', source: 'AI_APPROVED' }, { tag: 'weapon:machete', source: 'AI_APPROVED' }]));
    expect(tags.some((t) => t.tag === 'weapon:knife')).toBe(false);
    const tagged = await app.db.selectFrom('audit_events').select('details').where('evidence_id', '=', A.id).where('action', '=', 'EVIDENCE_TAGGED').execute();
    expect(tagged.length).toBeGreaterThanOrEqual(2);
    // a PENDING classification never produced a tag
    const [pending] = await detections(A, 'CLASSIFICATION', [{ label: 'vehicle', confidence: 0.9 }]);
    expect(pending).toBeTruthy();
    expect((await app.db.selectFrom('evidence_tags').select('tag').where('evidence_id', '=', A.id).where('tag', '=', 'vehicle').execute())).toHaveLength(0);
  });

  it('bulk review returns per-item results', async () => {
    const ids = await detections(A, 'PERSON_DETECTION', [{ label: 'person', confidence: 0.8 }, { label: 'person', confidence: 0.7 }]);
    const [mys] = await detections(M, 'PERSON_DETECTION', [{ label: 'person', confidence: 0.8 }]);
    const fa = await as('fa.naveen');
    const r = await fa.post('/api/v1/review/detections/bulk', {
      items: [
        { id: ids[0], action: 'APPROVE' },
        { id: ids[1], action: 'REJECT' }, // missing comment
        { id: mys, action: 'APPROVE' }, // other jurisdiction
        { id: '00000000-0000-0000-0000-000000000000', action: 'APPROVE' },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body.succeeded).toBe(1);
    expect(r.body.results.map((x: { ok: boolean; status?: string; error?: { status: number } }) => (x.ok ? x.status : x.error!.status))).toEqual(['APPROVED', 400, 404, 404]);
    expect((await fa.post('/api/v1/review/detections/bulk', { items: [] })).status).toBe(400);
  });
});
