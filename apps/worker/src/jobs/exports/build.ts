/**
 * EXPORT_BUILD: build the court export package for an APPROVED export.
 *
 *  1. Re-verify every stored original (stream + SHA-256/512 == registered). Any mismatch or missing object
 *     => export FAILED, CRITICAL INTEGRITY_FAILURE alert, EVIDENCE_INTEGRITY_FAILED + EXPORT_FAILED custody
 *     events. Nothing is shipped.
 *  2. Generate artefacts (metadata JSON, signed custody PDFs, watermarked MP4 from the proxy, FACT_SHEET.pdf,
 *     VERIFY.txt, SHA256SUMS), then manifest.json (+ detached manifest.sig).
 *  3. Stream a ZIP (yazl, no full buffering) straight into the exports bucket; originals are re-hashed on the
 *     way in and the upload aborts if a byte differs from the verified hash.
 *  4. READY + package SHA-256, expires_at = now + shareExportPolicy.exportRetentionDays; EXPORT_GENERATED per item.
 *
 * Package layout (docs/COURT-EXPORT.md):
 *   originals/<evidenceNumber>_<name>        byte-identical originals
 *   watermarked/<evidenceNumber>.mp4         optional viewing copies (burn-in: export no., recipient, date, COPY - NOT ORIGINAL, timecode)
 *   metadata/<evidenceNumber>.json           full metadata
 *   custody/<evidenceNumber>_custody.pdf     signed chain-of-custody report
 *   FACT_SHEET.pdf, signing-cert.pem, VERIFY.txt, SHA256SUMS, manifest.json, manifest.sig
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, Transform, type Readable } from 'node:stream';
import yazl from 'yazl';
import { appendAudit, evidenceSigner, hashStream, systemActor, type AppConfig, type Database, type Signer, type Storage, type Tx } from '@ksp/core';
import {
  buildCustodyReport, burnWatermark, ledgerHead, loadEvidenceRecord, loadPerson, manifestBytes, MANIFEST_TYPE, raiseAlert, renderFactSheet, sha256sums, verifyInstructions,
  type EvidenceRecord, type ExportManifest, type FactSheetData, type ManifestFile, type ManifestFileRole,
} from '@ksp/core/custody';
import { DEFAULT_SETTINGS, type ExportBuildPayload } from '@ksp/shared';

export const EXPORT_ACTOR = systemActor('export-worker');

export interface ExportDeps {
  db: Database;
  storage: Storage;
  cfg: AppConfig;
  signer?: Signer;
  log?: { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void; error: (o: object, m?: string) => void };
}

export interface ExportBuildResult {
  status: 'READY' | 'FAILED' | 'SKIPPED';
  reason?: string;
  sha256?: string;
  objectKey?: string;
}

interface ExportOptions {
  includeOriginal?: boolean;
  includeWatermarked?: boolean;
  includeCustodyReport?: boolean;
  includeFactSheet?: boolean;
  watermarkText?: string;
}

type Source = { kind: 'object'; bucket: string; key: string; versionId?: string | null; expectSha256: string } | { kind: 'file'; path: string } | { kind: 'buffer'; data: Buffer };
interface Entry extends ManifestFile {
  source: Source;
  compress: boolean;
}

export function safePart(v: string): string {
  return v.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 150) || 'item';
}

async function exportRetentionDays(db: Database): Promise<number> {
  const r = await db.selectFrom('system_settings').select('value').where('key', '=', 'shareExportPolicy').executeTakeFirst();
  const v = { ...DEFAULT_SETTINGS.shareExportPolicy, ...((r?.value as object | undefined) ?? {}) };
  return v.exportRetentionDays;
}

async function perItem(db: Database | Tx, action: Parameters<typeof appendAudit>[2]['action'], ex: { id: string; export_number: string; case_id: string | null }, items: Array<{ evidence_id: string; org_unit_id: string }>, details: Record<string, unknown>, outcome?: 'SUCCESS' | 'FAILURE') {
  for (const it of items) {
    await appendAudit(db, EXPORT_ACTOR, { action, outcome, resourceType: 'export', resourceId: ex.id, evidenceId: it.evidence_id, caseId: ex.case_id, orgUnitId: it.org_unit_id, details: { exportNumber: ex.export_number, ...details } });
  }
}

export async function runExportBuild(deps: ExportDeps, payload: ExportBuildPayload): Promise<ExportBuildResult> {
  const { db, storage, cfg } = deps;
  const signer = deps.signer ?? evidenceSigner();
  const ex = await db.selectFrom('exports').selectAll().where('id', '=', payload.exportId).executeTakeFirst();
  if (!ex || !['APPROVED', 'PROCESSING'].includes(ex.status)) return { status: 'SKIPPED', reason: ex ? `export is ${ex.status}` : 'export not found' };
  await db.updateTable('exports').set({ status: 'PROCESSING', started_at: new Date(), progress: 0, error: null }).where('id', '=', ex.id).where('status', 'in', ['APPROVED', 'PROCESSING']).execute();
  const opts = (ex.options ?? {}) as ExportOptions;
  const includeOriginal = opts.includeOriginal !== false;
  const includeWatermarked = !!opts.includeWatermarked;
  const includeCustody = opts.includeCustodyReport !== false;
  const includeFactSheet = opts.includeFactSheet !== false;
  const items = await db
    .selectFrom('export_items as xi')
    .innerJoin('evidence as e', 'e.id', 'xi.evidence_id')
    .select(['xi.evidence_id', 'xi.expected_sha256', 'e.org_unit_id', 'e.evidence_number', 'e.status', 'e.sha256', 'e.sha512', 'e.size_bytes', 'e.storage_bucket', 'e.storage_key', 'e.storage_version_id', 'e.original_filename', 'e.recorded_at'])
    .where('xi.export_id', '=', ex.id)
    .orderBy('e.evidence_number')
    .execute();
  const work = join(cfg.WORK_DIR, `export-${ex.id}`);
  await mkdir(work, { recursive: true });
  const setProgress = (f: number) => db.updateTable('exports').set({ progress: Math.max(0, Math.min(0.99, f)) }).where('id', '=', ex.id).execute();

  const fail = async (reason: string, badItem?: { evidence_id: string; org_unit_id: string; evidence_number: string | null }, actual?: { sha256: string | null; sha512: string | null }) => {
    await db.transaction().execute(async (tx) => {
      await tx.updateTable('exports').set({ status: 'FAILED', error: reason.slice(0, 4000), completed_at: new Date() }).where('id', '=', ex.id).execute();
      if (badItem) {
        await tx.updateTable('export_items').set({ verified_ok: false, verified_sha256: actual?.sha256 ?? null, verified_sha512: actual?.sha512 ?? null, verified_at: new Date(), verify_error: reason.slice(0, 2000) }).where('export_id', '=', ex.id).where('evidence_id', '=', badItem.evidence_id).execute();
        await appendAudit(tx, EXPORT_ACTOR, { action: 'EVIDENCE_INTEGRITY_FAILED', outcome: 'FAILURE', resourceType: 'evidence', resourceId: badItem.evidence_id, evidenceId: badItem.evidence_id, orgUnitId: badItem.org_unit_id, details: { trigger: 'EXPORT', exportId: ex.id, exportNumber: ex.export_number, error: reason, actualSha256: actual?.sha256 ?? null } });
        await raiseAlert(tx, { ruleCode: 'INTEGRITY_FAILURE', severity: 'CRITICAL', title: `Integrity check failed for ${badItem.evidence_number ?? badItem.evidence_id} during export ${ex.export_number}`, message: reason, resourceType: 'evidence', resourceId: badItem.evidence_id, orgUnitId: badItem.org_unit_id, dedupeKey: `INTEGRITY_FAILURE:${badItem.evidence_id}` });
      }
      await perItem(tx, 'EXPORT_FAILED', ex, items, { reason, failedItem: badItem?.evidence_id ?? null }, 'FAILURE');
    });
    deps.log?.warn({ exportId: ex.id, reason }, 'export failed');
    return { status: 'FAILED' as const, reason };
  };

  try {
    // ---- 1. integrity re-verification ---------------------------------------------------------
    const verified = new Map<string, { sha256: string; sha512: string; size: number; at: Date }>();
    let done = 0;
    for (const it of items) {
      if (!['REGISTERED', 'DISPOSAL_PENDING'].includes(it.status) || !it.storage_bucket || !it.storage_key || !it.sha256) return await fail(`Evidence ${it.evidence_number ?? it.evidence_id} is not available (status ${it.status})`, it);
      let h: { sha256: string; sha512: string; size: number };
      try {
        h = await hashStream(await storage.getStream(it.storage_bucket, it.storage_key, undefined, it.storage_version_id ?? undefined));
      } catch (err) {
        return await fail(`Stored original of ${it.evidence_number ?? it.evidence_id} could not be read: ${(err as Error).message}`, it);
      }
      const mismatch = [h.sha256 !== it.sha256 && 'sha256', it.sha512 && h.sha512 !== it.sha512 && 'sha512', h.sha256 !== it.expected_sha256 && 'requested sha256', h.size !== Number(it.size_bytes) && 'size'].filter(Boolean);
      if (mismatch.length) return await fail(`Integrity mismatch for ${it.evidence_number ?? it.evidence_id} (${mismatch.join(', ')}): stored original does not match the registered hash`, it, { sha256: h.sha256, sha512: h.sha512 });
      const at = new Date();
      verified.set(it.evidence_id, { ...h, at });
      await db.transaction().execute(async (tx) => {
        await tx.updateTable('export_items').set({ verified_sha256: h.sha256, verified_sha512: h.sha512, verified_ok: true, verified_at: at, verify_error: null }).where('export_id', '=', ex.id).where('evidence_id', '=', it.evidence_id).execute();
        await tx.updateTable('evidence').set({ last_verified_at: at }).where('id', '=', it.evidence_id).execute();
        await tx.insertInto('integrity_checks').values({ evidence_id: it.evidence_id, trigger: 'EXPORT', expected_sha256: it.sha256!, actual_sha256: h.sha256, ok: true, error: null, requested_by: ex.approved_by }).execute();
        await appendAudit(tx, EXPORT_ACTOR, { action: 'EVIDENCE_INTEGRITY_VERIFIED', resourceType: 'evidence', resourceId: it.evidence_id, evidenceId: it.evidence_id, orgUnitId: it.org_unit_id, details: { trigger: 'EXPORT', exportId: ex.id, exportNumber: ex.export_number, sha256: h.sha256, sha512Checked: !!it.sha512, bytes: h.size } });
      });
      await setProgress((++done / items.length) * 0.3);
    }

    // ---- 2. artefacts ----------------------------------------------------------------------------
    const generatedAt = new Date();
    const probe = await signer.sign(Buffer.from('ksp-export-probe'));
    const signing = { algorithm: probe.algorithm, keyId: probe.keyId, certificateFingerprint256: probe.certificateFingerprint256 };
    const entries: Entry[] = [];
    const add = (path: string, role: ManifestFileRole, data: Buffer, evidenceId?: string, compress = true) =>
      entries.push({ path, role, sizeBytes: data.length, sha256: createHash('sha256').update(data).digest('hex'), evidenceId, source: { kind: 'buffer', data }, compress });
    const records = new Map<string, EvidenceRecord>();
    const itemFiles = new Map<string, string[]>();
    const usedNames = new Set<string>();
    const uniq = (p: string) => {
      let out = p;
      for (let i = 2; usedNames.has(out); i++) out = p.replace(/(\.[^./]+)?$/, `_${i}$1`);
      usedNames.add(out);
      return out;
    };
    const requestedBy = await loadPerson(db, ex.created_by);
    const approvedBy = await loadPerson(db, ex.approved_by);
    done = 0;
    for (const it of items) {
      const rec = (await loadEvidenceRecord(db, it.evidence_id))!;
      records.set(it.evidence_id, rec);
      const num = safePart(it.evidence_number ?? it.evidence_id);
      const files: string[] = [];
      const v = verified.get(it.evidence_id)!;
      if (includeOriginal) {
        const path = uniq(`originals/${num}_${safePart(it.original_filename)}`);
        entries.push({ path, role: 'original', sizeBytes: v.size, sha256: v.sha256, evidenceId: it.evidence_id, source: { kind: 'object', bucket: it.storage_bucket!, key: it.storage_key!, versionId: it.storage_version_id, expectSha256: v.sha256 }, compress: false });
        files.push(path);
      }
      if (includeWatermarked) {
        const proxy = await db.selectFrom('evidence_derivatives').selectAll().where('evidence_id', '=', it.evidence_id).where('kind', '=', 'PROXY_MP4').executeTakeFirst();
        if (!proxy) return await fail(`A watermarked copy was requested but ${it.evidence_number ?? it.evidence_id} has no playback proxy (media not processed)`);
        const out = join(work, `${num}_wm.mp4`);
        const pm = (proxy.meta ?? {}) as { durationMs?: number };
        await burnWatermark({
          input: await storage.internalUrl(proxy.bucket, proxy.object_key, 6 * 3600),
          output: out,
          width: proxy.width ?? rec.media.width ?? 1280,
          height: proxy.height ?? rec.media.height ?? 720,
          durationMs: pm.durationMs ?? rec.durationMs ?? 1000,
          recordedAt: it.recorded_at,
          label: ex.export_number,
          lines: [
            `COURT EXPORT ${ex.export_number} - ${it.evidence_number ?? it.evidence_id}`,
            `Recipient: ${ex.recipient ?? ex.court_name ?? 'not specified'}`,
            `Exported ${generatedAt.toISOString().slice(0, 10)}${opts.watermarkText ? ` - ${opts.watermarkText}` : ''}`,
          ],
        });
        const h = await hashStream(createReadStream(out));
        const path = uniq(`watermarked/${num}.mp4`);
        entries.push({ path, role: 'watermarked', sizeBytes: h.size, sha256: h.sha256, evidenceId: it.evidence_id, source: { kind: 'file', path: out }, compress: false });
        files.push(path);
      }
      const metaPath = uniq(`metadata/${num}.json`);
      add(metaPath, 'metadata', Buffer.from(`${JSON.stringify({ type: 'KSP-EVIDENCE-METADATA', version: 1, exportNumber: ex.export_number, verifiedAt: v.at.toISOString(), verifiedSha256: v.sha256, verifiedSha512: v.sha512, evidence: rec }, null, 2)}\n`), it.evidence_id);
      files.push(metaPath);
      if (includeCustody) {
        const report = await buildCustodyReport(db, it.evidence_id, { type: 'SYSTEM', id: 'export-worker', name: `export ${ex.export_number}` }, signer);
        const path = uniq(`custody/${num}_custody.pdf`);
        add(path, 'custody_report', report.pdf, it.evidence_id);
        files.push(path);
      }
      itemFiles.set(it.evidence_id, files);
      await setProgress(0.3 + (++done / items.length) * 0.4);
    }

    const head = await ledgerHead(db);
    if (includeFactSheet) {
      let caseInfo: FactSheetData['caseInfo'] = null;
      if (ex.case_id) {
        const c = await db.selectFrom('cases').selectAll().where('id', '=', ex.case_id).executeTakeFirst();
        if (c) {
          const fir = c.fir_id ? await db.selectFrom('firs as f').innerJoin('org_units as o', 'o.id', 'f.org_unit_id').select(['f.fir_number', 'f.fir_year', 'f.registered_at', 'f.acts_sections', 'f.place_of_occurrence', 'f.brief_facts', 'o.name as station']).where('f.id', '=', c.fir_id).executeTakeFirst() : undefined;
          caseInfo = {
            caseNumber: c.case_number, title: c.title, status: c.status, courtName: c.court_name, courtCaseNumber: c.court_case_number, investigatingOfficer: await loadPerson(db, c.investigating_officer_id),
            fir: fir ? { firNumber: fir.fir_number, firYear: fir.fir_year, registeredAt: fir.registered_at.toISOString(), actsSections: fir.acts_sections, placeOfOccurrence: fir.place_of_occurrence, briefFacts: fir.brief_facts, station: fir.station } : null,
          };
        }
      }
      const org = await db.selectFrom('org_units').select(['name', 'code']).where('id', '=', ex.org_unit_id).executeTakeFirstOrThrow();
      const pdf = await renderFactSheet({
        exportNumber: ex.export_number, exportId: ex.id, purpose: ex.purpose, courtName: ex.court_name, courtCaseNumber: ex.court_case_number, recipient: ex.recipient,
        requestedAt: ex.created_at.toISOString(), approvedAt: ex.approved_at?.toISOString() ?? null, requestedBy, approvedBy, approvalNote: ex.decision_note, orgUnit: org, caseInfo,
        items: items.map((it) => ({ record: records.get(it.evidence_id)!, verifiedSha256: verified.get(it.evidence_id)!.sha256, verifiedSha512: verified.get(it.evidence_id)!.sha512, verifiedAt: verified.get(it.evidence_id)!.at.toISOString(), files: itemFiles.get(it.evidence_id)! })),
        generatedAt: generatedAt.toISOString(), ledgerHead: head, signing, includesWatermarked: includeWatermarked,
      });
      add('FACT_SHEET.pdf', 'fact_sheet', pdf);
    }
    add('signing-cert.pem', 'certificate', Buffer.from(probe.certificatePem, 'utf8'));
    add('VERIFY.txt', 'instructions', Buffer.from(verifyInstructions({ exportNumber: ex.export_number, algorithm: signing.algorithm, keyId: signing.keyId, fingerprint: signing.certificateFingerprint256 }), 'utf8'));
    add('SHA256SUMS', 'checksums', Buffer.from(sha256sums(entries), 'utf8'));

    let caseNumber: string | null = null;
    if (ex.case_id) caseNumber = (await db.selectFrom('cases').select('case_number').where('id', '=', ex.case_id).executeTakeFirst())?.case_number ?? null;
    const manifest: ExportManifest = {
      type: MANIFEST_TYPE,
      version: 1,
      generatedAt: generatedAt.toISOString(),
      export: {
        id: ex.id, exportNumber: ex.export_number, purpose: ex.purpose, courtName: ex.court_name, courtCaseNumber: ex.court_case_number, recipient: ex.recipient, caseId: ex.case_id, caseNumber,
        requestedBy: { id: ex.created_by, name: requestedBy?.fullName ?? null }, approvedBy: ex.approved_by ? { id: ex.approved_by, name: approvedBy?.fullName ?? null } : null,
        requestedAt: ex.created_at.toISOString(), approvedAt: ex.approved_at?.toISOString() ?? null, options: opts as Record<string, unknown>,
      },
      ledgerHead: head,
      signing,
      items: items.map((it) => {
        const v = verified.get(it.evidence_id)!;
        return { evidenceId: it.evidence_id, evidenceNumber: it.evidence_number, originalFilename: it.original_filename, sizeBytes: v.size, sha256: v.sha256, sha512: v.sha512, verifiedAt: v.at.toISOString() };
      }),
      files: entries.map(({ path, role, sizeBytes, sha256, evidenceId }) => ({ path, role, sizeBytes, sha256, ...(evidenceId ? { evidenceId } : {}) })),
    };
    const mBytes = manifestBytes(manifest);
    const manifestSha256 = createHash('sha256').update(mBytes).digest('hex');
    const sig = await signer.sign(mBytes);
    await setProgress(0.75);

    // ---- 3. stream the ZIP into the exports bucket ------------------------------------------------
    const bucket = storage.bucket('exports');
    const objectKey = `exports/${generatedAt.getUTCFullYear()}/${safePart(ex.export_number)}/${ex.id}.zip`;
    const zip = new yazl.ZipFile();
    const pkgHash = createHash('sha256');
    let pkgSize = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        pkgHash.update(chunk);
        pkgSize += chunk.length;
        cb(null, chunk);
      },
    });
    let streamError: Error | null = null;
    const fatal = (e: Error) => {
      streamError ??= e;
      counter.destroy(e);
    };
    zip.on('error', fatal);
    const mtime = generatedAt;
    for (const e of entries) {
      const o = { mtime, compress: e.compress, size: e.sizeBytes };
      if (e.source.kind === 'buffer') zip.addBuffer(e.source.data, e.path, { mtime, compress: e.compress });
      else if (e.source.kind === 'file') {
        const p = e.source.path;
        zip.addReadStreamLazy(e.path, o, (cb) => cb(null, createReadStream(p)));
      } else {
        const src = e.source;
        zip.addReadStreamLazy(e.path, o, (cb) => {
          storage.getStream(src.bucket, src.key, undefined, src.versionId ?? undefined).then((s: Readable) => {
            const h = createHash('sha256');
            const check = new Transform({
              transform(chunk: Buffer, _enc, done2) {
                h.update(chunk);
                done2(null, chunk);
              },
              flush(done2) {
                const got = h.digest('hex');
                if (got !== src.expectSha256) {
                  const err = new Error(`original ${e.path} changed while packaging (sha256 ${got} != ${src.expectSha256})`);
                  fatal(err);
                  return done2(err);
                }
                done2();
              },
            });
            s.on('error', (err) => fatal(err as Error));
            cb(null, s.pipe(check));
          }, (err: Error) => {
            fatal(err);
            cb(err, new PassThrough());
          });
        });
      }
    }
    zip.addBuffer(mBytes, 'manifest.json', { mtime, compress: true });
    zip.addBuffer(Buffer.from(sig.signature, 'base64'), 'manifest.sig', { mtime, compress: false });
    zip.end();
    const upload = storage.put(bucket, objectKey, (zip.outputStream as Readable).pipe(counter), { contentType: 'application/zip', metadata: { 'export-id': ex.id, 'manifest-sha256': manifestSha256 } });
    try {
      await upload;
    } catch (err) {
      await storage.delete(bucket, objectKey).catch(() => undefined);
      if (streamError && /changed while packaging/.test((streamError as Error).message)) return await fail((streamError as Error).message);
      throw streamError ?? err;
    }
    if (streamError) {
      await storage.delete(bucket, objectKey).catch(() => undefined);
      return await fail((streamError as Error).message);
    }
    const packageSha256 = pkgHash.digest('hex');

    // ---- 4. READY --------------------------------------------------------------------------------
    const days = await exportRetentionDays(db);
    const expiresAt = new Date(Date.now() + days * 86_400_000);
    const ok = await db.transaction().execute(async (tx) => {
      const upd = await tx
        .updateTable('exports')
        .set({
          status: 'READY', bucket, object_key: objectKey, size_bytes: pkgSize, sha256: packageSha256, manifest_sha256: manifestSha256, manifest: JSON.stringify(manifest),
          signature: sig.signature, signature_alg: sig.algorithm, signing_key_id: sig.keyId, signing_cert_fingerprint: sig.certificateFingerprint256,
          ledger_head_seq: head?.seq ?? null, ledger_head_hash: head?.hash ?? null, progress: 1, completed_at: new Date(), expires_at: expiresAt, error: null,
        })
        .where('id', '=', ex.id)
        .where('status', '=', 'PROCESSING')
        .executeTakeFirst();
      if (!upd.numUpdatedRows) return false;
      await perItem(tx, 'EXPORT_GENERATED', ex, items, { packageSha256, manifestSha256, sizeBytes: pkgSize, files: entries.length + 2, signatureAlgorithm: sig.algorithm, keyId: sig.keyId, expiresAt: expiresAt.toISOString() });
      return true;
    });
    if (!ok) {
      // Revoked while building: never leave the package behind.
      await storage.delete(bucket, objectKey).catch(() => undefined);
      return { status: 'SKIPPED', reason: 'export was revoked during the build' };
    }
    deps.log?.info({ exportId: ex.id, packageSha256, pkgSize }, 'export package ready');
    return { status: 'READY', sha256: packageSha256, objectKey };
  } catch (err) {
    return await fail(`Package build failed: ${(err as Error).message}`.slice(0, 2000));
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}
