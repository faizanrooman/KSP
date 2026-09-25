#!/usr/bin/env node
/**
 * Object-storage replication to a DR object store, with SHA-256 verification of every evidence original against
 * the database (evidence.sha256). Runs with plain `node` (Node 22 type stripping) from the repo or the backup image.
 *
 *   node scripts/backup/s3-replicate.ts                 replicate new/changed objects primary -> DR (idempotent)
 *   node scripts/backup/s3-replicate.ts --verify-only   re-hash every evidence original IN THE DR STORE vs the DB
 *   node scripts/backup/s3-replicate.ts --repoint       after a failover restore: point evidence.storage_version_id
 *                                                       at the DR copy (only after a full re-hash matches the DB;
 *                                                       one custody audit event per item)
 * Options: --buckets evidence,archive,longterm,derived,exports,reports  --concurrency 4  --lock-days N (override the
 *          source retain-until on DR copies; drills only)  --rehash (re-read objects already replicated)  --dry-run
 *
 * Environment
 *   S3_ENDPOINT S3_REGION S3_ACCESS_KEY S3_SECRET_KEY S3_FORCE_PATH_STYLE   primary store (read-only identity suffices)
 *   DR_S3_ENDPOINT DR_S3_REGION DR_S3_ACCESS_KEY DR_S3_SECRET_KEY           DR store (write identity, no delete needed)
 *   S3_BUCKET_*                bucket names (same defaults as the application); DR_BUCKET_PREFIX (default "": the DR
 *                              store holds the SAME bucket names, so a restored database works unchanged)
 *   DATABASE_URL               KSP database (ksp_app) — evidence hashes; --repoint writes through it
 *   BACKUP_RECORD_URL          optional: record an S3_REPLICATION row in backup_runs
 *
 * Why not only native replication? AWS S3 Replication / MinIO site replication preserve version IDs and should be
 * the primary mechanism (docs/DISASTER-RECOVERY.md). This tool is the store-agnostic fallback and the independent
 * verifier; copies it makes get NEW version IDs, hence --repoint after a failover.
 */
import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import type { Readable } from 'node:stream';
import {
  GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectLegalHoldCommand, S3Client,
} from '@aws-sdk/client-s3';
import type { HeadObjectCommandOutput } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import pg from 'pg';
import { ensureBucket } from './s3.ts';

type Role = 'staging' | 'evidence' | 'archive' | 'longterm' | 'derived' | 'exports' | 'reports';
const DEFAULTS: Record<Role, [string, string]> = {
  staging: ['S3_BUCKET_STAGING', 'ksp-staging'],
  evidence: ['S3_BUCKET_EVIDENCE', 'ksp-evidence'],
  archive: ['S3_BUCKET_ARCHIVE', 'ksp-evidence-archive'],
  longterm: ['S3_BUCKET_LONG_TERM', 'ksp-evidence-longterm'],
  derived: ['S3_BUCKET_DERIVED', 'ksp-derived'],
  exports: ['S3_BUCKET_EXPORTS', 'ksp-exports'],
  reports: ['S3_BUCKET_REPORTS', 'ksp-reports'],
};
const WORM: Role[] = ['evidence', 'archive', 'longterm'];

const argv = process.argv.slice(2);
const opt = (name: string, def?: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
};
const has = (name: string): boolean => argv.includes(name);
const mode = has('--verify-only') ? 'verify' : has('--repoint') ? 'repoint' : 'replicate';
const roles = (opt('--buckets', 'evidence,archive,longterm,derived,exports,reports') ?? '').split(',').filter(Boolean) as Role[];
// --repoint runs serially: each pointer change + its audit event is one transaction on a single connection.
const concurrency = mode === 'repoint' ? 1 : Math.max(1, Number(opt('--concurrency', '4')));
const lockDaysOverride = opt('--lock-days') ? Number(opt('--lock-days')) : undefined;
const rehash = has('--rehash');
const dryRun = has('--dry-run');
const drPrefix = process.env.DR_BUCKET_PREFIX ?? '';

function s3(prefix: 'S3' | 'DR_S3'): S3Client {
  const e = (k: string) => process.env[`${prefix}_${k}`];
  if (!e('ACCESS_KEY') || !e('SECRET_KEY')) throw new Error(`${prefix}_ACCESS_KEY / ${prefix}_SECRET_KEY are required`);
  return new S3Client({
    region: e('REGION') ?? 'us-east-1',
    endpoint: e('ENDPOINT'),
    forcePathStyle: (e('FORCE_PATH_STYLE') ?? 'true') !== 'false',
    credentials: { accessKeyId: e('ACCESS_KEY')!, secretAccessKey: e('SECRET_KEY')! },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}
const bucketOf = (r: Role): string => process.env[DEFAULTS[r][0]] ?? DEFAULTS[r][1];

async function head(c: S3Client, Bucket: string, Key: string): Promise<HeadObjectCommandOutput | null> {
  try {
    return await c.send(new HeadObjectCommand({ Bucket, Key }));
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

async function hashObject(c: S3Client, Bucket: string, Key: string, VersionId?: string): Promise<{ sha256: string; size: number }> {
  const out = await c.send(new GetObjectCommand({ Bucket, Key, VersionId }));
  const h = createHash('sha256');
  let size = 0;
  for await (const chunk of out.Body as Readable) {
    h.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { sha256: h.digest('hex'), size };
}

/** Run fn over items with bounded concurrency. */
async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]!);
  }));
}

interface Stats { listed: number; copied: number; skipped: number; bytes: number; failed: number; verified: number; repointed: number }
const stats: Stats = { listed: 0, copied: 0, skipped: 0, bytes: 0, failed: 0, verified: 0, repointed: 0 };
const problems: string[] = [];

async function loadOriginals(db: pg.Client): Promise<Map<string, { id: string; sha256: string; size: number; versionId: string | null; orgUnitId: string | null }>> {
  const { rows } = await db.query<{ id: string; storage_bucket: string; storage_key: string; sha256: string; size_bytes: string; storage_version_id: string | null; org_unit_id: string | null }>(
    `SELECT id, storage_bucket, storage_key, sha256, size_bytes, storage_version_id, org_unit_id FROM evidence
      WHERE storage_key IS NOT NULL AND sha256 IS NOT NULL AND status <> 'DISPOSED' AND storage_tier <> 'STAGING'`);
  return new Map(rows.map((r) => [`${r.storage_bucket}/${r.storage_key}`, { id: r.id, sha256: r.sha256, size: Number(r.size_bytes), versionId: r.storage_version_id, orgUnitId: r.org_unit_id }]));
}

async function replicate(src: S3Client, dr: S3Client, originals: Map<string, { sha256: string; size: number }>): Promise<void> {
  for (const role of roles) {
    const Bucket = bucketOf(role);
    const Target = drPrefix + Bucket;
    const worm = WORM.includes(role);
    if (!dryRun) await ensureBucket(dr, Target, worm);
    const keys: { Key: string; Size: number; ETag: string }[] = [];
    let token: string | undefined;
    do {
      const r = await src.send(new ListObjectsV2Command({ Bucket, ContinuationToken: token }));
      for (const o of r.Contents ?? []) if (o.Key) keys.push({ Key: o.Key, Size: o.Size ?? 0, ETag: (o.ETag ?? '').replace(/"/g, '') });
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    stats.listed += keys.length;
    await pool(keys, concurrency, async ({ Key, Size, ETag }) => {
      const expected = originals.get(`${Bucket}/${Key}`);
      try {
        const existing = await head(dr, Target, Key);
        // Already replicated: same size and the marker written at copy time matches (DB hash for originals,
        // source ETag otherwise). --rehash forces a re-copy check; --verify-only re-reads DR copies fully.
        const marker = expected ? expected.sha256 : ETag;
        if (existing && existing.ContentLength === Size && existing.Metadata?.['ksp-replica-of'] === marker && !rehash) {
          stats.skipped++;
          return;
        }
        if (existing && WORM.includes(role)) throw new Error('DR copy exists but differs (WORM target: not overwritten; investigate)');
        if (dryRun) {
          stats.copied++;
          return;
        }
        const srcHead = await src.send(new HeadObjectCommand({ Bucket, Key }));
        const obj = await src.send(new GetObjectCommand({ Bucket, Key, VersionId: srcHead.VersionId }));
        const h = createHash('sha256');
        const tap = new Transform({ transform(chunk, _enc, cb) { h.update(chunk as Buffer); cb(null, chunk); } });
        (obj.Body as Readable).pipe(tap);
        const params: Record<string, unknown> = {
          Bucket: Target, Key, Body: tap, ContentLength: srcHead.ContentLength, ContentType: srcHead.ContentType,
          Metadata: { ...(srcHead.Metadata ?? {}), 'ksp-source-version': srcHead.VersionId ?? 'null', 'ksp-replica-of': marker },
        };
        if (worm) {
          const until = lockDaysOverride !== undefined ? new Date(Date.now() + lockDaysOverride * 86_400_000) : srcHead.ObjectLockRetainUntilDate;
          if (until) {
            params.ObjectLockMode = srcHead.ObjectLockMode ?? 'GOVERNANCE';
            params.ObjectLockRetainUntilDate = until;
          }
        }
        // Originals: the DB hash is written as the marker up front and the streamed bytes are hashed on the way;
        // a mismatch fails the run (the copy is flagged in the output; WORM prevents silently replacing it).
        const up = new Upload({ client: dr, params: params as never, partSize: 64 * 1024 * 1024, queueSize: 2 });
        await up.done();
        const sha = h.digest('hex');
        if (expected && sha !== expected.sha256) throw new Error(`SOURCE hash ${sha} != DB ${expected.sha256} (primary copy corrupted?)`);
        if (srcHead.ObjectLockLegalHoldStatus === 'ON') {
          await dr.send(new PutObjectLegalHoldCommand({ Bucket: Target, Key, LegalHold: { Status: 'ON' } })).catch((e: Error) => problems.push(`${Target}/${Key}: legal hold not replicated (${e.name})`));
        }
        stats.copied++;
        stats.bytes += srcHead.ContentLength ?? 0;
        if (expected) stats.verified++;
      } catch (err) {
        stats.failed++;
        problems.push(`${Bucket}/${Key}: ${(err as Error).message}`);
      }
    });
  }
}

async function verifyOrRepoint(dr: S3Client, db: pg.Client, originals: Map<string, { id: string; sha256: string; size: number; versionId: string | null; orgUnitId: string | null }>): Promise<void> {
  const items = [...originals.entries()];
  await pool(items, concurrency, async ([loc, ev]) => {
    const slash = loc.indexOf('/');
    const Bucket = drPrefix + loc.slice(0, slash);
    const Key = loc.slice(slash + 1);
    try {
      const h = await head(dr, Bucket, Key);
      if (!h) throw new Error('missing in DR store');
      const got = await hashObject(dr, Bucket, Key, h.VersionId);
      if (got.sha256 !== ev.sha256 || got.size !== ev.size) throw new Error(`DR copy sha256 ${got.sha256}/${got.size} B != DB ${ev.sha256}/${ev.size} B`);
      stats.verified++;
      if (mode === 'repoint' && h.VersionId && h.VersionId !== ev.versionId && !dryRun) {
        await db.query('BEGIN');
        try {
          const upd = await db.query(`UPDATE evidence SET storage_version_id = $2, updated_at = now() WHERE id = $1 AND sha256 = $3 AND storage_key = $4`, [ev.id, h.VersionId, ev.sha256, Key]);
          if (upd.rowCount !== 1) throw new Error('evidence row changed concurrently');
          await db.query(`UPDATE evidence_storage_copies SET version_id = $2, status_note = coalesce(status_note || '; ', '') || 'DR repoint from ' || coalesce(version_id, 'null'), updated_at = now()
                           WHERE evidence_id = $1 AND status = 'CURRENT' AND object_key = $3`, [ev.id, h.VersionId, Key]);
          await db.query(`SELECT audit_append('SYSTEM', 'dr-repoint', 'dr-repoint', NULL, NULL, NULL, 'EVIDENCE_STORAGE_REPOINTED', 'CUSTODY', 'SUCCESS', 'evidence', $1::text, $1::uuid, NULL, $2::uuid, $3::jsonb)`,
            [ev.id, ev.orgUnitId, JSON.stringify({ bucket: Bucket, fromVersionId: ev.versionId, toVersionId: h.VersionId, sha256: got.sha256, reason: 'DR failover: pointer moved to verified DR copy' })]);
          await db.query('COMMIT');
          stats.repointed++;
        } catch (err) {
          await db.query('ROLLBACK');
          throw err;
        }
      }
    } catch (err) {
      stats.failed++;
      problems.push(`${loc}: ${(err as Error).message}`);
    }
  });
}

async function main(): Promise<void> {
  const t0 = Date.now();
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required (evidence hashes)');
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL, application_name: `ksp-s3-replicate-${mode}` });
  await db.connect();
  let record: pg.Client | null = null;
  let runId: string | null = null;
  if (process.env.BACKUP_RECORD_URL && mode === 'replicate' && !dryRun) {
    record = new pg.Client({ connectionString: process.env.BACKUP_RECORD_URL });
    await record.connect();
    runId = (await record.query<{ id: string }>(`INSERT INTO backup_runs (kind, status) VALUES ('S3_REPLICATION', 'RUNNING') RETURNING id`)).rows[0]!.id;
  }
  try {
    const originals = await loadOriginals(db);
    const dr = s3('DR_S3');
    if (mode === 'replicate') await replicate(s3('S3'), dr, originals);
    else await verifyOrRepoint(dr, db, originals);
    const summary = { mode, ...stats, originalsInDb: originals.size, seconds: Math.round((Date.now() - t0) / 100) / 10, problems };
    console.log(JSON.stringify(summary, null, 2));
    if (record && runId) {
      await record.query(`UPDATE backup_runs SET status = $2, finished_at = now(), size_bytes = $3, location = $4, error = $5 WHERE id = $1`,
        [runId, stats.failed ? 'FAILED' : 'SUCCEEDED', stats.bytes, `${process.env.DR_S3_ENDPOINT ?? 'dr'} (${roles.join(',')})`, stats.failed ? problems.slice(0, 20).join('\n') : null]);
    }
    if (stats.failed) process.exitCode = 1;
  } finally {
    await db.end();
    await record?.end();
  }
}

main().catch((err: Error) => {
  console.error(`s3-replicate: ${err.message}`);
  process.exit(1);
});
