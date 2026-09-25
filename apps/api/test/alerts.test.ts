import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { raiseAlert } from '@ksp/core';
import { Agent, closeApp, login } from './helpers.js';
import { evidenceTestSetup, evidenceTestTeardown, userId } from './evidence-setup.js';

let app: FastifyInstance;
let meera: Agent, arjun: Agent, kavya: Agent, admin: Agent, ravi: Agent;
const ids: Record<string, string> = {};
const orgId = async (code: string) => (await app.db.selectFrom('org_units').select('id').where('code', '=', code).executeTakeFirstOrThrow()).id;

beforeAll(async () => {
  app = await evidenceTestSetup();
  [meera, arjun, kavya, admin, ravi] = await Promise.all(['io.meera', 'io.arjun', 'sup.kavya', 'admin', 'fo.ravi'].map((u) => login(u)));
  const tag = Date.now();
  ids.cubbon = (await raiseAlert(app.db, { ruleCode: 'UPLOAD_FAILED', title: `Cubbon upload failed ${tag}`, message: 'x', orgUnitId: await orgId('ps_cubbonpark'), resourceType: 'upload_session', resourceId: `s-${tag}`, dedupeKey: `API:c:${tag}` })).id!;
  ids.nazarbad = (await raiseAlert(app.db, { ruleCode: 'PROCESSING_FAILED', title: `Nazarbad job failed ${tag}`, message: 'x', orgUnitId: await orgId('ps_nazarbad'), dedupeKey: `API:n:${tag}` })).id!;
  ids.system = (await raiseAlert(app.db, { ruleCode: 'QUEUE_BACKLOG', severity: 'CRITICAL', title: `Queue backlog ${tag}`, message: 'x', resourceType: 'queue', resourceId: 'media.process', dedupeKey: `API:s:${tag}` })).id!;
}, 120_000);

afterAll(async () => {
  await evidenceTestTeardown();
  await closeApp();
});

const listIds = async (a: Agent, qs = '') => ((await a.get(`/api/v1/alerts?pageSize=200${qs}`)).body.items as Array<{ id: string }>).map((x) => x.id);

describe('alerts API authz & scoping', () => {
  it('401 unauthenticated, 403 without alerts:read', async () => {
    const anon = new Agent(app);
    expect((await anon.get('/api/v1/alerts')).status).toBe(401);
    expect((await anon.get('/api/v1/notifications')).status).toBe(401);
    expect((await ravi.get('/api/v1/alerts')).status).toBe(403);
    expect((await ravi.get(`/api/v1/alerts/${ids.cubbon}`)).status).toBe(403);
  });

  it('jurisdiction: station IO sees station alerts only; supervisor sees district; system-wide alerts only for state-level/monitor', async () => {
    const m = await listIds(meera);
    expect(m).toContain(ids.cubbon);
    expect(m).not.toContain(ids.nazarbad);
    expect(m).not.toContain(ids.system);
    const a = await listIds(arjun);
    expect(a).not.toContain(ids.cubbon);
    const k = await listIds(kavya);
    expect(k).toContain(ids.cubbon);
    expect(k).not.toContain(ids.nazarbad);
    expect(k).not.toContain(ids.system);
    const ad = await listIds(admin);
    expect(ad).toEqual(expect.arrayContaining([ids.cubbon, ids.nazarbad, ids.system]));
    expect((await meera.get(`/api/v1/alerts/${ids.nazarbad}`)).status).toBe(404);
    expect((await kavya.get(`/api/v1/alerts/${ids.system}`)).status).toBe(404);
    const detail = await meera.get(`/api/v1/alerts/${ids.cubbon}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ id: ids.cubbon, ruleCode: 'UPLOAD_FAILED', status: 'OPEN', canManage: false, orgUnit: { code: 'ps_cubbonpark' }, link: '/uploads', deliveries: [] });
    expect((await meera.get('/api/v1/alerts/00000000-0000-0000-0000-000000000000')).status).toBe(404);
  });

  it('filters and summary', async () => {
    expect(await listIds(admin, '&severity=CRITICAL')).toContain(ids.system);
    expect(await listIds(admin, '&severity=CRITICAL')).not.toContain(ids.cubbon);
    expect(await listIds(admin, '&rule=PROCESSING_FAILED&rule=UPLOAD_FAILED')).toEqual(expect.arrayContaining([ids.cubbon, ids.nazarbad]));
    expect(await listIds(admin, '&status=RESOLVED')).not.toContain(ids.cubbon);
    const mys = await listIds(admin, `&orgUnitId=${await orgId('mysuru_dist')}`);
    expect(mys).toContain(ids.nazarbad);
    expect(mys).not.toContain(ids.cubbon);
    expect((await admin.get('/api/v1/alerts?severity=BOGUS')).status).toBe(400);
    const s = await meera.get('/api/v1/alerts/summary');
    expect(s.status).toBe(200);
    const cubbonCritical = await app.db.selectFrom('alerts as a').innerJoin('org_units as o', 'o.id', 'a.org_unit_id').select(sql<number>`count(*)::int`.as('n'))
      .where('a.status', '<>', 'RESOLVED').where('a.severity', '=', 'CRITICAL').where(sql<boolean>`o.path <@ 'ksp.blr_city.blr_central.ps_cubbonpark'::ltree`).executeTakeFirstOrThrow();
    expect(s.body.bySeverity.CRITICAL).toBe(cubbonCritical.n); // the system-wide CRITICAL alert is not in meera's scope
    const sa = await admin.get('/api/v1/alerts/summary');
    expect(sa.body.bySeverity.CRITICAL).toBeGreaterThanOrEqual(1);
  });

  it('acknowledge/resolve: alerts:manage at the alert unit; resolution note required; audited; state machine', async () => {
    expect((await meera.post(`/api/v1/alerts/${ids.cubbon}/acknowledge`, {})).status).toBe(403);
    expect((await kavya.post(`/api/v1/alerts/${ids.nazarbad}/acknowledge`, {})).status).toBe(404);
    const ack = await kavya.post(`/api/v1/alerts/${ids.cubbon}/acknowledge`, { note: 'looking into it' });
    expect(ack.status).toBe(200);
    expect(ack.body).toMatchObject({ status: 'ACKNOWLEDGED', acknowledgedBy: 'Kavya Hegde', canManage: true });
    expect((await kavya.post(`/api/v1/alerts/${ids.cubbon}/acknowledge`, {})).status).toBe(409);
    expect((await kavya.post(`/api/v1/alerts/${ids.cubbon}/resolve`, {})).status).toBe(400);
    expect((await kavya.post(`/api/v1/alerts/${ids.cubbon}/resolve`, { note: 'ok' })).status).toBe(400);
    const res = await kavya.post(`/api/v1/alerts/${ids.cubbon}/resolve`, { note: 'Station network restored; uploads retried.' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'RESOLVED', resolvedBy: 'Kavya Hegde', resolutionNote: 'Station network restored; uploads retried.', autoResolved: false });
    expect((await kavya.post(`/api/v1/alerts/${ids.cubbon}/resolve`, { note: 'again please' })).status).toBe(409);
    const audits = await app.db.selectFrom('audit_events').select(['action', 'actor_id', 'details']).where('resource_type', '=', 'alert').where('resource_id', '=', ids.cubbon!).orderBy('seq').execute();
    expect(audits.map((a) => a.action)).toEqual(['ALERT_ACKNOWLEDGED', 'ALERT_RESOLVED']);
    expect(audits[1]!.actor_id).toBe(await userId('sup.kavya'));
    // system-wide alert: only a root-level alerts:manage holder
    expect((await admin.post(`/api/v1/alerts/${ids.system}/acknowledge`, {})).status).toBe(200);
  });
});

describe('alert rules', () => {
  it('GET requires alerts:manage; PUT requires a state-level grant; config validated; audited', async () => {
    expect((await meera.get('/api/v1/alerts/rules')).status).toBe(403);
    const k = await kavya.get('/api/v1/alerts/rules');
    expect(k.status).toBe(200);
    expect(k.body.canEdit).toBe(false);
    expect(k.body.items.map((r: { code: string }) => r.code)).toEqual(expect.arrayContaining(['UPLOAD_FAILED', 'STORAGE_THRESHOLD', 'AUDIT_CHAIN_BROKEN', 'QUEUE_BACKLOG']));
    expect((await kavya.put('/api/v1/alerts/rules/AUTH_BRUTE_FORCE', { enabled: false })).status).toBe(403);
    expect((await admin.put('/api/v1/alerts/rules/NOPE', { enabled: false })).status).toBe(400);
    expect((await admin.put('/api/v1/alerts/rules/AUTH_BRUTE_FORCE', { config: { failuresPer15Min: -1 } })).status).toBe(400);
    expect((await admin.put('/api/v1/alerts/rules/AUTH_BRUTE_FORCE', { config: { bogus: 1 } })).status).toBe(400);
    expect((await admin.put('/api/v1/alerts/rules/STORAGE_THRESHOLD', { config: { warnPercent: 95, criticalPercent: 90 } })).status).toBe(400);
    expect((await admin.put('/api/v1/alerts/rules/AUTH_BRUTE_FORCE', {})).status).toBe(400);
    const ok = await admin.put('/api/v1/alerts/rules/AUTH_BRUTE_FORCE', { severity: 'WARNING', config: { failuresPer15Min: 50 } });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ code: 'AUTH_BRUTE_FORCE', severity: 'WARNING', config: { failuresPer15Min: 50 }, enabled: true });
    const audit = await app.db.selectFrom('audit_events').select('details').where('action', '=', 'ALERT_RULE_UPDATED').where('resource_id', '=', 'AUTH_BRUTE_FORCE').orderBy('seq', 'desc').executeTakeFirstOrThrow();
    expect(audit.details).toMatchObject({ before: { severity: 'CRITICAL' }, after: { severity: 'WARNING', config: { failuresPer15Min: 50 } } });
    await admin.put('/api/v1/alerts/rules/AUTH_BRUTE_FORCE', { severity: 'CRITICAL', config: { failuresPer15Min: 20 } });
  });
});

describe('notifications (own only)', () => {
  it('lists, marks read, read-all; other users’ notifications are 404', async () => {
    const [mid, kid] = [await userId('io.meera'), await userId('sup.kavya')];
    const [n1] = await app.db.insertInto('notifications').values([{ user_id: mid, kind: 'ALERT_WARNING', title: 'For Meera', link: '/alerts/x' }, { user_id: mid, kind: 'ALERT_CRITICAL', title: 'For Meera 2' }]).returning('id').execute();
    const [nk] = await app.db.insertInto('notifications').values({ user_id: kid, kind: 'ALERT_WARNING', title: 'For Kavya' }).returning('id').execute();
    const l = await meera.get('/api/v1/notifications');
    expect(l.status).toBe(200);
    expect(l.body.items.map((x: { title: string }) => x.title)).toEqual(expect.arrayContaining(['For Meera', 'For Meera 2']));
    expect(l.body.items.map((x: { title: string }) => x.title)).not.toContain('For Kavya');
    expect(l.body.unread).toBeGreaterThanOrEqual(2);
    expect((await meera.post(`/api/v1/notifications/${nk!.id}/read`)).status).toBe(404);
    expect((await meera.post(`/api/v1/notifications/${n1!.id}/read`)).status).toBe(200);
    expect((await meera.get('/api/v1/notifications?unread=true')).body.items.map((x: { id: string }) => x.id)).not.toContain(n1!.id);
    const all = await meera.post('/api/v1/notifications/read-all');
    expect(all.body.updated).toBeGreaterThanOrEqual(1);
    expect((await meera.get('/api/v1/notifications')).body.unread).toBe(0);
    expect((await kavya.get('/api/v1/notifications')).body.unread).toBeGreaterThanOrEqual(1);
  });
});
