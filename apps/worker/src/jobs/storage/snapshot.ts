/**
 * storage.snapshot cron: per bucket object counts and bytes → storage_snapshots.
 *
 * Method: the database catalogue (evidence originals by current bucket, derivatives, exports, reports,
 * in-flight staging uploads) is summed for EVERY bucket. When the catalogue says a bucket holds at most
 * `listLimit` objects the bucket is ALSO listed in S3 (authoritative, source S3_LIST) and both figures are
 * stored, so drift is visible. Larger buckets use the DB sums (source DB_SUM) — listing millions of keys
 * every 15 minutes is too expensive — and are cross-checked by a full listing once per `fullListEveryHours`.
 * Listing counts current object versions only (noncurrent WORM versions are not included).
 */
import { sql } from 'kysely';
import type { BucketRole, Database, Storage } from '@ksp/core';

export interface SnapshotDeps {
  db: Database;
  storage: Storage;
  log?: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
}

export interface SnapshotOptions {
  listLimit?: number;
  fullListEveryHours?: number;
  /** Force an S3 listing of every bucket (cross-check). */
  forceList?: boolean;
  retentionDetailDays?: number;
  retentionDays?: number;
}

export const BUCKET_TIERS: Record<BucketRole, string> = {
  staging: 'STAGING', evidence: 'ACTIVE', archive: 'ARCHIVE', longterm: 'LONG_TERM', derived: 'DERIVED', exports: 'EXPORTS', reports: 'REPORTS',
};

export interface SnapshotRow {
  bucket: string;
  tier: string;
  objectCount: number;
  totalBytes: number;
  source: 'S3_LIST' | 'DB_SUM';
  dbObjectCount: number;
  dbTotalBytes: number;
}

async function dbUsage(db: Database): Promise<Map<string, { n: number; bytes: number }>> {
  const out = new Map<string, { n: number; bytes: number }>();
  const add = (bucket: string | null, n: number, bytes: number) => {
    if (!bucket) return;
    const cur = out.get(bucket) ?? { n: 0, bytes: 0 };
    out.set(bucket, { n: cur.n + n, bytes: cur.bytes + bytes });
  };
  const { rows } = await sql<{ bucket: string | null; n: string; bytes: string }>`
    SELECT storage_bucket AS bucket, count(*) AS n, coalesce(sum(size_bytes), 0) AS bytes FROM evidence
     WHERE storage_key IS NOT NULL AND status NOT IN ('DISPOSED') GROUP BY storage_bucket
    UNION ALL
    SELECT bucket, count(*), coalesce(sum(size_bytes), 0) FROM evidence_derivatives GROUP BY bucket
    UNION ALL
    SELECT bucket, count(*), coalesce(sum(size_bytes), 0) FROM exports WHERE object_key IS NOT NULL AND status NOT IN ('EXPIRED','REVOKED') GROUP BY bucket
    UNION ALL
    SELECT bucket, count(*), coalesce(sum(size_bytes), 0) FROM report_runs WHERE object_key IS NOT NULL GROUP BY bucket
    UNION ALL
    SELECT staging_bucket, count(*), coalesce(sum(received_bytes), 0) FROM upload_sessions WHERE status IN ('INITIATED','UPLOADING','COMPLETING') GROUP BY staging_bucket`.execute(db);
  for (const r of rows) add(r.bucket, Number(r.n), Number(r.bytes));
  return out;
}

export async function runStorageSnapshot(deps: SnapshotDeps, opts: SnapshotOptions = {}): Promise<SnapshotRow[]> {
  const { db, storage: st } = deps;
  const listLimit = opts.listLimit ?? Number(process.env.STORAGE_SNAPSHOT_LIST_LIMIT ?? 50_000);
  const fullEvery = opts.fullListEveryHours ?? 24;
  const lastFull = await db.selectFrom('storage_snapshots').select(sql<Date>`max(captured_at)`.as('at')).where('source', '=', 'S3_LIST').executeTakeFirst();
  const lastFullAt = lastFull?.at ? new Date(lastFull.at).getTime() : 0;
  const crossCheck = opts.forceList || Date.now() - lastFullAt > fullEvery * 3600_000;
  const fromDb = await dbUsage(db);
  const capturedAt = new Date();
  const rows: SnapshotRow[] = [];
  for (const [role, tier] of Object.entries(BUCKET_TIERS) as Array<[BucketRole, string]>) {
    const bucket = st.bucket(role);
    const d = fromDb.get(bucket) ?? { n: 0, bytes: 0 };
    let row: SnapshotRow = { bucket, tier, objectCount: d.n, totalBytes: d.bytes, source: 'DB_SUM', dbObjectCount: d.n, dbTotalBytes: d.bytes };
    if (crossCheck || d.n <= listLimit) {
      try {
        const u = await st.usage(bucket);
        row = { ...row, objectCount: u.objects, totalBytes: u.bytes, source: 'S3_LIST' };
      } catch (e) {
        deps.log?.warn({ bucket, err: (e as Error).message }, 'storage listing failed; using database sums');
      }
    }
    rows.push(row);
  }
  await db
    .insertInto('storage_snapshots')
    .values(rows.map((r) => ({ captured_at: capturedAt, bucket: r.bucket, tier: r.tier, object_count: r.objectCount, total_bytes: r.totalBytes, source: r.source, db_object_count: r.dbObjectCount, db_total_bytes: r.dbTotalBytes })))
    .execute();
  await pruneSnapshots(db, opts.retentionDetailDays ?? 7, opts.retentionDays ?? 400);
  deps.log?.info({ buckets: rows.length, crossCheck }, 'storage snapshot captured');
  return rows;
}

/** Keep full resolution for `detailDays`, then one snapshot per bucket per day, and nothing beyond `maxDays`. */
export async function pruneSnapshots(db: Database, detailDays: number, maxDays: number): Promise<number> {
  const a = await sql`DELETE FROM storage_snapshots s
     WHERE s.captured_at < now() - make_interval(days => ${detailDays})
       AND s.id NOT IN (SELECT max(id) FROM storage_snapshots WHERE captured_at < now() - make_interval(days => ${detailDays})
                         GROUP BY bucket, date_trunc('day', captured_at))`.execute(db);
  const b = await sql`DELETE FROM storage_snapshots WHERE captured_at < now() - make_interval(days => ${maxDays})`.execute(db);
  return Number(a.numAffectedRows ?? 0) + Number(b.numAffectedRows ?? 0);
}
