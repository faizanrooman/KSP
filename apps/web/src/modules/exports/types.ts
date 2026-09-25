/** Response shapes of /api/v1/exports. */
export interface ExportOptions {
  includeOriginal: boolean;
  includeWatermarked: boolean;
  includeCustodyReport: boolean;
  includeFactSheet: boolean;
  watermarkText?: string;
}

export interface ExportSummary {
  id: string;
  exportNumber: string;
  status: string;
  purpose: string;
  courtName: string | null;
  courtCaseNumber: string | null;
  recipient: string | null;
  options: ExportOptions;
  orgUnit: { id: string; name: string; code: string };
  case: { id: string; caseNumber: string | null; title: string | null } | null;
  createdBy: { id: string; name: string; username: string };
  createdAt: string;
  approvedBy: { id: string; name: string | null } | null;
  approvedAt: string | null;
  decisionNote: string | null;
  progress: number;
  error: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  manifestSha256: string | null;
  signatureAlgorithm: string | null;
  signingKeyId: string | null;
  certificateFingerprint: string | null;
  ledgerHead: { seq: number; hash: string } | null;
  downloadCount: number;
  completedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedBy: { id: string; name: string | null } | null;
  revokeReason: string | null;
  itemCount: number;
  permissions: { canApprove: boolean; canDownload: boolean; canRevoke: boolean };
}

export interface ExportItem {
  evidenceId: string;
  evidenceNumber: string | null;
  title: string | null;
  durationMs: number | null;
  recordedAt: string | null;
  expectedSha256: string;
  verifiedSha256: string | null;
  verifiedSha512: string | null;
  verifiedOk: boolean | null;
  verifiedAt: string | null;
  verifyError: string | null;
}

export interface ExportDetail extends ExportSummary {
  items: ExportItem[];
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
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
  files: Array<{ path: string; expectedSha256: string | null; actualSha256: string | null; sizeBytes: number | null; ok: boolean; problem?: string }> | null;
  problems: string[];
}
