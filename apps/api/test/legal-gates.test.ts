/**
 * Legal gates (EXT-4 ANPR licence, EXT-5 face-recognition DPIA, EXT-6 export template): with AI_LEGAL_GATES=enforce
 * (the production default) FACE_DETECTION / FACE_RECOGNITION / ANPR are refused by the API (422 + AI_TASK_REFUSED
 * audit) and by the isolated AI worker (TASK_NOT_PERMITTED) until an administrator records the approval in
 * settings.aiLegalApprovals (LEGAL_APPROVAL_RECORDED audit); AI_TASKS_ENABLED removes tasks regardless.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { aiTaskGates, ffmpeg, loadConfig, type AppConfig } from '@ksp/core';
import { PRODUCTION_DEFAULT_AI_TASKS } from '@ksp/shared';
import { closeApp, login, type Agent } from './helpers.js';
import { createAdmin, lastAudit, type AdminSession } from './admin-helpers.js';
import { evidenceTestSetup, evidenceTestTeardown, userId } from './evidence-setup.js';
import { createRegisteredEvidence, type CreatedEvidence } from './fixtures/evidence.js';
import { invalidateSettings } from '../src/lib/settings.js';
import { fetchAndRegisterModels } from '../../ai-worker/src/models/manifest.js';
import { createAiContext, drainJobs } from '../../ai-worker/src/main.js';
import { assertTasksPermitted } from '../../ai-worker/src/pipeline.js';
import { attachProxy } from '../../ai-worker/test/media.js';

let app: FastifyInstance;
let admin: AdminSession;
let io: Agent;
let A: CreatedEvidence;
let aiCtx: ReturnType<typeof createAiContext>;
let cfg: AppConfig;
let saved: Pick<AppConfig, 'AI_LEGAL_GATES' | 'AI_TASKS_ENABLED'>;
const S = '/api/v1/settings';
const J = () => `/api/v1/ai/evidence/${A.id}/jobs`;
const approval = { approvedBy: 'DPO, Karnataka State Police', reference: 'KSP/LEGAL/ANPR/2026/17', date: '2026-09-01' };
const approvals = (over: Record<string, unknown>) => ({ FACE_DETECTION: null, FACE_RECOGNITION: null, ANPR: null, ...over });

beforeAll(async () => {
  app = await evidenceTestSetup();
  expect((await fetchAndRegisterModels(app.db)).filter((r) => !r.ok)).toEqual([]);
  cfg = loadConfig();
  saved = { AI_LEGAL_GATES: cfg.AI_LEGAL_GATES, AI_TASKS_ENABLED: cfg.AI_TASKS_ENABLED };
  cfg.AI_LEGAL_GATES = 'enforce'; // production default
  cfg.AI_TASKS_ENABLED = 'ALL';
  admin = await createAdmin({ org: 'ksp' });
  io = await login('io.meera');
  A = await createRegisteredEvidence({ orgCode: 'ps_cubbonpark', uploadedBy: await userId('io.meera') });
  const clip = `${cfg.WORK_DIR}/legal-gates-3s.mp4`;
  await ffmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=10:duration=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', clip]);
  await attachProxy(app.db, A.id, clip);
  aiCtx = createAiContext();
}, 300_000);

afterAll(async () => {
  Object.assign(cfg, saved);
  await app.db.deleteFrom('system_settings').where('key', 'in', ['aiLegalApprovals', 'exportLegalApproval']).execute();
  invalidateSettings();
  await aiCtx?.destroy();
  await evidenceTestTeardown();
  await closeApp();
});

describe('gate logic', () => {
  it('production default list excludes biometric / ANPR tasks; approvals open gated tasks only when enabled', () => {
    expect(PRODUCTION_DEFAULT_AI_TASKS).toEqual(['OBJECT_DETECTION', 'PERSON_DETECTION', 'CLASSIFICATION']);
    const prod = aiTaskGates({ NODE_ENV: 'production', AI_TASKS_ENABLED: undefined, AI_LEGAL_GATES: undefined }, { ANPR: approval });
    expect(prod.OBJECT_DETECTION.allowed).toBe(true);
    expect(prod.ANPR).toMatchObject({ allowed: false, reason: 'DISABLED_BY_DEPLOYMENT' }); // approved, but not enabled
    const enabled = aiTaskGates({ NODE_ENV: 'production', AI_TASKS_ENABLED: 'OBJECT_DETECTION,ANPR,FACE_RECOGNITION', AI_LEGAL_GATES: undefined }, { ANPR: approval });
    expect(enabled.ANPR).toMatchObject({ allowed: true, approval: { reference: approval.reference } });
    expect(enabled.FACE_RECOGNITION).toMatchObject({ allowed: false, reason: 'LEGAL_APPROVAL_REQUIRED' });
    // Development default: everything, no legal gate.
    const dev = aiTaskGates({ NODE_ENV: 'development', AI_TASKS_ENABLED: undefined, AI_LEGAL_GATES: undefined }, null);
    expect(Object.values(dev).every((g) => g.allowed)).toBe(true);
  });
});

describe('API', () => {
  it('GET /ai/tasks reports the gate and hides gated tasks from availability', async () => {
    const r = await io.get('/api/v1/ai/tasks');
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.body.items.map((t: { task: string }) => [t.task, t]));
    expect(by.PERSON_DETECTION).toMatchObject({ allowed: true, available: true });
    expect(by.FACE_RECOGNITION).toMatchObject({ allowed: false, available: false, gate: { reason: 'LEGAL_APPROVAL_REQUIRED' } });
    expect(by.ANPR.gate.explanation).toMatch(/legal approval/);
  });

  it('refuses a gated task with 422 AI_TASK_DISABLED and audits AI_TASK_REFUSED; permitted tasks still run', async () => {
    const r = await io.post(J(), { tasks: ['PERSON_DETECTION', 'ANPR'] });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('AI_TASK_DISABLED');
    expect(r.body.error.details.tasks).toEqual([expect.objectContaining({ task: 'ANPR', reason: 'LEGAL_APPROVAL_REQUIRED' })]);
    const a = await app.db.selectFrom('audit_events').select(['evidence_id', 'outcome', 'details']).where('action', '=', 'AI_TASK_REFUSED').orderBy('seq', 'desc').limit(1).executeTakeFirstOrThrow();
    expect(a).toMatchObject({ evidence_id: A.id, outcome: 'FAILURE' });
    expect((await io.post(J(), { tasks: ['PERSON_DETECTION'] })).status).toBe(202);
  });

  it('only settings:manage records approvals; validation; recordedBy/At stamped; LEGAL_APPROVAL_RECORDED audited', async () => {
    expect((await io.put(`${S}/aiLegalApprovals`, approvals({ ANPR: approval }))).status).toBe(403);
    expect((await admin.agent.put(`${S}/aiLegalApprovals`, approvals({ ANPR: { ...approval, date: '2999-01-01' } }))).status).toBe(400);
    expect((await admin.agent.put(`${S}/aiLegalApprovals`, approvals({ ANPR: { ...approval, reference: '' } }))).status).toBe(400);
    expect((await admin.agent.put(`${S}/aiLegalApprovals`, approvals({ IRIS: approval }))).status).toBe(400);
    const r = await admin.agent.put(`${S}/aiLegalApprovals`, approvals({ ANPR: approval }));
    expect(r.status).toBe(200);
    expect(r.body.settings.aiLegalApprovals.ANPR).toMatchObject({ ...approval, recordedBy: admin.username });
    expect(r.body.deployment.aiTaskGates.find((g: { task: string }) => g.task === 'ANPR')).toMatchObject({ allowed: true });
    const ev = await lastAudit('LEGAL_APPROVAL_RECORDED');
    expect(ev?.resource_id).toBe('aiLegalApprovals.ANPR');
    expect((ev?.details as { new: { reference: string } }).new.reference).toBe(approval.reference);
    // Re-saving the same approval keeps the original recorder and writes no new approval event.
    const before = ev!.seq;
    const again = await admin.agent.put(`${S}/aiLegalApprovals`, r.body.settings.aiLegalApprovals);
    expect(again.body.settings.aiLegalApprovals.ANPR.recordedAt).toBe(r.body.settings.aiLegalApprovals.ANPR.recordedAt);
    expect((await lastAudit('LEGAL_APPROVAL_RECORDED'))!.seq).toBe(before);
  });

  it('an approved task is accepted; AI_TASKS_ENABLED still removes it', async () => {
    const ok = await io.post(J(), { tasks: ['ANPR'] });
    expect(ok.status).toBe(202);
    cfg.AI_TASKS_ENABLED = 'OBJECT_DETECTION,PERSON_DETECTION,CLASSIFICATION';
    try {
      const r = await io.post(J(), { tasks: ['ANPR'] });
      expect(r.status).toBe(422);
      expect(r.body.error.details.tasks[0].reason).toBe('DISABLED_BY_DEPLOYMENT');
    } finally {
      cfg.AI_TASKS_ENABLED = 'ALL';
    }
  });

  it('the AI worker re-checks: a queued job whose approval was withdrawn fails with TASK_NOT_PERMITTED', async () => {
    await expect(assertTasksPermitted(aiCtx, ['ANPR'])).resolves.toBeUndefined(); // ksp_ai reads the ai_legal_approvals view
    await expect(assertTasksPermitted(aiCtx, ['FACE_RECOGNITION'])).rejects.toThrow(/TASK_NOT_PERMITTED|not permitted/);
    const revoke = await admin.agent.put(`${S}/aiLegalApprovals`, approvals({}));
    expect(revoke.status).toBe(200);
    expect((await lastAudit('LEGAL_APPROVAL_REVOKED'))?.resource_id).toBe('aiLegalApprovals.ANPR');
    await drainJobs(aiCtx);
    const jobs = await app.db.selectFrom('ai_jobs').select(['tasks', 'status', 'error']).where('evidence_id', '=', A.id).execute();
    const anpr = jobs.filter((j) => j.tasks.includes('ANPR'));
    expect(anpr.length).toBeGreaterThan(0);
    for (const j of anpr) expect(j).toMatchObject({ status: 'FAILED', error: expect.stringContaining('TASK_NOT_PERMITTED') });
    expect(jobs.filter((j) => !j.tasks.includes('ANPR')).every((j) => j.status === 'COMPLETED')).toBe(true);
  }, 180_000);

  it('export template approval is recorded and audited', async () => {
    const r = await admin.agent.put(`${S}/exportLegalApproval`, { approval: { approvedBy: 'Director of Prosecution', reference: 'DoP/BSA63/2026/4', date: '2026-09-10' } });
    expect(r.status).toBe(200);
    expect(r.body.deployment.exportTemplateApproved).toBe(true);
    expect((await lastAudit('LEGAL_APPROVAL_RECORDED'))?.resource_id).toBe('exportLegalApproval.approval');
    const reset = await admin.agent.delete(`${S}/exportLegalApproval`);
    expect(reset.body.deployment.exportTemplateApproved).toBe(false);
    expect((await lastAudit('LEGAL_APPROVAL_REVOKED'))?.resource_id).toBe('exportLegalApproval.approval');
  });
});
