/**
 * Chain of custody: completeness of the custody timeline for an item that was registered, viewed, played,
 * downloaded, shared and exported; per-event ledger verification; signed PDF report (embedded payload +
 * detached signature verified with Node crypto AND the openssl CLI commands printed in the report); authz.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, createPublicKey, verify, X509Certificate } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { Agent, closeApp, login } from './helpers.js';
import { evidenceTestSetup, evidenceTestTeardown, userId } from './evidence-setup.js';
import { auditRows, opensslVerify, pdfAttachment, processedEvidence, tmpDir } from './custody-support.js';
import type { MediaEvidence } from './fixtures/media-evidence.js';

let app: FastifyInstance;
let meera: Agent; // IO cubbonpark (custody:read, play, share:create, export:create)
let arjun: Agent; // IO indiranagar (other jurisdiction)
let ravi: Agent; // field officer (no custody:read)
let kavya: Agent; // supervisor blr_central (download_original)
let auditor: Agent; // state-level auditor
let ev: MediaEvidence;
let dir: string;

beforeAll(async () => {
  app = await evidenceTestSetup();
  ev = await processedEvidence('h264');
  [meera, arjun, ravi, kavya, auditor] = await Promise.all(['io.meera', 'io.arjun', 'fo.ravi', 'sup.kavya', 'aud.suresh'].map((u) => login(u)));
  dir = await tmpDir('ksp-custody-');
}, 300_000);

afterAll(async () => {
  await evidenceTestTeardown();
  await closeApp();
  await rm(dir, { recursive: true, force: true });
});

const anon = () => new Agent(app);

describe('custody timeline', () => {
  it('lists every custody touch (view, play, download, share, export) with verified hashes', async () => {
    expect((await meera.get(`/api/v1/evidence/${ev.id}`)).status).toBe(200); // EVIDENCE_VIEWED
    expect((await meera.get(`/api/v1/media/evidence/${ev.id}/playback`)).status).toBe(200); // EVIDENCE_PLAYED
    const orig = await kavya.get(`/api/v1/media/evidence/${ev.id}/original`);
    expect(orig.status).toBe(200);
    expect((await kavya.get(orig.body.url)).status).toBe(200); // EVIDENCE_DOWNLOADED
    const share = await meera.post('/api/v1/shares', {
      evidenceIds: [ev.id], recipientType: 'INTERNAL_USER', recipientUserId: await userId('fa.naveen'), purpose: 'Forensic review of the clip', expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(share.status).toBe(201);
    const exp = await meera.post('/api/v1/exports', { evidenceIds: [ev.id], purpose: 'Production before the magistrate', courtName: 'ACMM Court, Bengaluru', options: { includeOriginal: false, includeWatermarked: true } });
    expect(exp.status).toBe(201);

    const res = await meera.get(`/api/v1/custody/evidence/${ev.id}`);
    expect(res.status).toBe(200);
    const actions = res.body.events.map((e: { action: string }) => e.action);
    for (const a of ['EVIDENCE_VIEWED', 'EVIDENCE_PLAYED', 'EVIDENCE_DOWNLOADED', 'SHARE_CREATED', 'EXPORT_REQUESTED', 'MEDIA_PROCESSING_COMPLETED']) {
      expect(actions, a).toContain(a);
    }
    // Chronological, all linked and verified; matches the ledger rows exactly.
    const seqs = res.body.events.map((e: { seq: number }) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(res.body.events.every((e: { verified: boolean }) => e.verified)).toBe(true);
    const ledger = await auditRows({ evidenceId: ev.id });
    expect(seqs).toEqual(ledger.map((r) => Number(r.seq)));
    expect(res.body.events[0].hash).toBe(ledger[0]!.hash);
    expect(res.body.events[0].prevHash).toBe(ledger[0]!.prev_hash);
    expect(res.body.verification.chainIntact).toBe(true);
    expect(res.body.verification.eventsChecked).toBe(ledger.length);
    expect(res.body.verification.ledgerHead.seq).toBeGreaterThanOrEqual(seqs[seqs.length - 1]);
    expect(res.body.evidence.sha256).toBe(ev.sha256);
    const dl = res.body.events.find((e: { action: string }) => e.action === 'EVIDENCE_DOWNLOADED');
    expect(dl.actor.username).toBe('sup.kavya');
    expect(JSON.stringify(res.body)).not.toMatch(/storage_key|originals\/\d{4}/);
  });

  it('authz: 401 unauthenticated, 403 without custody:read, 404 other jurisdiction, auditor allowed', async () => {
    expect((await anon().get(`/api/v1/custody/evidence/${ev.id}`)).status).toBe(401);
    expect((await ravi.get(`/api/v1/custody/evidence/${ev.id}`)).status).toBe(403);
    expect((await arjun.get(`/api/v1/custody/evidence/${ev.id}`)).status).toBe(404);
    expect((await meera.get('/api/v1/custody/evidence/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await auditor.get(`/api/v1/custody/evidence/${ev.id}`)).status).toBe(200);
    expect((await anon().get(`/api/v1/custody/evidence/${ev.id}/report.pdf`)).status).toBe(401);
    expect((await arjun.get(`/api/v1/custody/evidence/${ev.id}/report.pdf`)).status).toBe(404);
  });
});

describe('signed custody report', () => {
  it('generates a PDF whose embedded payload signature verifies (Node + openssl CLI) and audits it', async () => {
    const before = (await auditRows({ evidenceId: ev.id, action: 'CUSTODY_REPORT_GENERATED' })).length;
    const res = await app.inject({ method: 'GET', url: `/api/v1/custody/evidence/${ev.id}/report.pdf`, headers: { cookie: [...meera.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    const pdf = res.rawPayload;
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const payload = pdfAttachment(pdf, 'custody-payload.json');
    const sig = pdfAttachment(pdf, 'custody-payload.sig');
    const cert = pdfAttachment(pdf, 'signing-cert.pem').toString('utf8');
    expect(createHash('sha256').update(payload).digest('hex')).toBe(res.headers['x-payload-sha256']);
    const parsed = JSON.parse(payload.toString('utf8'));
    expect(parsed.type).toBe('KSP-CUSTODY-REPORT');
    expect(parsed.evidence.sha256).toBe(ev.sha256);
    expect(parsed.evidence.sha512).toBe(ev.sha512);
    expect(parsed.verification.chainIntact).toBe(true);
    expect(parsed.events.map((e: { action: string }) => e.action)).toContain('EVIDENCE_DOWNLOADED');
    const x509 = new X509Certificate(cert);
    expect(x509.fingerprint256).toBe(res.headers['x-certificate-fingerprint']);
    const pub = createPublicKey(x509.publicKey.export({ type: 'spki', format: 'pem' }));
    expect(verify(pub.asymmetricKeyType === 'ed25519' ? null : 'sha256', payload, pub, sig)).toBe(true);
    // The printed openssl commands work on the extracted attachments.
    const ossl = await opensslVerify(dir, { data: 'custody-payload.json', sig: 'custody-payload.sig', cert: 'signing-cert.pem' }, { data: payload, sig, cert });
    expect(ossl.out).toContain('Verified OK');
    // Tampering with one byte of the payload breaks the signature.
    const bad = Buffer.from(payload);
    bad[10] = bad[10]! ^ 1;
    expect(verify(pub.asymmetricKeyType === 'ed25519' ? null : 'sha256', bad, pub, sig)).toBe(false);
    const after = await auditRows({ evidenceId: ev.id, action: 'CUSTODY_REPORT_GENERATED' });
    expect(after.length).toBe(before + 1);
    expect((after[after.length - 1]!.details as { payloadSha256: string }).payloadSha256).toBe(res.headers['x-payload-sha256']);
  });
});
