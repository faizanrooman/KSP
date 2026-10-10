/**
 * /ai API: job requests (snapshot + NOTIFY), authz (401/403/404-other-jurisdiction), cancel, tasks, detections with
 * tokenised crops (real ai-worker run), models lifecycle, watchlists, training export content.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { ffmpeg, loadConfig, storage } from '@ksp/core';
import { AI_JOBS_CHANNEL } from '@ksp/shared';
import { Agent, closeApp, createUser, login } from './helpers.js';
import { evidenceTestSetup, evidenceTestTeardown, userId } from './evidence-setup.js';
import { createRegisteredEvidence, type CreatedEvidence } from './fixtures/evidence.js';
import { fetchAndRegisterModels } from '../../ai-worker/src/models/manifest.js';
import { createAiContext, drainJobs } from '../../ai-worker/src/main.js';
import { attachProxy, slideshow, tryEnsureImages } from '../../ai-worker/test/media.js';
import { runTrainingExport } from '../../worker/src/jobs/ai-training/build.js';

const MEDIA = await tryEnsureImages();
if (!MEDIA.images) console.warn(`[ai tests] image-based checks SKIPPED: ${MEDIA.reason}`);

let app: FastifyInstance;
let video: string;
let A: CreatedEvidence; // Cubbon Park (proxy attached)
let M: CreatedEvidence; // Mysuru (proxy attached)
let N: CreatedEvidence; // Cubbon Park, media not ready
const agents: Record<string, Agent> = {};
const as = async (u: string) => (agents[u] ??= await login(u));
const J = (e: { id: string }) => `/api/v1/ai/evidence/${e.id}/jobs`;
let aiCtx: ReturnType<typeof createAiContext>;

async function testVideo(): Promise<string> {
  if (MEDIA.images) return slideshow([MEDIA.images.street, MEDIA.images.portrait, MEDIA.images.plate], [2, 2, 2], 'ai-api-6s');
  // Same 6 s length as the slideshow so the frame-count checks hold without the downloaded images too.
  const out = `${loadConfig().WORK_DIR}/ai-api-testsrc-6s.mp4`;
  await ffmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', out]);
  return out;
}

beforeAll(async () => {
  app = await evidenceTestSetup();
  const res = await fetchAndRegisterModels(app.db);
  expect(res.filter((r) => !r.ok)).toEqual([]);
  video = await testVideo();
  A = await createRegisteredEvidence({ orgCode: 'ps_cubbonpark', uploadedBy: await userId('io.meera') });
  M = await createRegisteredEvidence({ orgCode: 'ps_nazarbad', uploadedBy: await userId('io.mysuru') });
  N = await createRegisteredEvidence({ orgCode: 'ps_cubbonpark', uploadedBy: await userId('io.meera') });
  await attachProxy(app.db, A.id, video);
  await attachProxy(app.db, M.id, video);
  aiCtx = createAiContext();
}, 300_000);

afterAll(async () => {
  await aiCtx?.destroy();
  await evidenceTestTeardown();
  await closeApp();
});

describe('POST /ai/evidence/:id/jobs', () => {
  it('401 unauthenticated, 403 without ai:request, 404 other jurisdiction', async () => {
    expect((await new Agent(app).post(J(A), { tasks: ['PERSON_DETECTION'] })).status).toBe(401);
    expect((await (await as('fo.ravi')).post(J(A), { tasks: ['PERSON_DETECTION'] })).status).toBe(403);
    expect((await (await as('op.cubbon')).post(J(A), { tasks: ['PERSON_DETECTION'] })).status).toBe(403);
    expect((await (await as('io.mysuru')).post(J(A), { tasks: ['PERSON_DETECTION'] })).status).toBe(404);
    expect((await (await as('io.meera')).post(J(M), { tasks: ['PERSON_DETECTION'] })).status).toBe(404);
    expect((await (await as('io.meera')).post('/api/v1/ai/evidence/00000000-0000-0000-0000-000000000000/jobs', { tasks: ['PERSON_DETECTION'] })).status).toBe(404);
  });

  it('validates body, media readiness and task availability', async () => {
    const io = await as('io.meera');
    expect((await io.post(J(A), { tasks: [] })).status).toBe(400);
    expect((await io.post(J(A), { tasks: ['PERSON_DETECTION', 'PERSON_DETECTION'] })).status).toBe(400);
    expect((await io.post(J(A), { tasks: ['PERSON_DETECTION'], sampleFps: 50 })).status).toBe(400);
    const nr = await io.post(J(N), { tasks: ['PERSON_DETECTION'] });
    expect(nr.status).toBe(409);
    expect(nr.body.error.code).toBe('MEDIA_NOT_READY');
    await app.db.updateTable('evidence').set({ media_status: 'READY' }).where('id', '=', N.id).execute();
    const np = await io.post(J(N), { tasks: ['PERSON_DETECTION'] });
    expect(np.body.error.code).toBe('NO_PROXY');
    // face recognition without an applicable FACE watchlist
    const fr = await io.post(J(A), { tasks: ['FACE_RECOGNITION'] });
    expect(fr.status).toBe(422);
    // a task whose model is retired is unavailable
    await sql`UPDATE ai_models SET status = 'RETIRED' WHERE task = 'ANPR'`.execute(app.db);
    const un = await io.post(J(A), { tasks: ['ANPR', 'PERSON_DETECTION'] });
    expect(un.status).toBe(422);
    expect(un.body.error.details.unavailable).toEqual(['ANPR']);
    const tasks = await io.get('/api/v1/ai/tasks');
    expect(tasks.body.items.find((t: { task: string }) => t.task === 'ANPR').available).toBe(false);
    expect(tasks.body.items.find((t: { task: string }) => t.task === 'PERSON_DETECTION')).toMatchObject({ available: true, models: [{ code: 'yolox-s-person' }] });
    await sql`UPDATE ai_models SET status = 'ACTIVE', retired_at = NULL WHERE task = 'ANPR'`.execute(app.db);
  });

  it('creates a QUEUED job with a proxy snapshot + dependency models, audits and NOTIFYs the worker', async () => {
    const listener = new pg.Client({ connectionString: loadConfig().DATABASE_AI_URL });
    await listener.connect();
    const notes: string[] = [];
    listener.on('notification', (n) => notes.push(n.payload ?? ''));
    await listener.query(`LISTEN ${AI_JOBS_CHANNEL}`);
    const io = await as('io.meera');
    const r = await io.post(J(A), { tasks: ['CLASSIFICATION', 'FACE_DETECTION'], sampleFps: 2, thresholds: { FACE_DETECTION: 0.8 } });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ status: 'QUEUED', tasks: ['CLASSIFICATION', 'FACE_DETECTION'], params: { sampleFps: 2, thresholds: { FACE_DETECTION: 0.8 } } });
    expect(r.body.models.map((m: { code: string }) => m.code).sort()).toEqual(['ksp-evidence-tagger', 'yolox-s-coco', 'yunet-face']);
    expect(JSON.stringify(r.body)).not.toMatch(/derivativeKey|proxy\.mp4|storage/i);
    const row = await app.db.selectFrom('ai_jobs').select(['input', 'requested_by']).where('id', '=', r.body.id).executeTakeFirstOrThrow();
    expect(row.input).toMatchObject({ derivativeBucket: loadConfig().S3_BUCKET_DERIVED, derivativeKey: `evidence/${A.id}/proxy/proxy.mp4`, orgUnitId: A.orgUnitId });
    for (let i = 0; i < 20 && !notes.includes(r.body.id); i++) await new Promise((res) => setTimeout(res, 50));
    expect(notes).toContain(r.body.id);
    await listener.end();
    const audit = await app.db.selectFrom('audit_events').select(['action', 'evidence_id', 'actor_id']).where('resource_id', '=', r.body.id).execute();
    expect(audit).toEqual([{ action: 'AI_ANALYSIS_REQUESTED', evidence_id: A.id, actor_id: await userId('io.meera') }]);

    // list + get + authz
    const list = await io.get(J(A));
    expect(list.body.items.some((j: { id: string }) => j.id === r.body.id)).toBe(true);
    expect((await io.get(`/api/v1/ai/jobs/${r.body.id}`)).body.id).toBe(r.body.id);
    expect((await (await as('io.mysuru')).get(`/api/v1/ai/jobs/${r.body.id}`)).status).toBe(404);
    expect((await (await as('io.mysuru')).get(J(A))).status).toBe(404);
    expect((await (await as('fo.ravi')).get(J(A))).status).toBe(403);
    expect((await new Agent(app).get(J(A))).status).toBe(401);

    // cancel
    expect((await (await as('io.mysuru')).post(`/api/v1/ai/jobs/${r.body.id}/cancel`)).status).toBe(404);
    const c = await io.post(`/api/v1/ai/jobs/${r.body.id}/cancel`);
    expect(c.status).toBe(200);
    expect(c.body.status).toBe('CANCELLED');
    expect((await io.post(`/api/v1/ai/jobs/${r.body.id}/cancel`)).status).toBe(409);
    const ca = await app.db.selectFrom('audit_events').select('action').where('resource_id', '=', r.body.id).where('action', '=', 'AI_ANALYSIS_CANCELLED').execute();
    expect(ca).toHaveLength(1);
  });
});

describe('end-to-end with the isolated worker: detections and crops', () => {
  it('worker processes the API job; detections list with tokenised crop URLs; crop tokens are bound', async () => {
    const io = await as('io.meera');
    const r = await io.post(J(A), { tasks: ['PERSON_DETECTION', 'FACE_DETECTION', 'ANPR'], sampleFps: 1 });
    expect(r.status).toBe(202);
    await drainJobs(aiCtx);
    const job = (await io.get(`/api/v1/ai/jobs/${r.body.id}`)).body;
    expect(job.error).toBeNull();
    expect(job.status).toBe('COMPLETED');
    // The worker read the whole 6 s proxy and sampled it at 1 fps: framesTotal = ceil(duration × fps); FFmpeg's fps
    // filter may emit one frame fewer at the very end (rounding of the last timestamp) — never fewer than that.
    expect(job.stats.sourceDurationMs).toBeGreaterThanOrEqual(5750);
    expect(job.stats.framesTotal).toBe(Math.ceil(job.stats.sourceDurationMs / 1000));
    expect(job.stats.framesProcessed).toBeGreaterThanOrEqual(job.stats.framesTotal - 1);
    expect(job.stats.framesProcessed).toBeGreaterThanOrEqual(5);

    const d = await io.get(`/api/v1/ai/evidence/${A.id}/detections?jobId=${r.body.id}`);
    expect(d.status).toBe(200);
    const s = JSON.stringify(d.body);
    expect(s).not.toMatch(/crop_key|cropKey|evidence\/[0-9a-f-]{36}\/ai|embedding/);
    // Without the downloaded imagery the proxy is a synthetic colour clip: the pipeline must still complete, but there is
    // nothing to detect, so the content assertions below only apply when the real test images were available.
    if (MEDIA.images) {
      expect(d.body.total).toBeGreaterThan(0);
      const withCrop = d.body.items.find((x: { cropUrl: string | null }) => x.cropUrl);
      expect(withCrop.cropUrl).toMatch(/^\/api\/v1\/ai\/crops\/[0-9a-f-]{36}\?t=/);
      expect(withCrop.reviewStatus).toBe('PENDING');
      const tasks = new Set(d.body.items.map((x: { task: string }) => x.task));
      expect(tasks).toEqual(new Set(['PERSON_DETECTION', 'FACE_DETECTION', 'ANPR']));
      expect(d.body.items.some((x: { label: string }) => x.label === 'IJZ8992')).toBe(true);
      const img = await new Agent(app).get(withCrop.cropUrl);
      expect(img.status).toBe(200);
      expect(img.headers['content-type']).toBe('image/jpeg');
      // token for detection X does not open detection Y
      const other = d.body.items.find((x: { id: string; cropUrl: string | null }) => x.cropUrl && x.id !== withCrop.id);
      if (other) {
        const t = new URL(withCrop.cropUrl, 'http://x').searchParams.get('t')!;
        expect((await new Agent(app).get(`/api/v1/ai/crops/${other.id}?t=${encodeURIComponent(t)}`)).status).toBe(403);
      }
      expect((await new Agent(app).get(`/api/v1/ai/crops/${withCrop.id}`)).status).toBe(401);
      expect((await new Agent(app).get(`/api/v1/ai/crops/${withCrop.id}?t=bogus.tokenvalue`)).status).toBe(401);
    }

    // filters + authz
    const f = await io.get(`/api/v1/ai/evidence/${A.id}/detections?task=PERSON_DETECTION&minConfidence=0.5`);
    for (const x of f.body.items) {
      expect(x.task).toBe('PERSON_DETECTION');
      expect(x.confidence).toBeGreaterThanOrEqual(0.5);
    }
    expect((await (await as('io.mysuru')).get(`/api/v1/ai/evidence/${A.id}/detections`)).status).toBe(404);
    expect((await (await as('fo.ravi')).get(`/api/v1/ai/evidence/${A.id}/detections`)).status).toBe(403);
    const viewed = await app.db.selectFrom('audit_events').select('action').where('evidence_id', '=', A.id).where('action', '=', 'AI_RESULTS_VIEWED').execute();
    expect(viewed.length).toBeGreaterThanOrEqual(1);
  });
});

describe('models registry (ai:models_manage)', () => {
  it('403 for non-admins; register STAGED, activation needs metrics and retires the previous version; retire; patch', async () => {
    expect((await (await as('io.meera')).get('/api/v1/ai/models')).status).toBe(403);
    expect((await new Agent(app).get('/api/v1/ai/models')).status).toBe(401);
    const admin = await as('admin');
    const list = await admin.get('/api/v1/ai/models');
    const current = list.body.items.find((m: { code: string; status: string }) => m.code === 'yunet-face' && m.status === 'ACTIVE');
    expect(current).toBeTruthy();
    const body = { code: 'yunet-face', name: 'YuNet (re-evaluated)', task: 'FACE_DETECTION', version: '2023mar-r2', artifactUri: 'models://face_detection_yunet_2023mar.onnx', artifactSha256: current.artifactSha256, defaultThreshold: 0.75, config: current.config };
    expect((await admin.post('/api/v1/ai/models', { ...body, artifactUri: '/etc/passwd' })).status).toBe(400);
    expect((await admin.post('/api/v1/ai/models', { ...body, artifactUri: 'models://../x.onnx' })).status).toBe(400);
    const reg = await admin.post('/api/v1/ai/models', body);
    expect(reg.status).toBe(201);
    expect(reg.body.status).toBe('STAGED');
    expect((await admin.post('/api/v1/ai/models', body)).status).toBe(409);
    const noMetrics = await admin.post(`/api/v1/ai/models/${reg.body.id}/activate`);
    expect(noMetrics.status).toBe(422);
    expect((await admin.patch(`/api/v1/ai/models/${reg.body.id}`, { metrics: { precision: 0.91, recall: 0.88, dataset: 'ksp-eval-2026-09' } })).status).toBe(200);
    const act = await admin.post(`/api/v1/ai/models/${reg.body.id}/activate`);
    expect(act.status).toBe(200);
    expect(act.body.status).toBe('ACTIVE');
    const old = (await admin.get('/api/v1/ai/models?task=FACE_DETECTION')).body.items.find((m: { id: string }) => m.id === current.id);
    expect(old.status).toBe('RETIRED');
    // roll back
    expect((await admin.post(`/api/v1/ai/models/${current.id}/activate`)).body.status).toBe('ACTIVE');
    // rolling back retired the r2 version; retiring it again is a conflict; a STAGED version can be retired directly
    expect((await admin.get('/api/v1/ai/models?task=FACE_DETECTION')).body.items.find((m: { id: string }) => m.id === reg.body.id).status).toBe('RETIRED');
    expect((await admin.post(`/api/v1/ai/models/${reg.body.id}/retire`)).status).toBe(409);
    const staged = await admin.post('/api/v1/ai/models', { ...body, version: '2023mar-r3' });
    expect((await admin.post(`/api/v1/ai/models/${staged.body.id}/retire`)).body.status).toBe('RETIRED');
    const actions = (await app.db.selectFrom('audit_events').select('action').where('resource_id', '=', reg.body.id).orderBy('seq').execute()).map((a) => a.action);
    expect(actions).toEqual(['AI_MODEL_REGISTERED', 'AI_MODEL_UPDATED', 'AI_MODEL_ACTIVATED', 'AI_MODEL_RETIRED']);
  });
});

describe('watchlists (ai:watchlist_manage, org scoped)', () => {
  it('CRUD with jurisdiction; FACE entries need an image; VEHICLE plates are normalised; worker embeds', async () => {
    expect((await (await as('io.meera')).get('/api/v1/ai/watchlists')).status).toBe(403);
    const fa = await as('fa.naveen'); // FORENSIC_ANALYST @ blr_city
    const mys = await createUser({ role: 'FORENSIC_ANALYST', org: 'mysuru_dist' });
    const faM = await login(mys.username, mys.password);
    const blrCity = await app.db.selectFrom('org_units').select('id').where('code', '=', 'blr_city').executeTakeFirstOrThrow();
    const mysuru = await app.db.selectFrom('org_units').select('id').where('code', '=', 'mysuru_dist').executeTakeFirstOrThrow();
    expect((await fa.post('/api/v1/ai/watchlists', { name: 'Mysuru list', kind: 'FACE', orgUnitId: mysuru.id })).status).toBe(404);
    const v = await fa.post('/api/v1/ai/watchlists', { name: 'Stolen vehicles', kind: 'VEHICLE', orgUnitId: blrCity.id });
    expect(v.status).toBe(201);
    const bad = await fa.post(`/api/v1/ai/watchlists/${v.body.id}/entries`, { label: 'x' });
    expect(bad.status).toBe(400);
    const e = await fa.post(`/api/v1/ai/watchlists/${v.body.id}/entries`, { label: 'Stolen Fiesta', plate: 'ijz-8992' });
    expect(e.status).toBe(201);
    expect(e.body.plate).toBe('IJZ8992');
    expect((await faM.get(`/api/v1/ai/watchlists/${v.body.id}`)).status).toBe(404);
    expect((await faM.get('/api/v1/ai/watchlists')).body.items.some((w: { id: string }) => w.id === v.body.id)).toBe(false);

    const f = await fa.post('/api/v1/ai/watchlists', { name: 'Persons of interest', kind: 'FACE', orgUnitId: blrCity.id });
    expect((await fa.post(`/api/v1/ai/watchlists/${f.body.id}/entries`, { label: 'No image' })).status).toBe(400);
    expect((await fa.post(`/api/v1/ai/watchlists/${f.body.id}/entries`, { label: 'Bad', imageBase64: Buffer.from('not an image').toString('base64') })).status).toBe(422);
    if (MEDIA.images) {
      const png = await readFile(MEDIA.images.portrait);
      const small = await ffmpegResize(MEDIA.images.portrait);
      const ok = await fa.post(`/api/v1/ai/watchlists/${f.body.id}/entries`, { label: 'POI Alpha', imageBase64: small.toString('base64') });
      expect(ok.status).toBe(201);
      expect(ok.body.embeddingStatus).toBe('PENDING');
      expect(png.length).toBeGreaterThan(0);
      const { embedPendingWatchlistEntries } = await import('../../ai-worker/src/watchlist.js');
      await embedPendingWatchlistEntries(aiCtx);
      const detail = await fa.get(`/api/v1/ai/watchlists/${f.body.id}`);
      expect(detail.body.entries[0]).toMatchObject({ label: 'POI Alpha', embeddingStatus: 'READY', model: { code: 'sface-recognition' } });
      expect(JSON.stringify(detail.body)).not.toMatch(/embedding"\s*:\s*\[/);
      const im = await fa.get(detail.body.entries[0].imageUrl);
      expect(im.status).toBe(200);

      // face recognition job against the list (applies to Cubbon Park, inside blr_city)
      const io = await as('io.meera');
      const wl = await io.get(`/api/v1/ai/evidence/${A.id}/watchlists`);
      expect(wl.body.items.map((w: { id: string }) => w.id)).toEqual(expect.arrayContaining([f.body.id, v.body.id]));
      expect((await io.post(J(A), { tasks: ['FACE_RECOGNITION'], watchlistIds: [v.body.id] })).status).toBe(422); // VEHICLE list for FACE task
      const job = await io.post(J(A), { tasks: ['FACE_RECOGNITION', 'ANPR'] });
      expect(job.status).toBe(202);
      expect(job.body.params.watchlistIds).toEqual(expect.arrayContaining([f.body.id, v.body.id]));
      await drainJobs(aiCtx);
      const dets = (await io.get(`/api/v1/ai/evidence/${A.id}/detections?jobId=${job.body.id}`)).body.items;
      const rec = dets.filter((x: { task: string }) => x.task === 'FACE_RECOGNITION');
      expect(rec.length).toBeGreaterThanOrEqual(1);
      expect(rec[0]).toMatchObject({ label: 'POI Alpha', attributes: { watchlistId: f.body.id } });
      const hit = dets.find((x: { task: string; label: string }) => x.task === 'ANPR' && x.label === 'IJZ8992');
      expect(hit.attributes).toMatchObject({ watchlistHit: true, watchlistLabel: 'Stolen Fiesta' });
      // Mysuru evidence cannot use a Bengaluru list
      expect((await (await as('io.mysuru')).post(J(M), { tasks: ['ANPR'], watchlistIds: [v.body.id] })).status).toBe(422);
    }
    expect((await faM.delete(`/api/v1/ai/watchlists/${v.body.id}`)).status).toBe(404);
    expect((await fa.delete(`/api/v1/ai/watchlists/${v.body.id}`)).status).toBe(200);
    const changes = await app.db.selectFrom('audit_events').select('action').where('action', '=', 'AI_WATCHLIST_CHANGED').execute();
    expect(changes.length).toBeGreaterThanOrEqual(4);
  });
});

async function ffmpegResize(src: string): Promise<Buffer> {
  const out = `${loadConfig().WORK_DIR}/poi-ref.jpg`;
  await ffmpeg(['-i', src, '-vf', 'scale=800:-2', '-q:v', '3', out]);
  return readFile(out);
}

describe('training exports', () => {
  it('exports reviewed detections (positives, corrected labels, negatives) with crops and a manifest', async () => {
    expect((await (await as('fa.naveen')).post('/api/v1/ai/training-exports', { task: 'PERSON_DETECTION', from: '2020-01-01', to: '2100-01-01' })).status).toBe(403);
    const dets = await app.db.selectFrom('ai_detections').select(['id', 'crop_key']).where('evidence_id', '=', A.id).where('task', '=', 'PERSON_DETECTION').where('review_status', '=', 'PENDING').limit(3).execute();
    expect(dets.length).toBeGreaterThanOrEqual(MEDIA.images ? 3 : 0);
    if (dets.length < 3) return;
    const sup = await as('sup.kavya');
    expect((await sup.post(`/api/v1/review/detections/${dets[0]!.id}`, { action: 'APPROVE' })).status).toBe(200);
    expect((await sup.post(`/api/v1/review/detections/${dets[1]!.id}`, { action: 'CORRECT_LABEL', correctedLabel: 'police officer' })).status).toBe(200);
    expect((await sup.post(`/api/v1/review/detections/${dets[2]!.id}`, { action: 'REJECT', comment: 'mannequin, not a person' })).status).toBe(200);

    // ai:models_manage alone (System Administrator) cannot extract evidence crops; a model manager with evidence access can.
    expect((await (await as('admin')).post('/api/v1/ai/training-exports', { task: 'PERSON_DETECTION', from: '2020-01-01', to: '2100-01-01' })).status).toBe(403);
    await app.db.insertInto('roles').values({ code: 'TEST_AI_MODEL_MANAGER', name: 'AI model manager (test)', description: 'ai:models_manage + evidence:read', permissions: ['ai:models_manage', 'evidence:read', 'ai:review', 'org:read'], is_system: false })
      .onConflict((oc) => oc.column('code').doNothing()).execute();
    const mm = await createUser({ role: 'TEST_AI_MODEL_MANAGER', org: 'ksp' });
    const admin = await login(mm.username, mm.password);
    const r = await admin.post('/api/v1/ai/training-exports', { task: 'PERSON_DETECTION', from: '2020-01-01', to: '2100-01-01' });
    expect(r.status).toBe(202);
    expect(r.body.status).toBe('QUEUED');
    await runTrainingExport({ db: app.db, storage: storage(), log: app.log as never }, r.body.id);
    const done = await admin.get(`/api/v1/ai/training-exports/${r.body.id}`);
    expect(done.body).toMatchObject({ status: 'COMPLETED', sampleCount: 3 });
    const manifest = await admin.get(`/api/v1/ai/training-exports/${r.body.id}/files/manifest.json`);
    const m = JSON.parse(manifest.raw);
    expect(m.counts).toMatchObject({ samples: 3, positives: 2, negatives: 1, crops: 3 });
    const jsonl = (await admin.get(`/api/v1/ai/training-exports/${r.body.id}/files/dataset.jsonl`)).raw.trim().split('\n').map((l) => JSON.parse(l));
    const byId = new Map(jsonl.map((x: { detectionId: string }) => [x.detectionId, x]));
    expect(byId.get(dets[0]!.id)).toMatchObject({ sample: 'positive', label: 'person', reviewStatus: 'APPROVED' });
    expect(byId.get(dets[1]!.id)).toMatchObject({ sample: 'positive', label: 'police officer', originalLabel: 'person' });
    expect(byId.get(dets[2]!.id)).toMatchObject({ sample: 'negative', reviewStatus: 'REJECTED' });
    expect(JSON.stringify(jsonl)).not.toMatch(/embedding|crop_key/);
    const coco = JSON.parse((await admin.get(`/api/v1/ai/training-exports/${r.body.id}/files/coco.json`)).raw);
    expect(coco.images).toHaveLength(3);
    expect(coco.annotations).toHaveLength(2);
    expect(coco.categories.map((c: { name: string }) => c.name).sort()).toEqual(['person', 'police officer']);
    const crop = await admin.get(`/api/v1/ai/training-exports/${r.body.id}/files/crops/${dets[0]!.id}.jpg`);
    expect(crop.status).toBe(200);
    const listed = m.files.find((x: { name: string }) => x.name === 'dataset.jsonl');
    expect(listed.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await admin.get(`/api/v1/ai/training-exports/${r.body.id}/files/..%2F..%2Fetc`)).status).toBe(404);
    const audit = await app.db.selectFrom('audit_events').select(['action', 'evidence_id']).where('resource_id', '=', r.body.id).execute();
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['AI_TRAINING_EXPORT_REQUESTED', 'AI_TRAINING_EXPORTED']));
    expect(audit.some((a) => a.action === 'AI_TRAINING_EXPORTED' && a.evidence_id === A.id)).toBe(true);
  });
});
