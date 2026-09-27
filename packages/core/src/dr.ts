/**
 * DR object store (the target of scripts/backup/s3-replicate.ts) as seen by the application side: the disposal
 * sweep (dr.dispose-sweep) and fixity checks of recorded DR copies. Configured through the environment:
 *   DR_S3_ENDPOINT DR_S3_REGION DR_S3_ACCESS_KEY DR_S3_SECRET_KEY DR_S3_FORCE_PATH_STYLE
 *   DR_S3_BYPASS_GOVERNANCE (default true: delete GOVERNANCE-locked versions of DISPOSED evidence; COMPLIANCE-locked
 *   versions cannot be deleted before their retain-until date and are recorded DELETE_FAILED)
 * The identity needs s3:DeleteObjectVersion (+ s3:BypassGovernanceRetention) on the DR buckets — a different, more
 * privileged identity than the write-only replication identity; keep it out of the API.
 */
import { DeleteObjectCommand, GetObjectCommand, ListObjectVersionsCommand, S3Client } from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';

export interface DrStore {
  client: S3Client;
  endpoint: string;
  bypassGovernance: boolean;
  /** Delete one version (or the key when versionId is null). */
  deleteVersion(bucket: string, key: string, versionId: string | null): Promise<void>;
  getStream(bucket: string, key: string, versionId: string | null): Promise<Readable>;
  /** Every version id (and delete marker) of exactly this key ('null' for the null version). */
  listVersions(bucket: string, key: string): Promise<string[]>;
}

export function drStoreFromEnv(env: NodeJS.ProcessEnv = process.env): DrStore | null {
  const access = env.DR_S3_ACCESS_KEY?.trim();
  const secret = env.DR_S3_SECRET_KEY?.trim();
  if (!env.DR_S3_ENDPOINT?.trim() || !access || !secret) return null;
  const client = new S3Client({
    region: env.DR_S3_REGION ?? 'us-east-1',
    endpoint: env.DR_S3_ENDPOINT,
    forcePathStyle: (env.DR_S3_FORCE_PATH_STYLE ?? 'true') !== 'false',
    credentials: { accessKeyId: access, secretAccessKey: secret },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const bypassGovernance = (env.DR_S3_BYPASS_GOVERNANCE ?? 'true') !== 'false';
  return {
    client,
    endpoint: env.DR_S3_ENDPOINT,
    bypassGovernance,
    async deleteVersion(bucket, key, versionId) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId ?? undefined, BypassGovernanceRetention: bypassGovernance || undefined }));
    },
    async getStream(bucket, key, versionId) {
      const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId ?? undefined }));
      return r.Body as Readable;
    },
    async listVersions(bucket, key) {
      const out: string[] = [];
      let KeyMarker: string | undefined;
      let VersionIdMarker: string | undefined;
      do {
        const r = await client.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key, KeyMarker, VersionIdMarker }));
        for (const v of [...(r.Versions ?? []), ...(r.DeleteMarkers ?? [])]) if (v.Key === key) out.push(v.VersionId ?? 'null');
        KeyMarker = r.IsTruncated ? r.NextKeyMarker : undefined;
        VersionIdMarker = r.IsTruncated ? r.NextVersionIdMarker : undefined;
      } while (KeyMarker);
      return out;
    },
  };
}
