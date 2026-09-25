/**
 * Write-once copy of a staged upload into an originals bucket.
 *
 * Implemented as a server-side multipart copy (UploadPartCopy) because:
 *   - CopyObject is limited to 5 GiB (evidence files can be 50 GiB+);
 *   - several S3 implementations (incl. versitygw used in development) ignore Object Lock headers and
 *     If-None-Match on CopyObject, but honour them on CreateMultipartUpload / CompleteMultipartUpload.
 * The completion is conditional (If-None-Match: *) so an existing original can never be overwritten.
 */
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  UploadPartCopyCommand,
} from '@aws-sdk/client-s3';
import type { Storage } from '../storage.js';

export const COPY_PART_SIZE = 512 * 1024 * 1024;

export interface WormCopyResult {
  versionId: string | null;
  /** true when the destination already existed (idempotent retry) and was reused. */
  reused: boolean;
  lockUntil: Date | null;
}

export function objectLockUntil(storage: Storage, from = new Date()): Date | null {
  if (storage.cfg.OBJECT_LOCK_MODE === 'NONE') return null;
  return new Date(from.getTime() + storage.cfg.OBJECT_LOCK_DAYS * 86_400_000);
}

function isPreconditionFailed(err: unknown): boolean {
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'PreconditionFailed' || e?.Code === 'PreconditionFailed' || e?.$metadata?.httpStatusCode === 412;
}

function copySource(bucket: string, key: string, versionId?: string | null): string {
  return `${bucket}/${encodeURIComponent(key).replace(/%2F/g, '/')}${versionId ? `?versionId=${encodeURIComponent(versionId)}` : ''}`;
}

export async function wormCopy(
  storage: Storage,
  src: { bucket: string; key: string; size: number; versionId?: string | null },
  dst: { bucket: string; key: string; contentType?: string; metadata?: Record<string, string> },
  opts: { partSize?: number; lockUntil?: Date | null } = {},
): Promise<WormCopyResult> {
  const existing = await storage.head(dst.bucket, dst.key);
  if (existing) {
    return { versionId: existing.VersionId ?? null, reused: true, lockUntil: existing.ObjectLockRetainUntilDate ?? null };
  }
  const lockUntil = opts.lockUntil === undefined ? objectLockUntil(storage) : opts.lockUntil;
  const lock = lockUntil && storage.cfg.OBJECT_LOCK_MODE !== 'NONE' ? { ObjectLockMode: storage.cfg.OBJECT_LOCK_MODE as 'GOVERNANCE' | 'COMPLIANCE', ObjectLockRetainUntilDate: lockUntil } : {};
  const partSize = Math.max(5 * 1024 * 1024, opts.partSize ?? COPY_PART_SIZE);
  const mp = await storage.s3.send(
    new CreateMultipartUploadCommand({ Bucket: dst.bucket, Key: dst.key, ContentType: dst.contentType, Metadata: dst.metadata, ...lock }),
  );
  const uploadId = mp.UploadId!;
  try {
    const parts: Array<{ PartNumber: number; ETag: string }> = [];
    const n = Math.max(1, Math.ceil(src.size / partSize));
    for (let i = 0; i < n; i++) {
      const start = i * partSize;
      const end = Math.min(src.size, start + partSize) - 1;
      const res = await storage.s3.send(
        new UploadPartCopyCommand({
          Bucket: dst.bucket,
          Key: dst.key,
          UploadId: uploadId,
          PartNumber: i + 1,
          CopySource: copySource(src.bucket, src.key, src.versionId),
          CopySourceRange: n === 1 ? undefined : `bytes=${start}-${end}`,
        }),
      );
      parts.push({ PartNumber: i + 1, ETag: res.CopyPartResult!.ETag! });
    }
    const done = await storage.s3.send(
      new CompleteMultipartUploadCommand({ Bucket: dst.bucket, Key: dst.key, UploadId: uploadId, IfNoneMatch: '*', MultipartUpload: { Parts: parts } }),
    );
    return { versionId: done.VersionId ?? null, reused: false, lockUntil: lockUntil ?? null };
  } catch (err) {
    await storage.s3.send(new AbortMultipartUploadCommand({ Bucket: dst.bucket, Key: dst.key, UploadId: uploadId })).catch(() => undefined);
    if (isPreconditionFailed(err)) {
      // A concurrent attempt wrote the same content-addressed key first: reuse it (hash is re-verified by the caller).
      const now = await storage.head(dst.bucket, dst.key);
      if (now) return { versionId: now.VersionId ?? null, reused: true, lockUntil: now.ObjectLockRetainUntilDate ?? null };
    }
    throw err;
  }
}
