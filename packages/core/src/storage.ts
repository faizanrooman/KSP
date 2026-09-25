/**
 * Object storage abstraction over the S3 API (AWS S3, MinIO, Ceph RGW, versitygw, etc.).
 *
 * Buckets (see docs/ARCHITECTURE.md#storage):
 *   staging   — in-flight uploads & quarantine. Not immutable. Lifecycle-expired.
 *   evidence  — ORIGINAL evidence, active tier. Versioned + Object Lock (WORM). Never overwritten.
 *   archive   — ORIGINAL evidence, archival tier (cheaper storage class in production).
 *   longterm  — ORIGINAL evidence, long-term tier (e.g. Glacier/tape-backed class).
 *   derived   — proxies, HLS, thumbnails, AI crops, snapshots. Reproducible; AI worker may read this only.
 *   exports   — court export packages.
 *   reports   — generated reports.
 *
 * No bucket is public. Clients never receive storage URLs; all media is streamed through the API.
 */
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type GetObjectCommandOutput,
  type HeadObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { loadConfig, type AppConfig } from './config.js';
import type { StorageTier } from '@ksp/shared';

export type BucketRole = 'staging' | 'evidence' | 'archive' | 'longterm' | 'derived' | 'exports' | 'reports';

export class Storage {
  readonly s3: S3Client;
  readonly cfg: AppConfig;

  constructor(opts: { accessKey?: string; secretKey?: string; cfg?: AppConfig } = {}) {
    this.cfg = opts.cfg ?? loadConfig();
    this.s3 = new S3Client({
      region: this.cfg.S3_REGION,
      endpoint: this.cfg.S3_ENDPOINT,
      forcePathStyle: this.cfg.S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId: opts.accessKey ?? this.cfg.S3_ACCESS_KEY, secretAccessKey: opts.secretKey ?? this.cfg.S3_SECRET_KEY },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  bucket(role: BucketRole): string {
    const c = this.cfg;
    return {
      staging: c.S3_BUCKET_STAGING,
      evidence: c.S3_BUCKET_EVIDENCE,
      archive: c.S3_BUCKET_ARCHIVE,
      longterm: c.S3_BUCKET_LONG_TERM,
      derived: c.S3_BUCKET_DERIVED,
      exports: c.S3_BUCKET_EXPORTS,
      reports: c.S3_BUCKET_REPORTS,
    }[role];
  }

  bucketForTier(tier: Exclude<StorageTier, 'STAGING'>): string {
    return this.bucket(tier === 'ACTIVE' ? 'evidence' : tier === 'ARCHIVE' ? 'archive' : 'longterm');
  }

  /** Create buckets if missing. Originals' buckets get versioning + object lock. Idempotent. */
  async ensureBuckets(): Promise<void> {
    const worm: BucketRole[] = ['evidence', 'archive', 'longterm'];
    const all: BucketRole[] = ['staging', 'evidence', 'archive', 'longterm', 'derived', 'exports', 'reports'];
    for (const role of all) {
      const Bucket = this.bucket(role);
      const exists = await this.s3.send(new HeadBucketCommand({ Bucket })).then(() => true, () => false);
      if (!exists) {
        const lock = worm.includes(role) && this.cfg.OBJECT_LOCK_MODE !== 'NONE';
        await this.s3.send(new CreateBucketCommand({ Bucket, ObjectLockEnabledForBucket: lock || undefined }));
        if (worm.includes(role)) {
          await this.s3.send(new PutBucketVersioningCommand({ Bucket, VersioningConfiguration: { Status: 'Enabled' } }));
        }
      }
    }
  }

  /** Object lock parameters applied when writing originals. */
  lockParams(): { ObjectLockMode?: 'GOVERNANCE' | 'COMPLIANCE'; ObjectLockRetainUntilDate?: Date } {
    if (this.cfg.OBJECT_LOCK_MODE === 'NONE') return {};
    return {
      ObjectLockMode: this.cfg.OBJECT_LOCK_MODE,
      ObjectLockRetainUntilDate: new Date(Date.now() + this.cfg.OBJECT_LOCK_DAYS * 86_400_000),
    };
  }

  async head(bucket: string, key: string): Promise<HeadObjectCommandOutput | null> {
    try {
      return await this.s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    } catch (err) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }

  async get(bucket: string, key: string, range?: string, versionId?: string): Promise<GetObjectCommandOutput> {
    return this.s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: range, VersionId: versionId }));
  }

  async getStream(bucket: string, key: string, range?: string, versionId?: string): Promise<Readable> {
    const out = await this.get(bucket, key, range, versionId);
    return out.Body as Readable;
  }

  async getBuffer(bucket: string, key: string): Promise<Buffer> {
    const out = await this.get(bucket, key);
    return Buffer.from(await out.Body!.transformToByteArray());
  }

  /**
   * Write an object. `ifNoneMatch: true` makes the write conditional (fails if the key exists) —
   * used for originals so an existing object can never be overwritten, even by a bug.
   */
  async put(
    bucket: string,
    key: string,
    body: Buffer | string | Readable,
    opts: { contentType?: string; metadata?: Record<string, string>; lock?: boolean; ifNoneMatch?: boolean; contentLength?: number } = {},
  ): Promise<{ versionId?: string; etag?: string }> {
    const extra = opts.lock ? this.lockParams() : {};
    if (body instanceof Readable) {
      const up = new Upload({
        client: this.s3,
        params: { Bucket: bucket, Key: key, Body: body, ContentType: opts.contentType, Metadata: opts.metadata, ...extra },
        queueSize: 4,
        partSize: 16 * 1024 * 1024,
      });
      const res = await up.done();
      return { versionId: (res as { VersionId?: string }).VersionId, etag: (res as { ETag?: string }).ETag };
    }
    const res = await this.s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: opts.contentType,
        Metadata: opts.metadata,
        ContentLength: opts.contentLength,
        IfNoneMatch: opts.ifNoneMatch ? '*' : undefined,
        ...extra,
      }),
    );
    return { versionId: res.VersionId, etag: res.ETag };
  }

  async copy(
    src: { bucket: string; key: string; versionId?: string },
    dst: { bucket: string; key: string },
    opts: { lock?: boolean } = {},
  ): Promise<{ versionId?: string }> {
    const source = `${src.bucket}/${encodeURIComponent(src.key).replace(/%2F/g, '/')}${src.versionId ? `?versionId=${src.versionId}` : ''}`;
    const res = await this.s3.send(
      new CopyObjectCommand({ Bucket: dst.bucket, Key: dst.key, CopySource: source, ...(opts.lock ? this.lockParams() : {}) }),
    );
    return { versionId: res.VersionId };
  }

  /** Delete one object (version). For WORM buckets this only succeeds with governance bypass or after retention. */
  async delete(bucket: string, key: string, opts: { versionId?: string; bypassGovernance?: boolean } = {}): Promise<void> {
    await this.s3.send(
      new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: opts.versionId, BypassGovernanceRetention: opts.bypassGovernance || undefined }),
    );
  }

  /** Delete every object under a prefix (derived artefacts only — never call on originals' buckets). */
  async deletePrefix(bucket: string, prefix: string): Promise<number> {
    if (!prefix || prefix === '/') throw new Error('refusing to delete empty prefix');
    let token: string | undefined;
    let n = 0;
    do {
      const page = await this.s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
      const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key! }));
      if (keys.length) {
        await this.s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }));
        n += keys.length;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return n;
  }

  async list(bucket: string, prefix: string): Promise<Array<{ key: string; size: number }>> {
    const out: Array<{ key: string; size: number }> = [];
    let token: string | undefined;
    do {
      const page = await this.s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
      for (const o of page.Contents ?? []) out.push({ key: o.Key!, size: o.Size ?? 0 });
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  /** Aggregate usage of a bucket (for storage dashboards). */
  async usage(bucket: string): Promise<{ objects: number; bytes: number }> {
    let token: string | undefined;
    let objects = 0;
    let bytes = 0;
    do {
      const page = await this.s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
      for (const o of page.Contents ?? []) {
        objects++;
        bytes += o.Size ?? 0;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return { objects, bytes };
  }

  // ---- multipart (resumable chunked uploads) ---------------------------------------------------
  async createMultipart(bucket: string, key: string, contentType?: string): Promise<string> {
    const res = await this.s3.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType }));
    return res.UploadId!;
  }

  async uploadPart(bucket: string, key: string, uploadId: string, partNumber: number, body: Buffer): Promise<string> {
    const res = await this.s3.send(
      new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: partNumber, Body: body, ContentLength: body.length }),
    );
    return res.ETag!;
  }

  async completeMultipart(bucket: string, key: string, uploadId: string, parts: Array<{ partNumber: number; etag: string }>): Promise<void> {
    await this.s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts.sort((a, b) => a.partNumber - b.partNumber).map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
      }),
    );
  }

  async abortMultipart(bucket: string, key: string, uploadId: string): Promise<void> {
    await this.s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId })).catch(() => undefined);
  }

  /**
   * INTERNAL-ONLY presigned GET (e.g. for ffprobe/ffmpeg range reads inside the cluster).
   * Never return these URLs to clients.
   */
  async internalUrl(bucket: string, key: string, ttlSeconds = 900, versionId?: string): Promise<string> {
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }), { expiresIn: ttlSeconds });
  }

  /** Stream an object and compute SHA-256 and SHA-512 in one pass. */
  async hashObject(bucket: string, key: string, versionId?: string): Promise<{ sha256: string; sha512: string; size: number }> {
    const stream = await this.getStream(bucket, key, undefined, versionId);
    return hashStream(stream);
  }
}

export async function hashStream(stream: Readable): Promise<{ sha256: string; sha512: string; size: number }> {
  const h256 = createHash('sha256');
  const h512 = createHash('sha512');
  let size = 0;
  for await (const chunk of stream) {
    const b = chunk as Buffer;
    h256.update(b);
    h512.update(b);
    size += b.length;
  }
  return { sha256: h256.digest('hex'), sha512: h512.digest('hex'), size };
}

let shared: Storage | undefined;
export function storage(): Storage {
  return (shared ??= new Storage());
}
