/** Court export manifest: layout, VERIFY.txt instructions and verification of an uploaded manifest/package. */
import { createHash } from 'node:crypto';
import { opensslVerifyCommands } from './custody-report.js';

export const MANIFEST_TYPE = 'KSP-COURT-EXPORT-MANIFEST';

export type ManifestFileRole = 'original' | 'watermarked' | 'metadata' | 'custody_report' | 'fact_sheet' | 'checksums' | 'certificate' | 'instructions';

export interface ManifestFile {
  path: string;
  role: ManifestFileRole;
  sizeBytes: number;
  sha256: string;
  evidenceId?: string;
}

export interface ManifestItem {
  evidenceId: string;
  evidenceNumber: string | null;
  originalFilename: string;
  sizeBytes: number;
  sha256: string;
  sha512: string;
  verifiedAt: string;
}

export interface ExportManifest {
  type: typeof MANIFEST_TYPE;
  version: 1;
  generatedAt: string;
  export: {
    id: string;
    exportNumber: string;
    purpose: string;
    courtName: string | null;
    courtCaseNumber: string | null;
    recipient: string | null;
    caseId: string | null;
    caseNumber: string | null;
    requestedBy: { id: string; name: string | null };
    approvedBy: { id: string; name: string | null } | null;
    requestedAt: string;
    approvedAt: string | null;
    options: Record<string, unknown>;
  };
  ledgerHead: { seq: number; hash: string } | null;
  signing: { algorithm: string; keyId: string; certificateFingerprint256: string };
  items: ManifestItem[];
  files: ManifestFile[];
}

/** manifest.json bytes: sorted keys, 2-space indentation (the signature covers these exact bytes). */
export function manifestBytes(m: ExportManifest): Buffer {
  return Buffer.from(`${JSON.stringify(sortDeep(m), null, 2)}\n`, 'utf8');
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const val = (v as Record<string, unknown>)[k];
      if (val !== undefined) out[k] = sortDeep(val);
    }
    return out;
  }
  return v;
}

/** SHA256SUMS in `sha256sum -c` format (two spaces, binary-safe paths). */
export function sha256sums(files: Array<{ path: string; sha256: string }>): string {
  return files.map((f) => `${f.sha256}  ${f.path}`).join('\n') + '\n';
}

export function verifyInstructions(o: { exportNumber: string; algorithm: string; keyId: string; fingerprint: string }): string {
  const sig = opensslVerifyCommands(o.algorithm, 'manifest.sig', 'manifest.json');
  return [
    `KSP VIDEO EVIDENCE - COURT EXPORT ${o.exportNumber}`,
    '===============================================================',
    '',
    'This package can be verified offline with OpenSSL and GNU coreutils. Unzip it and run the',
    'commands below from the directory that contains manifest.json.',
    '',
    '1) Check the digital signature over manifest.json (expected output: "Verified OK"):',
    '',
    ...sig.map((c) => `   ${c}`),
    '',
    `   Signature algorithm: ${o.algorithm}; key id: ${o.keyId}`,
    '   Confirm the signing certificate fingerprint matches the one published by KSP:',
    '',
    '   openssl x509 -in signing-cert.pem -noout -fingerprint -sha256',
    '',
    `   Expected: ${o.fingerprint}`,
    '',
    '2) Check that SHA256SUMS is the one sealed in the signed manifest. The hash printed by',
    '',
    '   sha256sum SHA256SUMS',
    '',
    '   must equal the "sha256" of the entry with "path": "SHA256SUMS" in manifest.json.',
    '',
    '3) Check every file in the package (expected output: "<file>: OK" for every line):',
    '',
    '   sha256sum -c SHA256SUMS',
    '',
    '4) Optionally confirm the originals against the registered hashes printed in FACT_SHEET.pdf',
    '   and in the chain-of-custody reports under custody/.',
    '',
    'Files under originals/ are byte-identical copies of the registered evidence. Files under',
    'watermarked/ are viewing copies and are NOT original evidence.',
    '',
  ].join('\n');
}

export interface ManifestCheck {
  parsed: ExportManifest | null;
  manifestSha256: string;
  signatureValid: boolean;
  error?: string;
}

export function sha256(b: Buffer | string): string {
  return createHash('sha256').update(b).digest('hex');
}
