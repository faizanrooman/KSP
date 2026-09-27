/**
 * FN-10 / FN-11: unlock + extend of shares, e-mail delivery of the link (and opt-in access code) via a local SMTP
 * sink, link re-issue, deletion of per-share watermarked variants on revoke, maxViews for internal shares.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SMTPServer } from 'smtp-server';
import { resetMailers } from '@ksp/core';
import { Agent, closeApp, login } from './helpers.js';
import { evidenceTestSetup, evidenceTestTeardown, userId } from './evidence-setup.js';
import { createRegisteredEvidence, type CreatedEvidence } from './fixtures/evidence.js';
import { asOwner } from './search-support.js';

let app: FastifyInstance;
let meera: Agent, kavya: Agent, ravi: Agent, mysuru: Agent, arjun: Agent;
let ev: CreatedEvidence;
let smtp: SMTPServer;
const mails: Array<{ to: string[]; raw: string }> = [];

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
const anon = () => new Agent(app);
const external = (extra: Record<string, unknown> = {}) => ({ evidenceIds: [ev.id], recipientType: 'EXTERNAL', recipientName: 'Adv. R. Prakash', recipientEmail: 'pp.office@example.org', recipientOrg: 'Public Prosecutor, CCH-1', purpose: 'Review before trial', expiresAt: inDays(3), ...extra });
const qp = (s: string) => s.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16)));
const actions = async (shareId: string) => (await app.db.selectFrom('audit_events').select(['action', 'outcome', 'details']).where('resource_id', '=', shareId).orderBy('seq').execute());

beforeAll(async () => {
  app = await evidenceTestSetup();
  ev = await createRegisteredEvidence({ orgCode: 'ps_cubbonpark', uploadedBy: await userId('io.meera') });
  [meera, kavya, ravi, mysuru, arjun] = await Promise.all(['io.meera', 'sup.kavya', 'fo.ravi', 'io.mysuru', 'io.arjun'].map((u) => login(u)));
  smtp = new SMTPServer({
    authOptional: true, disabledCommands: ['STARTTLS'], logger: false,
    onData(stream, session, cb) {
      let raw = '';
      stream.on('data', (c: Buffer) => (raw += c.toString('utf8')));
      stream.on('end', () => { mails.push({ to: session.envelope.rcptTo.map((r) => r.address), raw: qp(raw) }); cb(); });
    },
  });
  await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', () => r()));
}, 300_000);

afterAll(async () => {
  delete process.env.ALERT_SMTP_URL;
  resetMailers();
  await new Promise<void>((r) => smtp.close(() => r()));
  await evidenceTestTeardown();
  await closeApp();
});

const withSmtp = () => { process.env.ALERT_SMTP_URL = `smtp://127.0.0.1:${(smtp.server.address() as { port: number }).port}`; process.env.ALERT_EMAIL_FROM = 'KSP VMS <shares@ksp.example>'; };
const withoutSmtp = () => { delete process.env.ALERT_SMTP_URL; };

describe('unlock and extend (FN-10)', () => {
  it('only the sender / share:manage_all may unlock a LOCKED share; attempts reset; audited; the right code works again', async () => {
    const c = await meera.post('/api/v1/shares', external());
    expect(c.status).toBe(201);
    const { share, token, accessCode } = c.body;
    // lock it through the portal: 5 wrong codes
    for (let i = 0; i < 5; i++) await anon().post('/api/v1/share-portal/open', { token, code: accessCode === '00000000' ? '11111111' : '00000000' });
    expect((await app.db.selectFrom('shares').select('status').where('id', '=', share.id).executeTakeFirstOrThrow()).status).toBe('LOCKED');
    expect((await anon().post('/api/v1/share-portal/open', { token, code: accessCode })).status).toBe(423);
    const detail = await meera.get(`/api/v1/shares/${share.id}`);
    expect(detail.body).toMatchObject({ status: 'LOCKED', canUnlock: true, canExtend: true, canReissue: false });

    expect((await anon().post(`/api/v1/shares/${share.id}/unlock`, { reason: 'Recipient confirmed by phone' })).status).toBe(401);
    expect((await ravi.post(`/api/v1/shares/${share.id}/unlock`, { reason: 'Recipient confirmed by phone' })).status).toBe(404);
    expect((await mysuru.post(`/api/v1/shares/${share.id}/unlock`, { reason: 'Recipient confirmed by phone' })).status).toBe(404); // other jurisdiction
    expect((await meera.post(`/api/v1/shares/${share.id}/unlock`, { reason: 'x' })).status).toBe(400);
    const u = await kavya.post(`/api/v1/shares/${share.id}/unlock`, { reason: 'Recipient confirmed by phone' }); // share:manage_all in scope
    expect(u.status).toBe(200);
    expect(u.body).toMatchObject({ status: 'ACTIVE', failedCodeAttempts: 0, lockedAt: null });
    expect((await meera.post(`/api/v1/shares/${share.id}/unlock`, { reason: 'Recipient confirmed by phone' })).status).toBe(409);
    const a = (await actions(share.id)).filter((x) => x.action === 'SHARE_UNLOCKED');
    expect(a).toHaveLength(1);
    expect(a[0]!.details).toMatchObject({ reason: 'Recipient confirmed by phone', failedAttempts: 5 });
    const ok = await anon().post('/api/v1/share-portal/open', { token, code: accessCode });
    expect(ok.status).toBe(200);
  });

  it('extends within the policy maximum from now; reactivates an expired share; revoked → 409', async () => {
    const c = await meera.post('/api/v1/shares', external({ expiresAt: inDays(1) }));
    const id = c.body.share.id as string;
    expect((await meera.post(`/api/v1/shares/${id}/extend`, { expiresAt: inDays(40), reason: 'Trial adjourned' })).status).toBe(400); // policy 30 days
    expect((await meera.post(`/api/v1/shares/${id}/extend`, { expiresAt: new Date(Date.now() + 3600_000).toISOString(), reason: 'Trial adjourned' })).status).toBe(400); // earlier
    expect((await ravi.post(`/api/v1/shares/${id}/extend`, { expiresAt: inDays(10), reason: 'Trial adjourned' })).status).toBe(404);
    const e = await meera.post(`/api/v1/shares/${id}/extend`, { expiresAt: inDays(10), reason: 'Trial adjourned' });
    expect(e.status).toBe(200);
    expect(new Date(e.body.expiresAt).getTime()).toBeGreaterThan(Date.now() + 9 * 86_400_000);
    // expired share → extend brings it back
    await app.db.updateTable('shares').set({ status: 'EXPIRED' }).where('id', '=', id).execute();
    await asOwner((c2) => c2.query(`UPDATE shares SET expires_at = now() - interval '1 minute' WHERE id = $1`, [id]));
    const r = await meera.post(`/api/v1/shares/${id}/extend`, { expiresAt: inDays(5), reason: 'Trial adjourned again' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ACTIVE');
    const ext = (await actions(id)).filter((x) => x.action === 'SHARE_EXTENDED');
    expect(ext.map((x) => (x.details as { reactivated: boolean }).reactivated)).toEqual([false, true]);
    await meera.post(`/api/v1/shares/${id}/revoke`, { reason: 'No longer needed' });
    expect((await meera.post(`/api/v1/shares/${id}/extend`, { expiresAt: inDays(6), reason: 'Trial adjourned' })).status).toBe(409);
  });
});

describe('e-mail delivery and link re-issue (FN-10)', () => {
  it('e-mails the link (never the code) by default; the code only when explicitly requested, in a separate message', async () => {
    withoutSmtp();
    expect((await meera.get('/api/v1/shares/options')).body).toMatchObject({ emailConfigured: false, maxShareDays: 30 });
    expect((await meera.post('/api/v1/shares', external({ emailLink: true }))).status).toBe(400); // not configured
    withSmtp();
    expect((await meera.get('/api/v1/shares/options')).body.emailConfigured).toBe(true);
    expect((await meera.post('/api/v1/shares', external({ emailAccessCode: true }))).status).toBe(400); // code alone never
    expect((await meera.post('/api/v1/shares', { evidenceIds: [ev.id], recipientType: 'INTERNAL_USER', recipientUserId: await userId('io.mysuru'), purpose: 'Assist Mysuru', expiresAt: inDays(2), emailLink: true })).status).toBe(400);

    mails.length = 0;
    const c = await meera.post('/api/v1/shares', external({ emailLink: true }));
    expect(c.status).toBe(201);
    expect(c.body.delivery).toEqual({ link: 'SENT', accessCode: 'NOT_REQUESTED' });
    expect(mails).toHaveLength(1);
    expect(mails[0]!.to).toEqual(['pp.office@example.org']);
    expect(mails[0]!.raw).toContain(c.body.link);
    expect(mails[0]!.raw).not.toContain(c.body.accessCode);
    expect(mails[0]!.raw).toMatch(/access code, which the sender gives you separately/);
    const sent = (await actions(c.body.share.id)).filter((x) => x.action === 'SHARE_LINK_SENT');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.details).toMatchObject({ channel: 'EMAIL', content: 'LINK' });
    expect(JSON.stringify(sent[0]!.details)).not.toContain(c.body.accessCode);

    mails.length = 0;
    const both = await meera.post('/api/v1/shares', external({ emailLink: true, emailAccessCode: true }));
    expect(both.body.delivery).toEqual({ link: 'SENT', accessCode: 'SENT' });
    expect(mails).toHaveLength(2);
    const [linkMail, codeMail] = mails;
    expect(linkMail!.raw).not.toContain(both.body.accessCode);
    expect(codeMail!.raw).toContain(both.body.accessCode);
    expect(codeMail!.raw).not.toContain(both.body.token);
  });

  it('re-issue invalidates the old link, optionally rotates the code, and can e-mail the new link', async () => {
    withSmtp();
    const c = await meera.post('/api/v1/shares', external());
    const { share, token, accessCode } = c.body;
    expect((await arjun.post(`/api/v1/shares/${share.id}/reissue`, { reason: 'Recipient lost the link' })).status).toBe(404);
    expect((await meera.post(`/api/v1/shares/${share.id}/reissue`, { reason: 'Recipient lost the link', emailLink: true, emailAccessCode: true })).status).toBe(400); // code not rotated
    mails.length = 0;
    const r = await meera.post(`/api/v1/shares/${share.id}/reissue`, { reason: 'Recipient lost the link', rotateAccessCode: true, emailLink: true });
    expect(r.status).toBe(200);
    expect(r.body.token).not.toBe(token);
    expect(r.body.accessCode).toMatch(/^\d{8}$/);
    expect(r.body.delivery).toEqual({ link: 'SENT', accessCode: 'NOT_REQUESTED' });
    expect(mails[0]!.raw).toContain(r.body.link);
    expect((await anon().post('/api/v1/share-portal/open', { token, code: accessCode })).status).toBe(401); // old link dead (uniform 401)
    expect((await anon().post('/api/v1/share-portal/open', { token: r.body.token, code: accessCode })).status).toBe(401); // old code dead
    expect((await anon().post('/api/v1/share-portal/open', { token: r.body.token, code: r.body.accessCode })).status).toBe(200);
    const re = (await actions(share.id)).filter((x) => x.action === 'SHARE_LINK_REISSUED');
    expect(re[0]!.details).toMatchObject({ accessCodeRotated: true, emailLink: true });
    expect(JSON.stringify(re[0]!.details)).not.toMatch(new RegExp(`${r.body.accessCode}|${r.body.token}`));
    // internal shares have no link
    const i = await meera.post('/api/v1/shares', { evidenceIds: [ev.id], recipientType: 'INTERNAL_USER', recipientUserId: await userId('io.mysuru'), purpose: 'Assist Mysuru', expiresAt: inDays(2) });
    expect((await meera.post(`/api/v1/shares/${i.body.share.id}/reissue`, { reason: 'Recipient lost the link' })).status).toBe(409);
    await meera.post(`/api/v1/shares/${i.body.share.id}/revoke`, { reason: 'Test clean-up' });
  });
});

describe('revoke deletes the per-share watermarked variants (FN-10)', () => {
  it('removes object + derivative row and records SHARE_WATERMARK_DELETED', async () => {
    const c = await meera.post('/api/v1/shares', external());
    const id = c.body.share.id as string;
    const bucket = app.storage.bucket('derived');
    const key = `evidence/${ev.id}/shares/${id}/watermarked.mp4`;
    await app.storage.put(bucket, key, Buffer.from('fake watermarked video'), { contentType: 'video/mp4' });
    await app.db.insertInto('evidence_derivatives').values({ evidence_id: ev.id, kind: 'WATERMARKED', bucket, object_key: key, mime_type: 'video/mp4', size_bytes: 22, sha256: 'b'.repeat(64), meta: JSON.stringify({ shareId: id }) }).execute();
    expect(await app.storage.head(bucket, key)).not.toBeNull();
    expect((await meera.post(`/api/v1/shares/${id}/revoke`, { reason: 'Sent to the wrong address' })).status).toBe(200);
    expect(await app.db.selectFrom('evidence_derivatives').select('id').where('object_key', '=', key).executeTakeFirst()).toBeUndefined();
    expect(await app.storage.head(bucket, key)).toBeNull();
    const del = (await actions(id)).filter((x) => x.action === 'SHARE_WATERMARK_DELETED');
    expect(del).toHaveLength(1);
    expect(del[0]!.details).toMatchObject({ reason: 'share revoked' });
  });
});

describe('maxViews for internal shares (FN-11)', () => {
  it('counts share-based opens (detail/playback once per 30-min window) and stops granting visibility when used up', async () => {
    const mid = await userId('io.mysuru');
    const c = await meera.post('/api/v1/shares', { evidenceIds: [ev.id], recipientType: 'INTERNAL_USER', recipientUserId: mid, purpose: 'Assist Mysuru', expiresAt: inDays(2), maxViews: 2 });
    expect(c.status).toBe(201);
    const id = c.body.share.id as string;
    const views = async () => (await app.db.selectFrom('shares').select('view_count').where('id', '=', id).executeTakeFirstOrThrow()).view_count;
    const age = () => asOwner(async (o) => {
      await o.query(`UPDATE share_access_log SET created_at = created_at - interval '31 minutes' WHERE share_id = $1`, [id]);
      await o.query(`UPDATE shares SET last_accessed_at = last_accessed_at - interval '31 minutes' WHERE id = $1`, [id]);
    });
    expect((await mysuru.get(`/api/v1/evidence/${ev.id}`)).status).toBe(200);
    expect(await views()).toBe(1);
    expect((await mysuru.get(`/api/v1/media/evidence/${ev.id}/playback`)).status).toBe(200); // same viewing session
    expect((await mysuru.get(`/api/v1/evidence/${ev.id}`)).status).toBe(200);
    expect(await views()).toBe(1);
    // jurisdiction-based access never counts
    expect((await meera.get(`/api/v1/evidence/${ev.id}`)).status).toBe(200);
    expect(await views()).toBe(1);
    await age();
    expect((await mysuru.get(`/api/v1/media/evidence/${ev.id}/playback`)).status).toBe(200);
    expect(await views()).toBe(2);
    expect((await mysuru.get(`/api/v1/evidence/${ev.id}`)).status).toBe(200); // still inside the last session
    await age();
    expect((await mysuru.get(`/api/v1/evidence/${ev.id}`)).status).toBe(404); // used up
    expect((await mysuru.get(`/api/v1/evidence?pageSize=200`)).body.items.map((x: { id: string }) => x.id)).not.toContain(ev.id);
    expect(await views()).toBe(2);
    const acc = (await actions(id)).filter((x) => x.action === 'SHARE_ACCESSED');
    expect(acc.map((x) => (x.details as { view: number; via: string }).view)).toEqual([1, 2]);
    expect(acc.every((x) => (x.details as { via: string }).via === 'internal')).toBe(true);
    const log = await app.db.selectFrom('share_access_log').select(['action', 'detail']).where('share_id', '=', id).execute();
    expect(log).toEqual([{ action: 'VIEW', detail: `internal:${mid}` }, { action: 'VIEW', detail: `internal:${mid}` }]);
  });
});
