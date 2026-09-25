import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Agent, closeApp, login } from './helpers.js';
import { evidenceTestSetup, evidenceTestTeardown, userId } from './evidence-setup.js';
import { createRegisteredEvidence } from './fixtures/evidence.js';

let app: FastifyInstance;
let latha: Agent;
const base = '/api/v1/retention/policies';

beforeAll(async () => {
  app = await evidenceTestSetup();
  latha = await login('ec.latha');
}, 120_000);
afterAll(async () => {
  await evidenceTestTeardown();
  await closeApp();
});

describe('retention policies', () => {
  it('enforces authentication and retention:manage', async () => {
    expect((await new Agent(app).get(base)).status).toBe(401);
    const meera = await login('io.meera');
    expect((await meera.get(base)).status).toBe(200);
    expect((await meera.post(base, { code: 'x_policy', name: 'Nope policy', retentionDays: 10, archiveAfterDays: null, longTermAfterDays: null })).status).toBe(403);
    expect((await (await login('fo.ravi')).get(base)).status).toBe(403);
  });

  it('creates, validates, switches the single default and refuses deleting default/in-use policies', async () => {
    const list = await latha.get(base);
    expect(list.body.items.filter((p: { isDefault: boolean }) => p.isDefault)).toHaveLength(1);
    const oldDefault = list.body.items.find((p: { isDefault: boolean }) => p.isDefault);
    expect((await latha.post(base, { code: 'bad_order', name: 'Bad order', retentionDays: 100, archiveAfterDays: 200, longTermAfterDays: null })).status).toBe(400);
    expect((await latha.post(base, { code: 'Bad Code', name: 'Bad code', retentionDays: 100, archiveAfterDays: null, longTermAfterDays: null })).status).toBe(400);
    const c = await latha.post(base, { code: 'traffic_2y', name: 'Traffic (2 years)', retentionDays: 730, archiveAfterDays: 30, longTermAfterDays: 365, isDefault: true });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ code: 'traffic_2y', retentionDays: 730, isDefault: true, evidenceCount: 0 });
    expect((await latha.post(base, { code: 'traffic_2y', name: 'Duplicate', retentionDays: 1, archiveAfterDays: null, longTermAfterDays: null })).status).toBe(409);
    const after = await latha.get(base);
    expect(after.body.items.filter((p: { isDefault: boolean }) => p.isDefault).map((p: { id: string }) => p.id)).toEqual([c.body.id]);
    expect((await latha.patch(`${base}/${c.body.id}`, { isDefault: false })).status).toBe(409);
    expect((await latha.delete(`${base}/${c.body.id}`)).status).toBe(409); // default
    // Restore the original default; the new policy can now be deleted (unused).
    expect((await latha.patch(`${base}/${oldDefault.id}`, { isDefault: true })).status).toBe(200);
    expect((await latha.delete(`${base}/${c.body.id}`)).status).toBe(204);
    expect((await latha.delete(`${base}/${c.body.id}`)).status).toBe(404);
    const inUse = after.body.items.find((p: { code: string }) => p.code === 'default');
    const ev = await createRegisteredEvidence({ orgCode: 'ps_cubbonpark', uploadedBy: await userId('op.cubbon') });
    expect(ev.id).toBeTruthy();
    expect((await latha.delete(`${base}/${inUse.id}`)).status).toBe(409);
    const audits = await app.db.selectFrom('audit_events').select('details').where('action', '=', 'RETENTION_POLICY_CHANGED').where('resource_id', '=', c.body.id).execute();
    expect(audits.map((a) => (a.details as { op: string }).op).sort()).toEqual(['create', 'delete']);
  });

  it('assigns a policy to evidence and recomputes retain-until on policy change', async () => {
    const registeredAt = new Date('2026-01-01T00:00:00Z');
    const ev = await createRegisteredEvidence({ orgCode: 'ps_cubbonpark', uploadedBy: await userId('op.cubbon'), registeredAt });
    const p = await latha.post(base, { code: 'short_90', name: 'Short (90 days)', retentionDays: 90, archiveAfterDays: 10, longTermAfterDays: null });
    expect((await (await login('io.meera')).post(`/api/v1/evidence/${ev.id}/retention`, { policyId: p.body.id })).status).toBe(403);
    const a = await latha.post(`/api/v1/evidence/${ev.id}/retention`, { policyId: p.body.id });
    expect(a.status).toBe(200);
    expect(new Date(a.body.retainUntil).toISOString()).toBe('2026-04-01T00:00:00.000Z');
    const custody = await app.db.selectFrom('audit_events').select('details').where('action', '=', 'EVIDENCE_RETENTION_ASSIGNED').where('evidence_id', '=', ev.id).executeTakeFirstOrThrow();
    expect((custody.details as { after: { policyId: string } }).after.policyId).toBe(p.body.id);
    const upd = await latha.patch(`${base}/${p.body.id}`, { retentionDays: 120 });
    expect(upd.status).toBe(200);
    expect(upd.body.evidenceCount).toBe(1);
    const row = await app.db.selectFrom('evidence').select('retain_until').where('id', '=', ev.id).executeTakeFirstOrThrow();
    expect(row.retain_until?.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    const indefinite = await latha.patch(`${base}/${p.body.id}`, { retentionDays: null });
    expect(indefinite.status).toBe(200);
    expect((await app.db.selectFrom('evidence').select('retain_until').where('id', '=', ev.id).executeTakeFirstOrThrow()).retain_until).toBeNull();
    expect((await latha.patch(`${base}/${p.body.id}`, { retentionDays: 5 })).status).toBe(400); // archive (10) must precede expiry
    const life = (await latha.get(`/api/v1/evidence/${ev.id}/lifecycle`)).body;
    expect(life.retentionPolicy).toMatchObject({ id: p.body.id, archiveAfterDays: 10 });
  });
});
