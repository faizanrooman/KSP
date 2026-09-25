/**
 * Verification of a court export package (whole ZIP) or of a manifest.json + manifest.sig pair against
 * OUR signing certificate (the trust anchor — a certificate shipped inside a package is only compared,
 * never trusted) and our records (export row, registered evidence hashes, ledger head).
 */
import { createHash } from 'node:crypto';
import yauzl from 'yauzl';
import { evidenceSigner, type Database } from '@ksp/core';
import { MANIFEST_TYPE, type ExportManifest } from '@ksp/core/custody';

export interface PackageFileCheck {
  path: string;
  expectedSha256: string | null;
  actualSha256: string | null;
  sizeBytes: number | null;
  ok: boolean;
  problem?: 'MISSING' | 'HASH_MISMATCH' | 'NOT_IN_MANIFEST';
}

export interface VerificationReport {
  ok: boolean;
  signatureValid: boolean;
  manifestSha256: string | null;
  manifestParsed: boolean;
  packageCertificateMatches: boolean | null;
  signing: { algorithm: string | null; keyId: string | null; certificateFingerprint256: string | null };
  export: null | { exportNumber: string; known: boolean; status: string | null; manifestMatchesRecord: boolean };
  items: Array<{ evidenceNumber: string | null; sha256: string; knownInRecords: boolean }>;
  ledgerHead: null | { seq: number; hash: string; existsInLedger: boolean };
  files: PackageFileCheck[] | null;
  problems: string[];
}

interface ZipContents {
  files: Map<string, { sha256: string; size: number }>;
  manifest?: Buffer;
  signature?: Buffer;
  certificate?: Buffer;
}

const KEEP = new Set(['manifest.json', 'manifest.sig', 'signing-cert.pem']);

/**
 * Resource limits for online verification (SEC-14: zip bombs). Court packages hold already-compressed video, so the
 * inflated size is close to the ZIP size; the limits leave ample headroom while bounding CPU/memory per request.
 * Declared sizes are trustworthy for enforcement because yauzl `validateEntrySizes` fails a stream that inflates to
 * anything other than the declared uncompressedSize.
 */
export const ZIP_LIMITS = { maxEntries: 10_000, maxTotalUncompressed: 256 * 1024 * 1024, maxRatio: 100, ratioFloorBytes: 1024 * 1024 };
/** Manifests (JSON mode or inside a package) larger than this are not looked up item by item. */
export const MAX_MANIFEST_ITEMS = 1_000;
export const MAX_MANIFEST_FILES = 10_000;

export function readZip(buf: Buffer): Promise<ZipContents> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true, validateEntrySizes: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('not a zip file'));
      if (zip.entryCount > ZIP_LIMITS.maxEntries) return reject(new Error(`too many entries (${zip.entryCount} > ${ZIP_LIMITS.maxEntries})`));
      const out: ZipContents = { files: new Map() };
      let total = 0;
      zip.on('error', reject);
      zip.on('end', () => resolve(out));
      zip.on('entry', (entry: yauzl.Entry) => {
        if (/\/$/.test(entry.fileName)) return zip.readEntry();
        if (entry.fileName.includes('..') || entry.fileName.startsWith('/') || entry.fileName.includes('\\')) return reject(new Error(`unsafe path in zip: ${entry.fileName.slice(0, 200)}`));
        total += entry.uncompressedSize;
        if (total > ZIP_LIMITS.maxTotalUncompressed) return reject(new Error(`inflated size exceeds the online verification limit (${ZIP_LIMITS.maxTotalUncompressed} bytes)`));
        if (entry.uncompressedSize > ZIP_LIMITS.ratioFloorBytes && entry.uncompressedSize > ZIP_LIMITS.maxRatio * Math.max(1, entry.compressedSize)) {
          return reject(new Error(`entry ${entry.fileName.slice(0, 200)} has a suspicious compression ratio`));
        }
        zip.openReadStream(entry, (e2, stream) => {
          if (e2 || !stream) return reject(e2 ?? new Error('cannot read entry'));
          const h = createHash('sha256');
          const keep = KEEP.has(entry.fileName);
          const chunks: Buffer[] = [];
          let size = 0;
          stream.on('data', (c: Buffer) => {
            h.update(c);
            size += c.length;
            if (keep && size <= 4 * 1024 * 1024) chunks.push(c);
          });
          stream.on('error', reject);
          stream.on('end', () => {
            out.files.set(entry.fileName, { sha256: h.digest('hex'), size });
            if (entry.fileName === 'manifest.json') out.manifest = Buffer.concat(chunks);
            if (entry.fileName === 'manifest.sig') out.signature = Buffer.concat(chunks);
            if (entry.fileName === 'signing-cert.pem') out.certificate = Buffer.concat(chunks);
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

export async function verifyExport(db: Database, input: { manifest: Buffer; signature: Buffer; certificate?: Buffer; zip?: ZipContents }): Promise<VerificationReport> {
  const problems: string[] = [];
  const signer = evidenceSigner();
  const ours = await signer.sign(Buffer.from('fingerprint'));
  let signatureValid = false;
  try {
    signatureValid = signer.verify(input.manifest, input.signature.toString('base64'));
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) problems.push('Signature over manifest.json is NOT valid for the KSP signing certificate');
  let packageCertificateMatches: boolean | null = null;
  if (input.certificate) {
    packageCertificateMatches = input.certificate.toString('utf8').replace(/\s+/g, '') === ours.certificatePem.replace(/\s+/g, '');
    if (!packageCertificateMatches) problems.push('signing-cert.pem in the package is not the KSP signing certificate');
  }
  const manifestSha256 = createHash('sha256').update(input.manifest).digest('hex');
  let m: ExportManifest | null = null;
  try {
    const parsed = JSON.parse(input.manifest.toString('utf8')) as ExportManifest;
    if (parsed?.type === MANIFEST_TYPE && Array.isArray(parsed.files) && Array.isArray(parsed.items)) m = parsed;
  } catch {
    m = null;
  }
  // SEC-14: every item costs a database lookup; real exports hold at most 100 items (export create schema).
  if (m && (m.items.length > MAX_MANIFEST_ITEMS || m.files.length > MAX_MANIFEST_FILES)) {
    problems.push(`manifest lists more items/files than any KSP export can contain (${m.items.length} items, ${m.files.length} files)`);
    m = null;
  }
  if (!m) {
    if (!problems.some((p) => p.startsWith('manifest lists'))) problems.push('manifest.json is not a KSP court export manifest');
    return { ok: false, signatureValid, manifestSha256, manifestParsed: false, packageCertificateMatches, signing: { algorithm: null, keyId: null, certificateFingerprint256: null }, export: null, items: [], ledgerHead: null, files: null, problems };
  }
  const ex = m.export?.id && /^[0-9a-f-]{36}$/i.test(m.export.id)
    ? await db.selectFrom('exports').select(['export_number', 'status', 'manifest_sha256']).where('id', '=', m.export.id).executeTakeFirst()
    : undefined;
  const exportInfo = { exportNumber: m.export?.exportNumber ?? '?', known: !!ex, status: ex?.status ?? null, manifestMatchesRecord: !!ex && ex.manifest_sha256 === manifestSha256 };
  if (!ex) problems.push('Export is not known to this system');
  else if (!exportInfo.manifestMatchesRecord) problems.push('manifest.json differs from the manifest recorded for this export');
  const items = [];
  for (const it of m.items) {
    const hit = typeof it.sha256 === 'string' && /^[0-9a-f]{64}$/.test(it.sha256)
      ? await db.selectFrom('evidence').select('id').where('sha256', '=', it.sha256).where('evidence_number', '=', it.evidenceNumber ?? '').executeTakeFirst()
      : undefined;
    items.push({ evidenceNumber: it.evidenceNumber ?? null, sha256: String(it.sha256), knownInRecords: !!hit });
    if (!hit) problems.push(`Item ${it.evidenceNumber ?? '?'}: hash not found in the evidence register`);
  }
  let ledgerHead: VerificationReport['ledgerHead'] = null;
  if (m.ledgerHead && Number.isSafeInteger(m.ledgerHead.seq)) {
    const row = await db.selectFrom('audit_events').select('hash').where('seq', '=', m.ledgerHead.seq).executeTakeFirst();
    ledgerHead = { seq: m.ledgerHead.seq, hash: m.ledgerHead.hash, existsInLedger: !!row && row.hash === m.ledgerHead.hash };
    if (!ledgerHead.existsInLedger) problems.push('Ledger head sealed in the manifest does not exist in the audit ledger');
  }
  let files: PackageFileCheck[] | null = null;
  if (input.zip) {
    files = [];
    const listed = new Set<string>();
    for (const f of m.files) {
      listed.add(f.path);
      const got = input.zip.files.get(f.path);
      if (!got) files.push({ path: f.path, expectedSha256: f.sha256, actualSha256: null, sizeBytes: null, ok: false, problem: 'MISSING' });
      else files.push({ path: f.path, expectedSha256: f.sha256, actualSha256: got.sha256, sizeBytes: got.size, ok: got.sha256 === f.sha256 && got.size === f.sizeBytes, ...(got.sha256 === f.sha256 && got.size === f.sizeBytes ? {} : { problem: 'HASH_MISMATCH' as const }) });
    }
    for (const [path, got] of input.zip.files) {
      if (!listed.has(path) && path !== 'manifest.json' && path !== 'manifest.sig') files.push({ path, expectedSha256: null, actualSha256: got.sha256, sizeBytes: got.size, ok: false, problem: 'NOT_IN_MANIFEST' });
    }
    for (const f of files) if (!f.ok) problems.push(`${f.path}: ${f.problem}`);
  }
  return {
    ok: problems.length === 0,
    signatureValid,
    manifestSha256,
    manifestParsed: true,
    packageCertificateMatches,
    signing: { algorithm: m.signing?.algorithm ?? null, keyId: m.signing?.keyId ?? null, certificateFingerprint256: m.signing?.certificateFingerprint256 ?? null },
    export: exportInfo,
    items,
    ledgerHead,
    files,
    problems,
  };
}
