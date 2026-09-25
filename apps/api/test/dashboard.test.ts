import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { raiseAlert } from '@ksp/core';
import { Agent, closeApp, login } from './helpers.js';
import { evidenceTestSetup, evidenceTestTeardown, userId } from './evidence-setup.js';
import { createRegisteredEvidence } from './fixtures/evidence.js';

let app: FastifyInstance;
let meera: Agent, arjun: Agent, auditor: Agent, ravi: Agent, admin: Agent, kavya: Agent;
let raviId: string;
const timings: Record<string, unknown> = {};

const orgOf = async (code: string) => app.db.selectFrom('org_units').select(['id', 'path']).where('code', '=', code).executeTakeFirstOrThrow();

/**
 * Ground truth computed independently: live evidence under an org path, plus (for a user) items visible only
 * through a relationship — linked to a case they investigate/supervise/belong to, or shared with them.
 */
async function expectedTotal(path: string | null, username?: string): Promise<number> {
  const uid = username ? await userId(username) : null;
  const r = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM evidence e
     WHERE e.status NOT IN ('DISPOSED','REJECTED')
       AND (${path}::ltree IS NULL OR e.org_path <@ ${path}::ltree
            OR (${uid}::uuid IS NOT NULL AND (
                 e.id IN (SELECT ce.evidence_id FROM case_evidence ce JOIN cases c ON c.id = ce.case_id
                           WHERE ce.unlinked_at IS NULL AND c.status <> 'ARCHIVED'
                             AND (c.investigating_officer_id = ${uid}::uuid OR c.supervisor_id = ${uid}::uuid
                                  OR c.id IN (SELECT case_id FROM case_members WHERE user_id = ${uid}::uuid)))
              OR e.id IN (SELECT si.evidence_id FROM share_items si JOIN shares sh ON sh.id = si.share_id
                           WHERE sh.recipient_user_id = ${uid}::uuid AND sh.status = 'ACTIVE' AND sh.expires_at > now()))))`.execute(app.db);
  return r.rows[0]!.n;
}

async function failedSession(org: string, by: string) {
  const o = await orgOf(org);
  await app.db.insertInto('upload_sessions').values({
    created_by: by, org_unit_id: o.id, original_filename: `fail-${org}.mp4`, declared_size: 10, chunk_size: 16 * 1024 * 1024, total_chunks: 1,
    staging_bucket: app.storage.bucket('staging'), staging_key: `dash/${org}/${Date.now()}`, expires_at: new Date(Date.now() + 3600_000), status: 'FAILED', error: `probe failed at ${org}`,
  }).execute();
}

beforeAll(async () => {
  app = await evidenceTestSetup();
  [meera, arjun, auditor, ravi, admin, kavya] = await Promise.all(['io.meera', 'io.arjun', 'aud.suresh', 'fo.ravi', 'admin', 'sup.kavya'].map((u) => login(u)));
  const op = await userId('op.cubbon');
  raviId = await userId('fo.ravi');
  await createRegisteredEvidence({ orgCode: 'ps_cubbonpark', uploadedBy: op, officerId: raviId, category: 'Traffic' });
  await createRegisteredEvidence({ orgCode: 'ps_cubbonpark', uploadedBy: op, category: 'Protest' });
  await createRegisteredEvidence({ orgCode: 'ps_indiranagar', uploadedBy: op });
  await createRegisteredEvidence({ orgCode: 'ps_nazarbad', uploadedBy: op });
  await failedSession('ps_cubbonpark', raviId);
  await failedSession('ps_indiranagar', op);
  await raiseAlert(app.db, { ruleCode: 'UPLOAD_FAILED', title: 'dash cubbon', message: 'x', orgUnitId: (await orgOf('ps_cubbonpark')).id, dedupeKey: `DASH:${Date.now()}:c` });
  await raiseAlert(app.db, { ruleCode: 'UPLOAD_FAILED', severity: 'CRITICAL', title: 'dash nazarbad', message: 'x', orgUnitId: (await orgOf('ps_nazarbad')).id, dedupeKey: `DASH:${Date.now()}:n` });
}, 180_000);

afterAll(async () => {
  console.info('[dashboard timings ms]', JSON.stringify(timings));
  await evidenceTestTeardown();
  await closeApp();
});

async function summary(a: Agent, qs = '', label?: string) {
  const r = await a.get(`/api/v1/dashboard/summary${qs}`);
  expect(r.status).toBe(200);
  if (label) timings[label] = r.body.meta.timingsMs;
  return r.body;
}

describe('dashboard scoping', () => {
  it('401 unauthenticated; validation', async () => {
    expect((await new Agent(app).get('/api/v1/dashboard/summary')).status).toBe(401);
    expect((await meera.get('/api/v1/dashboard/summary?from=2026-02-01&to=2026-01-01')).status).toBe(400);
    expect((await meera.get('/api/v1/dashboard/summary?orgUnitId=00000000-0000-0000-0000-000000000000')).status).toBe(404);
  });

  it('station IO, other-station IO and state auditor see different totals; no out-of-scope leakage', async () => {
    const cubbon = await orgOf('ps_cubbonpark');
    const indira = await orgOf('ps_indiranagar');
    const m = await summary(meera, '', 'io.meera');
    const a = await summary(arjun, '', 'io.arjun');
    const s = await summary(auditor, '', 'aud.suresh');
    expect(m.evidence.total).toBe(await expectedTotal(cubbon.path, 'io.meera'));
    expect(a.evidence.total).toBe(await expectedTotal(indira.path, 'io.arjun'));
    expect(s.evidence.total).toBe(await expectedTotal(null));
    expect(s.evidence.total).toBeGreaterThan(m.evidence.total);
    // jurisdiction stations only (other stations may appear solely via case/share relationships)
    expect(m.evidence.byStation.map((x: { code: string }) => x.code)).toContain('ps_cubbonpark');
    expect(m.evidence.byStation.map((x: { code: string }) => x.code)).not.toContain('ps_nazarbad');
    expect(a.evidence.byStation.map((x: { code: string }) => x.code)).toContain('ps_indiranagar');
    expect(s.evidence.byStation.map((x: { code: string }) => x.code)).toEqual(expect.arrayContaining(['ps_cubbonpark', 'ps_indiranagar', 'ps_nazarbad']));
    expect(m.evidence.byCategory.map((x: { category: string }) => x.category)).toEqual(expect.arrayContaining(['Traffic', 'Protest']));
    // uploads: meera sees Cubbon failures only
    expect(m.recentFailures.map((f: { title: string }) => f.title)).toContain('fail-ps_cubbonpark.mp4');
    expect(m.recentFailures.map((f: { title: string }) => f.title)).not.toContain('fail-ps_indiranagar.mp4');
    expect(a.recentFailures.map((f: { title: string }) => f.title)).not.toContain('fail-ps_cubbonpark.mp4');
    const perDaySum = m.evidence.perDay.reduce((acc: number, d: { registered: number }) => acc + d.registered, 0);
    expect(perDaySum).toBe(m.evidence.registeredInPeriod);
    expect(m.uploads.perDay.length).toBeGreaterThanOrEqual(30);
    // alerts: station scope only
    const scopedOpen = await app.db.selectFrom('alerts as a').innerJoin('org_units as o', 'o.id', 'a.org_unit_id').select(sql<number>`count(*)::int`.as('n'))
      .where('a.status', '<>', 'RESOLVED').where(sql<boolean>`o.path <@ ${cubbon.path}::ltree`).executeTakeFirstOrThrow();
    expect(m.alerts.open).toBe(scopedOpen.n); // the Nazarbad CRITICAL alert (and system-wide ones) are excluded
    expect(m.meta).toMatchObject({ scope: 'JURISDICTION', sections: { analytics: true, storage: false, system: false, alerts: true } });
    expect(m.storage).toBeNull();
    expect(m.system).toBeNull();
    // auditor has no ai/alerts permissions → sections omitted, not zero-filled
    expect(s.analytics).toBeNull();
    expect(s.alerts).toBeNull();
  });

  it('field officer sees only own uploads/evidence', async () => {
    const r = await summary(ravi, '', 'fo.ravi');
    const own = await app.db.selectFrom('evidence').select(sql<number>`count(*)::int`.as('n')).where('status', 'not in', ['DISPOSED', 'REJECTED'])
      .where((eb) => eb.or([eb('uploaded_by', '=', raviId), eb('officer_id', '=', raviId)])).executeTakeFirstOrThrow();
    expect(r.evidence.total).toBe(own.n);
    expect(r.evidence.total).toBeGreaterThanOrEqual(1);
    expect(r.meta.scope).toBe('OWN');
    expect(r.uploads.byStatus.find((x: { status: string }) => x.status === 'FAILED')?.n).toBeGreaterThanOrEqual(1);
    const ownSessions = await app.db.selectFrom('upload_sessions').select(sql<number>`count(*)::int`.as('n')).where('created_by', '=', raviId).where('created_at', '>=', new Date(Date.now() - 30 * 86_400_000)).executeTakeFirstOrThrow();
    expect(r.uploads.total).toBe(ownSessions.n);
    expect(r.analytics).toBeNull();
  });

  it('supervisor sees the district; station filter narrows it', async () => {
    const central = await orgOf('blr_central');
    const k = await summary(kavya, '', 'sup.kavya');
    expect(k.evidence.total).toBe(await expectedTotal(central.path, 'sup.kavya'));
    const hg = await orgOf('ps_highgrounds');
    const f = await summary(kavya, `?orgUnitId=${hg.id}`);
    expect(f.evidence.total).toBe(await expectedTotal(hg.path));
    expect(f.meta.orgUnit.code).toBe('ps_highgrounds');
    // filtering to a unit outside the viewer's jurisdiction yields nothing (no leak)
    const naz = await orgOf('ps_nazarbad');
    const out = await summary(kavya, `?orgUnitId=${naz.id}`);
    expect(out.evidence.total).toBe(0);
    expect(out.alerts.open).toBe(0);
  });

  it('administrator: system health and storage sections, but no evidence visibility', async () => {
    const r = await summary(admin, '', 'admin');
    expect(r.evidence.total).toBe(0); // SYSTEM_ADMINISTRATOR holds no evidence:read
    expect(r.system.database.ok).toBe(true);
    expect(r.system.objectStorage.ok).toBe(true);
    expect(r.system.queues.items.length).toBeGreaterThan(0);
    expect(r.storage).toHaveProperty('byTier');
    // Physical bucket names never reach a client (E2E finding: they were listed in storage.byBucket).
    const body = JSON.stringify(r);
    for (const role of ['staging', 'evidence', 'archive', 'longterm', 'derived', 'exports', 'reports'] as const) expect(body).not.toContain(`"${app.storage.bucket(role)}"`);
    expect(r.alerts.bySeverity.CRITICAL).toBeGreaterThanOrEqual(1);
    expect(r.meta.timingsMs.total).toEqual(expect.any(Number));
  });
});
