/**
 * Evidence ingestion contracts (upload API, finalize worker, station client, web uploader).
 * See docs/INGESTION.md.
 */

/** Header carrying the lowercase hex SHA-256 of a chunk body (PUT /uploads/:id/parts/:n). */
export const CHUNK_SHA256_HEADER = 'x-chunk-sha256';

/** S3 multipart limits that bound the chunk size the server hands out. */
export const MIN_CHUNK_SIZE = 5 * 1024 * 1024;
export const MAX_CHUNK_SIZE = 64 * 1024 * 1024;
export const MAX_CHUNKS = 10_000;

/**
 * Machine-readable reasons stored as the prefix of evidence.status_reason when an item is QUARANTINED
 * (format: `<CODE>: <human readable message>`).
 */
export const QUARANTINE_REASONS = {
  HASH_MISMATCH: 'Server-computed SHA-256 differs from the hash declared by the uploading client',
  NOT_VIDEO: 'File is not a readable video (no video stream / unrecognised container)',
  UNSUPPORTED_FORMAT: 'Container format is not supported',
  UNSUPPORTED_CODEC: 'Video codec is not supported',
  CORRUPT: 'Media failed the decode integrity check',
  DUPLICATE: 'An identical file (same SHA-256) is already held as evidence',
  PROCESSING_FAILED: 'Ingestion failed repeatedly; manual review required',
} as const;
export type QuarantineReason = keyof typeof QUARANTINE_REASONS;

export function formatStatusReason(code: QuarantineReason, message?: string): string {
  return `${code}: ${(message ?? QUARANTINE_REASONS[code]).slice(0, 900)}`;
}

export function parseStatusReason(v: string | null | undefined): { code: string | null; message: string | null } {
  if (!v) return { code: null, message: null };
  const m = /^([A-Z_]+):\s?(.*)$/s.exec(v);
  return m ? { code: m[1]!, message: m[2]! } : { code: null, message: v };
}

/** Metadata the uploader may declare for a file (web form, station client sidecar `<file>.json`). */
export interface DeclaredUploadMetadata {
  title?: string;
  description?: string;
  category?: string;
  officerBadge?: string;
  officerId?: string;
  deviceSerial?: string;
  recordedAt?: string; // ISO-8601
  incidentAt?: string; // ISO-8601
  locationText?: string;
  latitude?: number;
  longitude?: number;
  notes?: string;
}

export interface UploadInitRequest {
  batchId?: string;
  orgUnitId: string;
  filename: string;
  size: number;
  mimeType?: string;
  sha256?: string;
  /** Preferred chunk size (bytes); clamped by the server. */
  chunkSize?: number;
  metadata?: DeclaredUploadMetadata;
}

export interface UploadInitResponse {
  id: string;
  chunkSize: number;
  totalChunks: number;
  expiresAt: string;
  status: string;
}

export interface UploadSessionView {
  id: string;
  batchId: string | null;
  orgUnitId: string;
  orgUnitName?: string;
  filename: string;
  size: number;
  mimeType: string | null;
  declaredSha256: string | null;
  chunkSize: number;
  totalChunks: number;
  receivedBytes: number;
  receivedParts?: number[];
  status: string;
  error: string | null;
  createdBy: string;
  createdByName?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  evidence: null | {
    id: string;
    evidenceNumber: string | null;
    status: string;
    statusReason: string | null;
    reasonCode: string | null;
    sha256: string | null;
  };
}

export function totalChunksFor(size: number, chunkSize: number): number {
  return Math.max(1, Math.ceil(size / chunkSize));
}

/** Expected byte length of part `n` (1-based). */
export function expectedPartSize(size: number, chunkSize: number, n: number): number {
  const total = totalChunksFor(size, chunkSize);
  if (n < 1 || n > total) return -1;
  return n < total ? chunkSize : size - chunkSize * (total - 1);
}
