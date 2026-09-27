import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SMTPServer } from 'smtp-server';
import { createMailer } from '@ksp/core';
import { Agent, closeApp, createUser, login } from './helpers.js';
import { evidenceTestSetup, evidenceTestTeardown, userId } from './evidence-setup.js';
import { runReportBuild } from '../../worker/src/jobs/reports/build.js';
import { notifyScheduledRun, runDueSchedules } from '../../worker/src/jobs/reports/schedule.js';

let app: FastifyInstance;
let kavya: Agent, meera: Agent, ravi: Agent, peer: Agent, stationSup: Agent;
let peerId: string, stationSupId: string, kavyaId: string;
const S = '/api/v1/reports/schedules';

beforeAll(async () => {
  app = await evidenceTestSetup();
  [kavya, meera, ravi] = await Promise.all(['sup.kavya', 'io.meera', 'fo.ravi'].map((u) => login(u)));
  kavyaId = await userId('sup.kavya');
  const p = await createUser({ role: 'SUPERVISOR', org: 'blr_central' });
  const s = await createUser({ role: 'SUPERVISOR', org: 'ps_cubbonpark' });
  peerId = p.id;
  stationSupId = s.id;
  await app.db.updateTable('users').set({ email: `${p.username}@ksp.example.invalid` }).where('id', '=', p.id).execute();
  peer = await login(p.username, p.password);
  stationSup = await login(s.username, s.password);
}, 120_000);

afterAll(async () => {
  await evidenceTestTeardown();
  await closeApp();
});

const orgId = async (code: string) => (await app.db.selectFrom('org_units').select('id').where('code', '=', code).executeTakeFirstOrThrow()).id;

describe('scheduled reports API', () => {
  it('401 / 403 / owner-only (others → 404), validation', async () => {
    const anon = new Agent(app);
    expect((await anon.get(S)).status).toBe(401);
    expect((await anon.post(S, { name: 'x', reportType: 'EVIDENCE_INVENTORY', frequency: 'DAILY' })).status).toBe(401);
    expect((await ravi.post(S, { name: 'x', reportType: 'EVIDENCE_INVENTORY', frequency: 'DAILY' })).status).toBe(403); // no reports:generate
    expect((await meera.get(S)).status).toBe(403);
    expect((await kavya.post(S, { name: 'x', reportType: 'ACCESS_AUDIT', frequency: 'DAILY' })).status).toBe(403); // type permission
    expect((await kavya.post(S, { name: 'x', reportType: 'EVIDENCE_INVENTORY', frequency: 'CRON' })).status).toBe(400); // cron missing
    expect((await kavya.post(S, { name: 'x', reportType: 'EVIDENCE_INVENTORY', frequency: 'CRON', cron: 'not a cron' })).status).toBe(400);
    expect((await kavya.post(S, { name: 'x', reportType: 'EVIDENCE_INVENTORY', frequency: 'CRON', cron: '*/5 * * * *' })).status).toBe(400); // too frequent
    expect((await kavya.post(S, { name: 'x', reportType: 'EVIDENCE_INVENTORY', frequency: 'DAILY', hour: 24 })).status).toBe(400);
    expect((await kavya.post(S, { name: 'x', reportType: 'EVIDENCE_INVENTORY', frequency: 'DAILY', timezone: 'Mars/Olympus' })).status).toBe(400);
    expect((await kavya.post(S, { name: 'x', reportType: 'EVIDENCE_INVENTORY', frequency: 'DAILY', orgUnitId: await orgId('ps_nazarbad') })).status).toBe(404);
    // recipient who cannot run the report over the whole scope themselves
    const bad = await kavya.post(S, { name: 'x', reportType: 'EVIDENCE_INVENTORY', frequency: 'DAILY', recipientIds: [stationSupId] });
    expect(bad.status).toBe(400);
    expect((await kavya.post(S, { name: 'x', reportType: 'EVIDENCE_INVENTORY', frequency: 'DAILY', recipientIds: [await userId('io.meera')] })).status).toBe(400);

    const ok = await kavya.post(S, { name: 'Daily inventory', reportType: 'EVIDENCE_INVENTORY', format: 'CSV', frequency: 'WEEKLY', dayOfWeek: 1, hour: 7, minute: 30, recipientIds: [peerId] });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ name: 'Daily inventory', frequency: 'WEEKLY', cron: '30 7 * * 1', timezone: 'Asia/Kolkata', lookbackDays: 7, enabled: true, hour: 7, minute: 30, dayOfWeek: 1, recipients: [{ id: peerId }] });
    expect(new Date(ok.body.nextRunAt).getTime()).toBeGreaterThan(Date.now());
    // Monday 07:30 IST = Monday 02:00 UTC
    expect(new Date(ok.body.nextRunAt).getUTCDay()).toBe(1);
    expect(new Date(ok.body.nextRunAt).toISOString().slice(11, 16)).toBe('02:00');
    const id = ok.body.id as string;
    const audit = await app.db.selectFrom('audit_events').select(['action', 'details']).where('resource_id', '=', id).execute();
    expect(audit.map((a) => a.action)).toEqual(['REPORT_SCHEDULE_CREATED']);

    // other users (even with the same permissions) cannot see / change it
    expect((await peer.get(`${S}/${id}`)).status).toBe(404);
    expect((await peer.patch(`${S}/${id}`, { enabled: false })).status).toBe(404);
    expect((await peer.delete(`${S}/${id}`)).status).toBe(404);
    expect((await peer.get(S)).body.items.map((x: { id: string }) => x.id)).not.toContain(id);

    // station-scoped schedule: the station supervisor is a valid recipient
    const st = await kavya.post(S, { name: 'Cubbon', reportType: 'EVIDENCE_INVENTORY', frequency: 'DAILY', orgUnitId: await orgId('ps_cubbonpark'), recipientIds: [stationSupId] });
    expect(st.status).toBe(201);

    const up = await kavya.patch(`${S}/${id}`, { frequency: 'MONTHLY', dayOfMonth: 5, enabled: false });
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({ frequency: 'MONTHLY', cron: '30 7 5 * *', lookbackDays: 31, enabled: false, nextRunAt: null });
    expect((await kavya.patch(`${S}/${id}`, {})).status).toBe(400);
    expect((await kavya.delete(`${S}/${st.body.id}`)).status).toBe(200);
    expect((await kavya.get(`${S}/${st.body.id}`)).status).toBe(404);
    const acts = await app.db.selectFrom('audit_events').select('action').where('resource_id', 'in', [id, st.body.id]).orderBy('seq').execute();
    expect(acts.map((a) => a.action)).toEqual(['REPORT_SCHEDULE_CREATED', 'REPORT_SCHEDULE_CREATED', 'REPORT_SCHEDULE_UPDATED', 'REPORT_SCHEDULE_DELETED']);
  });

  it('the cron materialises a run under the owner’s jurisdiction at run time, notifies recipients, recipients may download', async () => {
    const c = await kavya.post(S, { name: 'Nightly inventory', reportType: 'EVIDENCE_INVENTORY', format: 'CSV', frequency: 'DAILY', hour: 1, recipientIds: [peerId] });
    expect(c.status).toBe(201);
    const id = c.body.id as string;
    const slot = new Date(Date.now() - 60_000);
    await app.db.updateTable('report_schedules').set({ next_run_at: slot }).where('id', '=', id).execute();
    const queued: string[] = [];
    const r = await runDueSchedules(app.db, { enqueueBuild: async (rid) => { queued.push(rid); } });
    expect(r.created).toHaveLength(1);
    expect(queued).toEqual(r.created);
    // idempotent: the slot has moved on, a second cycle creates nothing
    expect((await runDueSchedules(app.db, { enqueueBuild: async () => undefined })).created).toHaveLength(0);
    const runId = r.created[0]!;
    const run = await app.db.selectFrom('report_runs').selectAll().where('id', '=', runId).executeTakeFirstOrThrow();
    expect(run).toMatchObject({ created_by: kavyaId, schedule_id: id, recipient_ids: [peerId] });
    expect(run.scheduled_for!.getTime()).toBe(Math.floor(slot.getTime() / 1000) * 1000 + (slot.getTime() % 1000));
    expect(run.params).toMatchObject({ scopePaths: ['ksp.blr_city.blr_central'], scheduleId: id, requestedBy: { id: kavyaId } });
    expect(new Date((run.params as { to: string }).to).getTime() - new Date((run.params as { from: string }).from).getTime()).toBe(86_400_000);
    const sched = await app.db.selectFrom('report_schedules').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(sched.last_run_id).toBe(runId);
    expect(sched.next_run_at!.getTime()).toBeGreaterThan(Date.now());
    const req = await app.db.selectFrom('audit_events').select(['actor_type', 'details']).where('action', '=', 'REPORT_REQUESTED').where('resource_id', '=', runId).executeTakeFirstOrThrow();
    expect(req).toMatchObject({ actor_type: 'SYSTEM', details: { scheduleId: id, ownerId: kavyaId } });

    expect((await runReportBuild({ db: app.db, storage: app.storage }, runId)).status).toBe('COMPLETED');
    expect(await notifyScheduledRun(app.db, runId)).toEqual({ notified: 2, emailed: 0 });
    expect(await notifyScheduledRun(app.db, runId)).toEqual({ notified: 0, emailed: 0 }); // once
    const notes = await app.db.selectFrom('notifications').select(['user_id', 'kind', 'link']).where('link', '=', `/reports?run=${runId}`).execute();
    expect(notes.map((n) => n.user_id).sort()).toEqual([kavyaId, peerId].sort());

    // recipient: listed under shared, can read + download; others 404
    const shared = await peer.get('/api/v1/reports/runs?shared=true');
    expect(shared.body.items.map((x: { id: string }) => x.id)).toContain(runId);
    expect((await peer.get('/api/v1/reports/runs')).body.items.map((x: { id: string }) => x.id)).not.toContain(runId);
    expect((await peer.get(`/api/v1/reports/runs/${runId}`)).body).toMatchObject({ scheduleId: id, requestedBy: { id: kavyaId } });
    const link = await peer.post(`/api/v1/reports/runs/${runId}/download-link`);
    expect(link.status).toBe(200);
    const res = await app.inject({ method: 'GET', url: link.body.url });
    expect(res.statusCode).toBe(200);
    const dl = await app.db.selectFrom('audit_events').select(['actor_id', 'details']).where('action', '=', 'REPORT_DOWNLOADED').where('resource_id', '=', runId).executeTakeFirstOrThrow();
    expect(dl).toMatchObject({ actor_id: peerId, details: { asScheduleRecipient: true, scheduleId: id } });
    expect((await stationSup.get(`/api/v1/reports/runs/${runId}`)).status).toBe(404);
    expect((await stationSup.post(`/api/v1/reports/runs/${runId}/download-link`)).status).toBe(404);

    // recipient loses the grant → the run disappears for them (re-checked on access)
    const roles = await app.db.selectFrom('user_roles').select(['user_id', 'role_id', 'org_unit_id']).where('user_id', '=', peerId).execute();
    await app.db.deleteFrom('user_roles').where('user_id', '=', peerId).execute();
    expect((await app.inject({ method: 'GET', url: link.body.url })).statusCode).toBe(404);
    await app.db.insertInto('user_roles').values(roles).execute();
    expect((await app.inject({ method: 'GET', url: link.body.url })).statusCode).toBe(200);
  });

  it('an owner who lost the permission skips the slot (audited) instead of producing data', async () => {
    const u = await createUser({ role: 'SUPERVISOR', org: 'blr_central' });
    const owner = await login(u.username, u.password);
    const c = await owner.post(S, { name: 'Will be skipped', reportType: 'EVIDENCE_INVENTORY', frequency: 'DAILY' });
    expect(c.status).toBe(201);
    await app.db.updateTable('report_schedules').set({ next_run_at: new Date(Date.now() - 1000) }).where('id', '=', c.body.id).execute();
    await app.db.deleteFrom('user_roles').where('user_id', '=', u.id).execute();
    const r = await runDueSchedules(app.db, { enqueueBuild: async () => undefined });
    expect(r.created).toHaveLength(0);
    expect(r.skipped).toEqual([{ scheduleId: c.body.id, reason: expect.stringMatching(/no longer holds reports:generate \+ evidence:read/) }]);
    const s = await app.db.selectFrom('report_schedules').selectAll().where('id', '=', c.body.id).executeTakeFirstOrThrow();
    expect(s.last_error).toMatch(/no longer holds/);
    expect(s.next_run_at!.getTime()).toBeGreaterThan(Date.now());
    expect(await app.db.selectFrom('report_runs').select('id').where('schedule_id', '=', c.body.id).execute()).toHaveLength(0);
    const a = await app.db.selectFrom('audit_events').select('outcome').where('action', '=', 'REPORT_SCHEDULE_SKIPPED').where('resource_id', '=', c.body.id).executeTakeFirstOrThrow();
    expect(a.outcome).toBe('FAILURE');
  });

  it('e-mails the owner and recipients a sign-in link (never a download token) when SMTP is configured', async () => {
    const mails: Array<{ to: string[]; raw: string }> = [];
    const smtp = new SMTPServer({
      authOptional: true, disabledCommands: ['STARTTLS'], logger: false,
      onData(stream, session, cb) {
        let raw = '';
        stream.on('data', (c: Buffer) => (raw += c.toString('utf8')));
        stream.on('end', () => { mails.push({ to: session.envelope.rcptTo.map((r) => r.address), raw: raw.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16))) }); cb(); });
      },
    });
    await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', () => r()));
    try {
      const port = (smtp.server.address() as { port: number }).port;
      const c = await kavya.post(S, { name: 'Mailed inventory', reportType: 'EVIDENCE_INVENTORY', format: 'JSON', frequency: 'DAILY', recipientIds: [peerId] });
      await app.db.updateTable('report_schedules').set({ next_run_at: new Date(Date.now() - 1000) }).where('id', '=', c.body.id).execute();
      const [runId] = (await runDueSchedules(app.db, { enqueueBuild: async () => undefined })).created;
      await runReportBuild({ db: app.db, storage: app.storage }, runId!);
      const mailer = createMailer({ ALERT_SMTP_URL: `smtp://127.0.0.1:${port}`, ALERT_EMAIL_FROM: 'reports@ksp.example' });
      expect(await notifyScheduledRun(app.db, runId!, { mailer, baseUrl: 'https://vms.ksp.example' })).toEqual({ notified: 2, emailed: 2 });
      expect(mails).toHaveLength(1);
      const emails = await app.db.selectFrom('users').select('email').where('id', 'in', [kavyaId, peerId]).execute();
      expect(mails[0]!.to.sort()).toEqual(emails.map((e) => e.email!.toLowerCase()).sort());
      expect(mails[0]!.raw).toContain('Scheduled report ready: Mailed inventory');
      expect(mails[0]!.raw).toContain(`https://vms.ksp.example/reports?run=${runId}`);
      expect(mails[0]!.raw).not.toMatch(/download\?t=|reports\/\d{4}\//);
    } finally {
      await new Promise<void>((r) => smtp.close(() => r()));
    }
  });
});
