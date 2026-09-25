#!/usr/bin/env node
/**
 * Minimal S3 CLI for the backup scripts (runs with plain `node` — Node 22 strips the type annotations; uses the
 * repository's @aws-sdk). Credentials/endpoint come from <PREFIX>_S3_ENDPOINT/_REGION/_ACCESS_KEY/_SECRET_KEY
 * (default prefix BACKUP; `--env DR` selects DR_S3_*). Never prints secrets.
 *
 *   s3.ts ensure-bucket <bucket> [--lock]              create (versioning + Object Lock when --lock) if missing
 *   s3.ts put <bucket> <key> <file> [--lock-days N]    multipart upload; GOVERNANCE retention when --lock-days > 0
 *   s3.ts get <bucket> <key> <file>
 *   s3.ts head <bucket> <key>                          prints JSON {size, etag, lockMode, retainUntil, versionId}
 *   s3.ts list <bucket> <prefix>                       prints JSON lines {key, size, lastModified}
 *   s3.ts prune <bucket> <prefix> <days>               delete object versions older than <days>; versions still
 *                                                      under Object Lock are refused by the store and kept (reported)
 *   s3.ts rm-prefix <bucket> <prefix> [--bypass]       delete every version under prefix (drills/tests only)
 */
import { createReadStream, createWriteStream, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import {
  CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand,
  ListObjectsV2Command, ListObjectVersionsCommand, PutBucketVersioningCommand, S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

export function clientFor(prefix: string): S3Client {
  const e = (k: string) => process.env[`${prefix}_S3_${k}`];
  const endpoint = e('ENDPOINT');
  const accessKeyId = e('ACCESS_KEY');
  const secretAccessKey = e('SECRET_KEY');
  if (!accessKeyId || !secretAccessKey) throw new Error(`${prefix}_S3_ACCESS_KEY / ${prefix}_S3_SECRET_KEY are required`);
  return new S3Client({
    region: e('REGION') ?? 'us-east-1',
    endpoint,
    forcePathStyle: (e('FORCE_PATH_STYLE') ?? 'true') !== 'false',
    credentials: { accessKeyId, secretAccessKey },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

export async function ensureBucket(s3: S3Client, Bucket: string, lock: boolean): Promise<boolean> {
  const exists = await s3.send(new HeadBucketCommand({ Bucket })).then(() => true, () => false);
  if (exists) return false;
  await s3.send(new CreateBucketCommand({ Bucket, ObjectLockEnabledForBucket: lock || undefined }));
  await s3.send(new PutBucketVersioningCommand({ Bucket, VersioningConfiguration: { Status: 'Enabled' } }));
  return true;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    argv.splice(i, 2);
    return v;
  };
  const bool = (name: string): boolean => {
    const i = argv.indexOf(name);
    if (i < 0) return false;
    argv.splice(i, 1);
    return true;
  };
  const prefix = flag('--env') ?? 'BACKUP';
  const lockDays = Number(flag('--lock-days') ?? 0);
  const lock = bool('--lock');
  const bypass = bool('--bypass');
  const [cmd, bucket, a1, a2] = argv;
  if (!cmd || !bucket) throw new Error('usage: s3.ts <ensure-bucket|put|get|head|list|prune|rm-prefix> <bucket> …');
  const s3 = clientFor(prefix);

  switch (cmd) {
    case 'ensure-bucket': {
      const created = await ensureBucket(s3, bucket, lock);
      console.log(created ? `created ${bucket}${lock ? ' (versioning + object lock)' : ''}` : `exists ${bucket}`);
      break;
    }
    case 'put': {
      if (!a1 || !a2) throw new Error('put <bucket> <key> <file>');
      const params: Record<string, unknown> = { Bucket: bucket, Key: a1, Body: createReadStream(a2), ContentLength: statSync(a2).size };
      if (lockDays > 0) {
        params.ObjectLockMode = 'GOVERNANCE';
        params.ObjectLockRetainUntilDate = new Date(Date.now() + lockDays * 86_400_000);
      }
      const up = new Upload({ client: s3, params: params as never, partSize: 64 * 1024 * 1024, queueSize: 4 });
      const res = await up.done();
      console.log(JSON.stringify({ bucket, key: a1, versionId: (res as { VersionId?: string }).VersionId ?? null }));
      break;
    }
    case 'get': {
      if (!a1 || !a2) throw new Error('get <bucket> <key> <file>');
      const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: a1 }));
      await pipeline(out.Body as Readable, createWriteStream(a2));
      break;
    }
    case 'head': {
      if (!a1) throw new Error('head <bucket> <key>');
      const h = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: a1 }));
      console.log(JSON.stringify({ size: h.ContentLength, etag: h.ETag, lockMode: h.ObjectLockMode ?? null, retainUntil: h.ObjectLockRetainUntilDate ?? null, versionId: h.VersionId ?? null }));
      break;
    }
    case 'list': {
      let token: string | undefined;
      do {
        const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: a1 ?? '', ContinuationToken: token }));
        for (const o of r.Contents ?? []) console.log(JSON.stringify({ key: o.Key, size: o.Size, lastModified: o.LastModified }));
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token);
      break;
    }
    case 'prune':
    case 'rm-prefix': {
      const cutoff = cmd === 'prune' ? Date.now() - Number(a2 ?? NaN) * 86_400_000 : Infinity;
      if (cmd === 'prune' && !Number.isFinite(cutoff)) throw new Error('prune <bucket> <prefix> <days>');
      let deleted = 0;
      let retained = 0;
      let keyMarker: string | undefined;
      let versionMarker: string | undefined;
      do {
        const r = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: a1 ?? '', KeyMarker: keyMarker, VersionIdMarker: versionMarker }));
        const items = [...(r.Versions ?? []), ...(r.DeleteMarkers ?? [])];
        for (const v of items) {
          if (!v.Key || (v.LastModified && v.LastModified.getTime() > cutoff)) continue;
          try {
            await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: v.Key, VersionId: v.VersionId, BypassGovernanceRetention: bypass || undefined }));
            deleted++;
          } catch (err) {
            retained++;
            console.error(`kept ${v.Key}@${v.VersionId}: ${(err as Error).name}`);
          }
        }
        keyMarker = r.IsTruncated ? r.NextKeyMarker : undefined;
        versionMarker = r.IsTruncated ? r.NextVersionIdMarker : undefined;
      } while (keyMarker);
      console.log(JSON.stringify({ deleted, retainedByLock: retained }));
      break;
    }
    default:
      throw new Error(`unknown command ${cmd}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/s3.ts')) {
  main().catch((err: Error) => {
    console.error(`s3.ts: ${err.name}: ${err.message}`);
    process.exit(1);
  });
}
