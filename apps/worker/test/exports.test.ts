/**
 * Worker: court export build through the REAL pg-boss queue (EXPORT_BUILD consumer registered by the job
 * module), case/FIR fact sheet, watermarked-only packages, and the share.watermark queue consumer.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enqueue, evidenceSigner, hashSecret, logger, randomToken, sha256Hex, stopQueue, type Database } from '@ksp/core';
import { QUEUES } from '@ksp/shared';
import { createMediaEvidence, type MediaEvidence } from '../../api/test/fixtures/media-evidence.js';
import { startWorker } from '../src/main.js';
import { processMedia } from '../src/jobs/media/process.js';
import { runShareWatermark } from '../src/jobs/shares/index.js';
import type { WorkerContext } from '../src/lib/context.js';

let ctx: WorkerContext;
let db: Database;
let clip: MediaEvidence;
let dir: string;
const ids: Record<string, string> = {};

async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, ms = 90_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 300));
  }
}

beforeAll(async () => {
  ctx = await startWorker(['exports', 'shares', 'audit']);
  db = ctx.db;
  for (const u of ['io.meera', 'sup.kavya']) ids[u] = (await db.selectFrom('users').select('id').where('username', '=', u).executeTakeFirstOrThrow()).id;
  clip = await createMediaEvidence(db, ctx.storage, { kind: 'h264', org: 'ps_cubbonpark', uploadedBy: 'io.meera' });
  const r = await processMedia({ db, storage: ctx.storage, cfg: ctx.cfg, log: logger().child({ test: 'worker-exports' }) }, { evidenceId: clip.id });
  expect(r.status).toBe('READY');
  dir = await mkdtemp(join(tmpdir(), 'ksp-wexp-'));
}, 300_000);

afterAll(async () => {
  await stopQueue();
  await db.destroy();
  await rm(dir, { recursive: true, force: true });
});

async function approvedExport(options: Record<string, unknown>, caseId: string | null = null): Promise<string> {
  const org = await db.selectFrom('org_units').select('id').where('code', '=', 'ps_cubbonpark').executeTakeFirstOrThrow();
  const x = await db
    .insertInto('exports')
    .values({ export_number: `EXP-T-${randomUUID().slice(0, 8)}`, created_by: ids['io.meera']!, org_unit_id: org.id, case_id: caseId, purpose: 'Worker test export', court_name: 'Sessions Court', recipient: 'PP', options: JSON.stringify(options), status: 'APPROVED', approved_by: ids['sup.kavya']!, approved_at: new Date() })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db.insertInto('export_items').values({ export_id: x.id, evidence_id: clip.id, expected_sha256: clip.sha256, expected_sha512: clip.sha512 }).execute();
  return x.id;
}

describe('EXPORT_BUILD via the queue', () => {
  it('builds a READY package with a case/FIR fact sheet; the stored package hash and manifest signature verify', async () => {
    const org = await db.selectFrom('org_units').select(['id', 'path']).where('code', '=', 'ps_cubbonpark').executeTakeFirstOrThrow();
    const fir = await db.insertInto('firs').values({ fir_number: `FIR-${randomUUID().slice(0, 6)}`, fir_year: 2026, org_unit_id: org.id, org_path: org.path, registered_at: new Date(), acts_sections: ['BNS 115(2)', 'BNS 351(2)'], place_of_occurrence: 'MG Road', brief_facts: 'Altercation recorded on BWC.' } as never).returning('id').executeTakeFirstOrThrow();
    const c = await db.insertInto('cases').values({ case_number: `CASE-${randomUUID().slice(0, 6)}`, title: 'State v. Accused', org_unit_id: org.id, org_path: org.path, fir_id: fir.id, investigating_officer_id: ids['io.meera']! } as never).returning('id').executeTakeFirstOrThrow();
    const id = await approvedExport({ includeOriginal: true, includeWatermarked: false, includeCustodyReport: true, includeFactSheet: true }, c.id);
    await enqueue(QUEUES.EXPORT_BUILD, { exportId: id }, { singletonKey: id });
    const row = await waitFor(async () => {
      const r = await db.selectFrom('exports').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
      return ['READY', 'FAILED'].includes(r.status) ? r : undefined;
    });
    expect(row.status, row.error ?? '').toBe('READY');
    const zip = await ctx.storage.getBuffer(row.bucket!, row.object_key!);
    expect(createHash('sha256').update(zip).digest('hex')).toBe(row.sha256);
    expect(zip.length).toBe(Number(row.size_bytes));
    await writeFile(join(dir, 'a.zip'), zip);
    execFileSync('unzip', ['-q', join(dir, 'a.zip'), '-d', join(dir, 'a')]);
    const manifest = await readFile(join(dir, 'a', 'manifest.json'));
    expect(createHash('sha256').update(manifest).digest('hex')).toBe(row.manifest_sha256);
    const sig = await readFile(join(dir, 'a', 'manifest.sig'));
    expect(evidenceSigner().verify(manifest, sig.toString('base64'))).toBe(true);
    expect(sig.toString('base64')).toBe(row.signature);
    const m = JSON.parse(manifest.toString());
    expect(m.export.caseNumber).toMatch(/^CASE-/);
    expect(m.files.some((f: { role: string }) => f.role === 'watermarked')).toBe(false);
    expect((await readdir(join(dir, 'a'))).includes('watermarked')).toBe(false);
    const fs = await readFile(join(dir, 'a', 'FACT_SHEET.pdf'));
    expect(fs.subarray(0, 5).toString()).toBe('%PDF-');
    expect(fs.length).toBeGreaterThan(3000);
    const audit = await db.selectFrom('audit_events').select(['action', 'actor_id']).where('resource_id', '=', id).orderBy('seq').execute();
    expect(audit.map((a) => a.action)).toContain('EXPORT_GENERATED');
    expect(audit.find((a) => a.action === 'EXPORT_GENERATED')!.actor_id).toBe('export-worker');
  });

  it('watermarked-only package: no originals, watermarked copy present and listed', async () => {
    const id = await approvedExport({ includeOriginal: false, includeWatermarked: true, includeCustodyReport: false, includeFactSheet: false });
    await enqueue(QUEUES.EXPORT_BUILD, { exportId: id }, { singletonKey: id });
    const row = await waitFor(async () => {
      const r = await db.selectFrom('exports').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
      return ['READY', 'FAILED'].includes(r.status) ? r : undefined;
    });
    expect(row.status, row.error ?? '').toBe('READY');
    await writeFile(join(dir, 'b.zip'), await ctx.storage.getBuffer(row.bucket!, row.object_key!));
    execFileSync('unzip', ['-q', join(dir, 'b.zip'), '-d', join(dir, 'b')]);
    const top = await readdir(join(dir, 'b'));
    expect(top).not.toContain('originals');
    expect(top).toContain('watermarked');
    expect(execFileSync('sha256sum', ['-c', 'SHA256SUMS'], { cwd: join(dir, 'b') }).toString()).toMatch(/watermarked\/.*: OK/);
  });

  it('skips exports that are not APPROVED (idempotent retries)', async () => {
    const { runExportBuild } = await import('../src/jobs/exports/build.js');
    const id = await approvedExport({ includeOriginal: true });
    await db.updateTable('exports').set({ status: 'REVOKED' }).where('id', '=', id).execute();
    expect((await runExportBuild({ db, storage: ctx.storage, cfg: ctx.cfg }, { exportId: id })).status).toBe('SKIPPED');
  });
});

describe('share.watermark via the queue', () => {
  it('generates the per-share watermarked variant', async () => {
    const org = await db.selectFrom('org_units').select('id').where('code', '=', 'ps_cubbonpark').executeTakeFirstOrThrow();
    const s = await db
      .insertInto('shares')
      .values({ created_by: ids['sup.kavya']!, org_unit_id: org.id, recipient_type: 'EXTERNAL', recipient_name: 'Queue Test', recipient_email: 'queue@example.org', purpose: 'worker test', token_hash: sha256Hex(randomToken()), access_code_hash: await hashSecret('12345678'), expires_at: new Date(Date.now() + 86_400_000) })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db.insertInto('share_items').values({ share_id: s.id, evidence_id: clip.id }).execute();
    await enqueue(QUEUES.SHARE_WATERMARK, { shareId: s.id, evidenceId: clip.id }, { singletonKey: `${s.id}:${clip.id}` });
    const d = await waitFor(() => db.selectFrom('evidence_derivatives').selectAll().where('object_key', '=', `evidence/${clip.id}/shares/${s.id}/watermarked.mp4`).executeTakeFirst());
    expect(d.kind).toBe('WATERMARKED');
    expect(Number(d.size_bytes)).toBeGreaterThan(10_000);
    expect(await ctx.storage.head(d.bucket, d.object_key)).not.toBeNull();
  });

  // Regression: the portal enqueues one job per playback/stream/print request, so the same (share, evidence) pair
  // ran twice concurrently; both used one work directory and the loser failed ("SHARE_WATERMARK failed for ..." alerts).
  it('concurrent jobs for the same share item: exactly one burns the variant, none fails', async () => {
    const org = await db.selectFrom('org_units').select('id').where('code', '=', 'ps_cubbonpark').executeTakeFirstOrThrow();
    const s = await db
      .insertInto('shares')
      .values({ created_by: ids['sup.kavya']!, org_unit_id: org.id, recipient_type: 'EXTERNAL', recipient_name: 'Race Test', recipient_email: 'race@example.org', purpose: 'worker race test', token_hash: sha256Hex(randomToken()), access_code_hash: await hashSecret('12345678'), expires_at: new Date(Date.now() + 86_400_000) })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db.insertInto('share_items').values({ share_id: s.id, evidence_id: clip.id }).execute();
    const since = new Date();
    const deps = { db, storage: ctx.storage, cfg: ctx.cfg };
    const results = await Promise.all([1, 2, 3].map(() => runShareWatermark(deps, { shareId: s.id, evidenceId: clip.id })));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((x) => x === 'CREATED')).toHaveLength(1);
    expect(statuses.every((x) => x === 'CREATED' || x === 'EXISTS' || x === 'SKIPPED')).toBe(true);
    const failed = await db.selectFrom('processing_jobs').select('id').where('kind', '=', 'SHARE_WATERMARK').where('evidence_id', '=', clip.id).where('status', '=', 'FAILED').where('created_at', '>=', since).execute();
    expect(failed).toHaveLength(0);
    // A later job for the same pair is an idempotent no-op.
    expect((await runShareWatermark(deps, { shareId: s.id, evidenceId: clip.id })).status).toBe('EXISTS');
  }, 180_000);
});
