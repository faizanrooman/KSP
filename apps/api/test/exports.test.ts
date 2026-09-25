/**
 * Court export end-to-end: request -> SoD approval -> real worker build -> package download -> offline
 * verification with the exact VERIFY.txt commands (openssl + sha256sum) -> online verification; tampered
 * original => FAILED (never shipped); token scope/expiry; revoke; expiry cron; authz matrix; audit per item.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { runProcess, signMediaToken } from '@ksp/core';
import { Agent, closeApp, login } from './helpers.js';
import { evidenceTestSetup, evidenceTestTeardown, userId } from './evidence-setup.js';
import { auditRows, processedEvidence, tmpDir, userWithPerms } from './custody-support.js';
import { createRegisteredEvidence } from './fixtures/evidence.js';
import type { MediaEvidence } from './fixtures/media-evidence.js';
import { runExportBuild } from '../../worker/src/jobs/exports/build.js';
import { runExportsExpire } from '../../worker/src/jobs/exports/index.js';

const LIAISON_PERMS = ['export:create', 'export:download', 'evidence:read', 'evidence:play', 'evidence:download_original', 'custody:read'] as const;

let app: FastifyInstance;
let liaison: Agent; // ps_cubbonpark: export:create + download_original
let cityLiaison: Agent; // blr_city: sees central + east
let both: Agent; // holds export:create AND export:approve
let kavya: Agent; // supervisor blr_central: export:approve
let meera: Agent; // IO (export:create, no download_original)
let arjun: Agent; // IO indiranagar
let ravi: Agent; // field officer
let clip: MediaEvidence;
let east: MediaEvidence;
let dir: string;
let readyId: string;
let readyZip: Buffer;

const deps = () => ({ db: app.db, storage: app.storage, cfg: app.cfg });
const body = (ids: string[], extra: Record<string, unknown> = {}) => ({ evidenceIds: ids, purpose: 'Production before the trial court', courtName: 'City Civil Court, Bengaluru', courtCaseNumber: 'CC 1234/2026', recipient: 'Public Prosecutor, CCH-1', ...extra });

beforeAll(async () => {
  app = await evidenceTestSetup();
  [clip, east] = await Promise.all([processedEvidence('h264', 'ps_cubbonpark'), processedEvidence('frames', 'ps_indiranagar', 'io.arjun')]);
  liaison = await login((await userWithPerms([...LIAISON_PERMS], 'ps_cubbonpark')).username);
  cityLiaison = await login((await userWithPerms([...LIAISON_PERMS], 'blr_city')).username);
  both = await login((await userWithPerms([...LIAISON_PERMS, 'export:approve'], 'ps_cubbonpark')).username);
  [kavya, meera, arjun, ravi] = await Promise.all(['sup.kavya', 'io.meera', 'io.arjun', 'fo.ravi'].map((u) => login(u)));
  dir = await tmpDir('ksp-export-');
}, 300_000);

afterAll(async () => {
  await evidenceTestTeardown();
  await closeApp();
  await rm(dir, { recursive: true, force: true });
});

const anon = () => new Agent(app);

describe('request & approval', () => {
  it('authz: 401 anonymous, 403 without export:create, 403 without download_original for originals', async () => {
    expect((await anon().post('/api/v1/exports', body([clip.id]))).status).toBe(401);
    expect((await anon().get('/api/v1/exports')).status).toBe(401);
    expect((await ravi.post('/api/v1/exports', body([clip.id]))).status).toBe(403);
    expect((await meera.post('/api/v1/exports', body([clip.id]))).status).toBe(403); // includeOriginal requires download_original
    expect((await arjun.post('/api/v1/exports', body([clip.id], { options: { includeOriginal: false, includeWatermarked: true } }))).status).toBe(404);
    expect((await liaison.post('/api/v1/exports', body([clip.id], { options: { includeOriginal: false, includeWatermarked: false } }))).status).toBe(400);
  });

  it('separation of duties: the requester cannot approve (API + DB CHECK)', async () => {
    const r = await both.post('/api/v1/exports', body([clip.id]));
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('PENDING_APPROVAL');
    const a = await both.post(`/api/v1/exports/${r.body.id}/approve`, { note: 'ok' });
    expect(a.status).toBe(403);
    expect(a.body.error.code).toBe('SEPARATION_OF_DUTIES');
    expect((await both.post(`/api/v1/exports/${r.body.id}/reject`, { note: 'not allowed either' })).status).toBe(403);
    const creator = (await app.db.selectFrom('exports').select('created_by').where('id', '=', r.body.id).executeTakeFirstOrThrow()).created_by;
    await expect(app.db.updateTable('exports').set({ approved_by: creator }).where('id', '=', r.body.id).execute()).rejects.toThrow(/check constraint/);
    const denied = await auditRows({ resourceId: r.body.id, action: 'EXPORT_APPROVED' });
    expect(denied.every((d) => d.outcome === 'DENIED')).toBe(true);
    // Pending queue: visible to the in-scope supervisor, not to the requester.
    const pending = await kavya.get('/api/v1/exports?view=pending');
    expect(pending.body.items.map((x: { id: string }) => x.id)).toContain(r.body.id);
    expect((await both.get('/api/v1/exports?view=pending')).body.items.map((x: { id: string }) => x.id)).not.toContain(r.body.id);
    // Out-of-scope approver: 404
    const mys = await login((await userWithPerms(['export:approve', 'evidence:read'], 'mysuru_dist')).username);
    expect((await mys.post(`/api/v1/exports/${r.body.id}/approve`, {})).status).toBe(404);
    expect((await mys.get(`/api/v1/exports/${r.body.id}`)).status).toBe(404);
  });

  it('the approver must be able to see every item', async () => {
    const r = await cityLiaison.post('/api/v1/exports', body([clip.id, east.id]));
    expect(r.status).toBe(201);
    const a = await kavya.post(`/api/v1/exports/${r.body.id}/approve`, {});
    expect(a.status).toBe(403);
    expect(a.body.error.code).toBe('ITEMS_NOT_VISIBLE');
    const reject = await kavya.post(`/api/v1/exports/${r.body.id}/reject`, { note: 'Split the request per station' });
    expect(reject.status).toBe(200);
    expect(reject.body.status).toBe('REJECTED');
    expect((await auditRows({ resourceId: r.body.id, action: 'EXPORT_REJECTED' })).length).toBe(2);
  });
});

describe('package build and contents', () => {
  it('builds a verified, signed package (originals byte-identical, watermarked copy, manifest, fact sheet)', async () => {
    const r = await liaison.post('/api/v1/exports', body([clip.id], { options: { includeOriginal: true, includeWatermarked: true, watermarkText: 'For CC 1234/2026' } }));
    expect(r.status).toBe(201);
    readyId = r.body.id;
    expect((await auditRows({ resourceId: readyId, action: 'EXPORT_REQUESTED' })).map((x) => x.evidence_id)).toEqual([clip.id]);
    const a = await kavya.post(`/api/v1/exports/${readyId}/approve`, { note: 'Approved for production in court' });
    expect(a.status).toBe(200);
    expect(a.body.status).toBe('APPROVED');
    const built = await runExportBuild(deps(), { exportId: readyId });
    expect(built.status, built.reason).toBe('READY');

    const d = await liaison.get(`/api/v1/exports/${readyId}`);
    expect(d.body.status).toBe('READY');
    expect(d.body.items[0].verifiedOk).toBe(true);
    expect(d.body.items[0].verifiedSha256).toBe(clip.sha256);
    expect(d.body.items[0].verifiedSha512).toBe(clip.sha512);
    expect(d.body.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(d.body.expiresAt).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    expect(JSON.stringify(d.body)).not.toMatch(/object_key|exports\/\d{4}\//);
    expect((await auditRows({ resourceId: readyId, action: 'EXPORT_GENERATED' })).map((x) => x.evidence_id)).toEqual([clip.id]);
    expect((await auditRows({ evidenceId: clip.id, action: 'EVIDENCE_INTEGRITY_VERIFIED' })).length).toBeGreaterThanOrEqual(1);

    // Download via a short-lived token; custody-audited per item.
    const link = await liaison.get(`/api/v1/exports/${readyId}/download`);
    expect(link.status).toBe(200);
    expect(link.body.url).toMatch(/^\/api\/v1\/exports\/[0-9a-f-]+\/package\?t=/);
    const pkg = await app.inject({ method: 'GET', url: link.body.url });
    expect(pkg.statusCode).toBe(200);
    expect(pkg.headers['content-type']).toBe('application/zip');
    readyZip = pkg.rawPayload;
    expect(createHash('sha256').update(readyZip).digest('hex')).toBe(d.body.sha256);
    expect(pkg.headers['x-package-sha256']).toBe(d.body.sha256);
    expect((await auditRows({ resourceId: readyId, action: 'EXPORT_DOWNLOADED' })).map((x) => x.evidence_id)).toEqual([clip.id]);
    // Range continuation is not a new download.
    const part = await app.inject({ method: 'GET', url: link.body.url, headers: { range: 'bytes=100-199' } });
    expect(part.statusCode).toBe(206);
    expect(part.rawPayload.length).toBe(100);
    expect((await auditRows({ resourceId: readyId, action: 'EXPORT_DOWNLOADED' })).length).toBe(1);
    expect((await liaison.get(`/api/v1/exports/${readyId}`)).body.downloadCount).toBe(1);
  });

  it('package verifies offline with the exact VERIFY.txt commands; hashes and files are correct', async () => {
    const zipPath = join(dir, 'pkg.zip');
    await writeFile(zipPath, readyZip);
    const out = join(dir, 'pkg');
    execFileSync('unzip', ['-q', zipPath, '-d', out]);
    const top = (await readdir(out)).sort();
    expect(top).toEqual(['FACT_SHEET.pdf', 'SHA256SUMS', 'VERIFY.txt', 'custody', 'manifest.json', 'manifest.sig', 'metadata', 'originals', 'signing-cert.pem', 'watermarked'].sort());
    const [orig] = await readdir(join(out, 'originals'));
    expect(orig).toMatch(new RegExp(`^${clip.evidenceNumber}_`));
    const origBytes = await readFile(join(out, 'originals', orig!));
    expect(createHash('sha256').update(origBytes).digest('hex')).toBe(clip.sha256);
    expect(origBytes.equals(await readFile(clip.path))).toBe(true);

    const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
    expect(manifest.type).toBe('KSP-COURT-EXPORT-MANIFEST');
    expect(manifest.items[0].sha256).toBe(clip.sha256);
    expect(manifest.ledgerHead.seq).toBeGreaterThan(0);
    for (const f of manifest.files) {
      const b = await readFile(join(out, f.path));
      expect(createHash('sha256').update(b).digest('hex'), f.path).toBe(f.sha256);
      expect(b.length).toBe(f.sizeBytes);
    }
    const listed = new Set(manifest.files.map((f: { path: string }) => f.path));
    for (const p of ['FACT_SHEET.pdf', 'SHA256SUMS', 'VERIFY.txt', 'signing-cert.pem', `metadata/${clip.evidenceNumber}.json`, `custody/${clip.evidenceNumber}_custody.pdf`, `watermarked/${clip.evidenceNumber}.mp4`]) expect(listed.has(p), p).toBe(true);
    const meta = JSON.parse(await readFile(join(out, 'metadata', `${clip.evidenceNumber}.json`), 'utf8'));
    expect(meta.evidence.sha512).toBe(clip.sha512);
    expect(meta.evidence.probeSummary.streams.length).toBeGreaterThan(0);

    // Run every command VERIFY.txt tells the recipient to run, verbatim, in the unpacked directory.
    const verifyTxt = await readFile(join(out, 'VERIFY.txt'), 'utf8');
    const cmds = verifyTxt.split('\n').filter((l) => /^ {3}(openssl|sha256sum) /.test(l)).map((l) => l.trim());
    expect(cmds.length).toBeGreaterThanOrEqual(5);
    const outputs = cmds.map((c) => execFileSync('sh', ['-c', `${c} 2>&1`], { cwd: out }).toString());
    expect(outputs.join('\n')).toContain('Verified OK');
    const fp = outputs.find((o) => /Fingerprint/i.test(o))!;
    expect(fp.replace(/^.*=/, '').trim()).toBe(verifyTxt.match(/Expected: (\S+)/)![1]);
    const sums = outputs.find((o) => /: OK$/m.test(o))!;
    expect(sums.trim().split('\n').every((l) => l.endsWith(': OK'))).toBe(true);
    const sumsHash = outputs.find((o) => /^[0-9a-f]{64} {2}SHA256SUMS/.test(o))!.slice(0, 64);
    expect(sumsHash).toBe(manifest.files.find((f: { path: string }) => f.path === 'SHA256SUMS').sha256);
    // A modified manifest no longer verifies.
    await writeFile(join(out, 'manifest.json'), (await readFile(join(out, 'manifest.json'), 'utf8')).replace(clip.sha256, 'a'.repeat(64)));
    const sigCmd = cmds.find((c) => c.includes('-verify'))!;
    expect(() => execFileSync('sh', ['-c', sigCmd], { cwd: out, stdio: 'pipe' })).toThrow();

    // Watermarked copy: a valid MP4 whose frames differ from the unwatermarked proxy at the same position.
    const proxy = await app.db.selectFrom('evidence_derivatives').selectAll().where('evidence_id', '=', clip.id).where('kind', '=', 'PROXY_MP4').executeTakeFirstOrThrow();
    const proxyPath = join(dir, 'proxy.mp4');
    await writeFile(proxyPath, await app.storage.getBuffer(proxy.bucket, proxy.object_key));
    const wm = join(out, 'watermarked', `${clip.evidenceNumber}.mp4`);
    const md5 = async (p: string) => (await runProcess(app.cfg.FFMPEG_PATH, ['-v', 'error', '-ss', '2', '-i', p, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'md5', '-'])).stdout.trim();
    const [a, b] = [await md5(proxyPath), await md5(wm)];
    expect(a).toMatch(/^MD5=/);
    expect(b).toMatch(/^MD5=/);
    expect(a).not.toBe(b);
    const probe = JSON.parse((await runProcess(app.cfg.FFPROBE_PATH, ['-v', 'error', '-print_format', 'json', '-show_format', wm])).stdout);
    expect(Math.abs(Number(probe.format.duration) - 6)).toBeLessThan(0.5);
    expect((await readFile(join(out, 'FACT_SHEET.pdf'))).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('online verification: whole package OK; tampered package / manifest detected', async () => {
    const ok = await liaison.request('POST', '/api/v1/exports/verify', { payload: readyZip, headers: { 'content-type': 'application/octet-stream' } });
    const rep = ok.body;
    expect(ok.status, ok.raw).toBe(200);
    expect(rep.ok).toBe(true);
    expect(rep.signatureValid).toBe(true);
    expect(rep.export).toMatchObject({ known: true, status: 'READY', manifestMatchesRecord: true });
    expect(rep.items[0]).toMatchObject({ knownInRecords: true, sha256: clip.sha256 });
    expect(rep.ledgerHead.existsInLedger).toBe(true);
    expect(rep.files.every((f: { ok: boolean }) => f.ok)).toBe(true);
    // JSON mode with a modified manifest: signature invalid.
    const out = join(dir, 'pkg');
    const manifestText = await readFile(join(out, 'manifest.json'), 'utf8'); // modified in the previous test
    const sig = (await readFile(join(out, 'manifest.sig'))).toString('base64');
    const bad = await liaison.post('/api/v1/exports/verify', { manifest: manifestText, signature: sig });
    expect(bad.status).toBe(200);
    expect(bad.body.signatureValid).toBe(false);
    expect(bad.body.ok).toBe(false);
    expect((await ravi.post('/api/v1/exports/verify', { manifest: manifestText, signature: sig })).status).toBe(403);
    expect((await anon().post('/api/v1/exports/verify', { manifest: manifestText, signature: sig })).status).toBe(401);
  });

  it('a tampered original (recorded hash mismatch) fails the export: never shipped, alert raised', async () => {
    const bad = await createRegisteredEvidence({ orgCode: 'ps_cubbonpark', uploadedBy: await userId('io.meera'), corruptRecordedHash: true });
    const r = await liaison.post('/api/v1/exports', body([bad.id]));
    expect(r.status).toBe(201);
    expect((await kavya.post(`/api/v1/exports/${r.body.id}/approve`, {})).status).toBe(200);
    const built = await runExportBuild(deps(), { exportId: r.body.id });
    expect(built.status).toBe('FAILED');
    const row = await app.db.selectFrom('exports').selectAll().where('id', '=', r.body.id).executeTakeFirstOrThrow();
    expect(row.status).toBe('FAILED');
    expect(row.object_key).toBeNull();
    expect(row.error).toMatch(/Integrity mismatch/);
    const item = await app.db.selectFrom('export_items').selectAll().where('export_id', '=', r.body.id).executeTakeFirstOrThrow();
    expect(item.verified_ok).toBe(false);
    expect(item.verified_sha256).toBe(bad.sha256); // the real hash of the stored bytes
    const alert = await app.db.selectFrom('alerts').selectAll().where('rule_code', '=', 'INTEGRITY_FAILURE').where('resource_id', '=', bad.id).executeTakeFirst();
    expect(alert?.severity).toBe('CRITICAL');
    expect((await auditRows({ resourceId: r.body.id, action: 'EXPORT_FAILED' })).length).toBe(1);
    expect((await auditRows({ evidenceId: bad.id, action: 'EVIDENCE_INTEGRITY_FAILED' })).length).toBe(1);
    expect((await liaison.get(`/api/v1/exports/${r.body.id}/download`)).status).toBe(409);
    expect((await app.storage.list(app.storage.bucket('exports'), `exports/`)).some((o) => o.key.includes(r.body.id))).toBe(false);
  });
});

describe('download tokens, revoke, expiry', () => {
  it('tokens are bound to the export, the scope and a live session; expired tokens are refused', async () => {
    const link = await liaison.get(`/api/v1/exports/${readyId}/download`);
    const t = new URL(link.body.url, 'http://x').searchParams.get('t')!;
    const other = await both.post('/api/v1/exports', body([clip.id]));
    expect((await anon().get(`/api/v1/exports/${other.body.id}/package?t=${encodeURIComponent(t)}`)).status).toBe(403);
    const sess = await app.db.selectFrom('sessions as s').innerJoin('users as u', 'u.id', 's.user_id').select(['s.id', 's.user_id']).where('s.revoked_at', 'is', null).orderBy('s.created_at', 'desc').limit(1).executeTakeFirstOrThrow();
    const wrongScope = signMediaToken({ typ: 'USER', sub: sess.user_id, sid: sess.id, eid: readyId, scope: 'stream', ref: readyId });
    expect((await anon().get(`/api/v1/exports/${readyId}/package?t=${encodeURIComponent(wrongScope)}`)).status).toBe(403);
    const expired = signMediaToken({ typ: 'USER', sub: sess.user_id, sid: sess.id, eid: readyId, scope: 'export', ref: readyId, ttlSeconds: -5 });
    expect((await anon().get(`/api/v1/exports/${readyId}/package?t=${encodeURIComponent(expired)}`)).status).toBe(401);
    expect((await anon().get(`/api/v1/exports/${readyId}/package`)).status).toBe(401);
    const shareTok = signMediaToken({ typ: 'SHARE', sub: readyId, eid: readyId, scope: 'export', ref: readyId });
    expect((await anon().get(`/api/v1/exports/${readyId}/package?t=${encodeURIComponent(shareTok)}`)).status).toBe(401);
    // Download permission matrix
    expect((await meera.get(`/api/v1/exports/${readyId}/download`)).status).toBe(404); // not creator/approver/in-scope approver
    expect((await ravi.get(`/api/v1/exports/${readyId}/download`)).status).toBe(403);
    expect((await kavya.get(`/api/v1/exports/${readyId}/download`)).status).toBe(200); // approver
  });

  it('revoke deletes the package and blocks downloads; audited per item', async () => {
    const r = await liaison.post('/api/v1/exports', body([clip.id], { options: { includeOriginal: true, includeCustodyReport: false, includeFactSheet: false } }));
    await kavya.post(`/api/v1/exports/${r.body.id}/approve`, {});
    expect((await runExportBuild(deps(), { exportId: r.body.id })).status).toBe('READY');
    const row = await app.db.selectFrom('exports').select(['bucket', 'object_key']).where('id', '=', r.body.id).executeTakeFirstOrThrow();
    expect(await app.storage.head(row.bucket!, row.object_key!)).not.toBeNull();
    const link = await liaison.get(`/api/v1/exports/${r.body.id}/download`);
    expect((await arjun.post(`/api/v1/exports/${r.body.id}/revoke`, { reason: 'Not mine to revoke' })).status).toBe(404);
    expect((await liaison.post(`/api/v1/exports/${r.body.id}/revoke`, { reason: 'x' })).status).toBe(400);
    const rv = await liaison.post(`/api/v1/exports/${r.body.id}/revoke`, { reason: 'Court returned the request' });
    expect(rv.status).toBe(200);
    expect(rv.body.status).toBe('REVOKED');
    expect(await app.storage.head(row.bucket!, row.object_key!)).toBeNull();
    expect((await app.inject({ method: 'GET', url: link.body.url })).statusCode).toBe(404);
    expect((await liaison.get(`/api/v1/exports/${r.body.id}/download`)).status).toBe(409);
    expect((await auditRows({ resourceId: r.body.id, action: 'EXPORT_REVOKED' })).length).toBe(1);
  });

  it('exports.expire deletes packages past their retention', async () => {
    const r = await liaison.post('/api/v1/exports', body([clip.id], { options: { includeOriginal: true, includeCustodyReport: false, includeFactSheet: false } }));
    await kavya.post(`/api/v1/exports/${r.body.id}/approve`, {});
    expect((await runExportBuild(deps(), { exportId: r.body.id })).status).toBe('READY');
    const row = await app.db.selectFrom('exports').select(['bucket', 'object_key']).where('id', '=', r.body.id).executeTakeFirstOrThrow();
    await app.db.updateTable('exports').set({ expires_at: new Date(Date.now() - 1000) }).where('id', '=', r.body.id).execute();
    expect((await liaison.get(`/api/v1/exports/${r.body.id}/download`)).status).toBe(410);
    expect(await runExportsExpire({ db: app.db, storage: app.storage })).toBeGreaterThanOrEqual(1);
    expect((await app.db.selectFrom('exports').select('status').where('id', '=', r.body.id).executeTakeFirstOrThrow()).status).toBe('EXPIRED');
    expect(await app.storage.head(row.bucket!, row.object_key!)).toBeNull();
    expect((await auditRows({ resourceId: r.body.id, action: 'EXPORT_EXPIRED' })).length).toBe(1);
  });

  it('lists: mine / all; detail 404 for unrelated users', async () => {
    const mine = await liaison.get('/api/v1/exports?view=mine&pageSize=100');
    expect(mine.status).toBe(200);
    expect(mine.body.items.map((x: { id: string }) => x.id)).toContain(readyId);
    expect(mine.body.total).toBeGreaterThanOrEqual(4);
    const all = await kavya.get('/api/v1/exports?view=all&status=READY');
    expect(all.body.items.map((x: { id: string }) => x.id)).toContain(readyId);
    expect((await arjun.get(`/api/v1/exports/${readyId}`)).status).toBe(404);
    expect((await ravi.get('/api/v1/exports')).status).toBe(403);
  });
});
