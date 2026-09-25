import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createDb, getQueue, loadConfig, queueStats, stopQueue, storage, writeHeartbeat, type Database } from '@ksp/core';
import { createRegisteredEvidence } from '../../api/test/fixtures/evidence.js';
import { pruneSnapshots, runStorageSnapshot } from '../src/jobs/storage/snapshot.js';
import { heartbeatIdentity, instrumentBoss, register, registerDbGauges } from '../src/lib/monitoring.js';

let db: Database;

beforeAll(async () => {
  db = createDb(loadConfig().DATABASE_URL, 4).db;
  await getQueue();
  const op = (await db.selectFrom('users').select('id').where('username', '=', 'op.cubbon').executeTakeFirstOrThrow()).id;
  await createRegisteredEvidence({ db, orgCode: 'ps_cubbonpark', uploadedBy: op });
  await createRegisteredEvidence({ db, orgCode: 'ps_indiranagar', uploadedBy: op });
}, 120_000);

afterAll(async () => {
  await stopQueue();
  await db.destroy();
});

describe('storage.snapshot', () => {
  it('lists small buckets in S3 and records DB sums alongside; values match the store', async () => {
    const st = storage();
    await st.put(st.bucket('reports'), `snapshot-test/${Date.now()}.txt`, Buffer.from('hello report'));
    const rows = await runStorageSnapshot({ db, storage: st }, { forceList: true });
    expect(rows.map((r) => r.tier).sort()).toEqual(['ACTIVE', 'ARCHIVE', 'DERIVED', 'EXPORTS', 'LONG_TERM', 'REPORTS', 'STAGING']);
    const evid = rows.find((r) => r.tier === 'ACTIVE')!;
    const u = await st.usage(st.bucket('evidence'));
    expect(evid).toMatchObject({ source: 'S3_LIST', objectCount: u.objects, totalBytes: u.bytes });
    const dbSum = await db.selectFrom('evidence').select([sql<number>`count(*)::int`.as('n'), sql<string>`coalesce(sum(size_bytes),0)::text`.as('b')])
      .where('storage_bucket', '=', st.bucket('evidence')).where('storage_key', 'is not', null).where('status', '<>', 'DISPOSED').executeTakeFirstOrThrow();
    expect(evid.dbObjectCount).toBe(dbSum.n);
    expect(evid.dbTotalBytes).toBe(Number(dbSum.b));
    const rep = rows.find((r) => r.tier === 'REPORTS')!;
    expect(rep.objectCount).toBeGreaterThanOrEqual(1);
    const stored = await db.selectFrom('storage_snapshots').selectAll().where('bucket', '=', st.bucket('evidence')).orderBy('id', 'desc').executeTakeFirstOrThrow();
    expect(stored).toMatchObject({ tier: 'ACTIVE', source: 'S3_LIST', object_count: u.objects });
  });

  it('large buckets use database sums between periodic cross-checks', async () => {
    const rows = await runStorageSnapshot({ db, storage: storage() }, { listLimit: 0 });
    const evid = rows.find((r) => r.tier === 'ACTIVE')!;
    expect(evid.source).toBe('DB_SUM');
    expect(evid.objectCount).toBe(evid.dbObjectCount);
    // buckets the catalogue says are empty are still listed; the rest use DB sums
    for (const r of rows) expect(r.source).toBe(r.dbObjectCount === 0 ? 'S3_LIST' : 'DB_SUM');
  });

  it('prunes: one snapshot per bucket per day after the detail window; nothing beyond the max age', async () => {
    const noon = new Date(Date.now() - 10 * 86_400_000);
    noon.setUTCHours(12, 0, 0, 0);
    const at = (base: Date, h: number) => new Date(base.getTime() + h * 3600_000);
    await db.insertInto('storage_snapshots').values([
      { bucket: 'prune-b', tier: 'X', object_count: 1, total_bytes: 1, captured_at: at(noon, -1) },
      { bucket: 'prune-b', tier: 'X', object_count: 2, total_bytes: 2, captured_at: noon },
      { bucket: 'prune-b', tier: 'X', object_count: 3, total_bytes: 3, captured_at: new Date(Date.now() - 500 * 86_400_000) },
      { bucket: 'prune-b', tier: 'X', object_count: 4, total_bytes: 4, captured_at: new Date(Date.now() - 86_400_000) },
    ]).execute();
    await pruneSnapshots(db, 7, 400);
    const left = await db.selectFrom('storage_snapshots').select('object_count').where('bucket', '=', 'prune-b').orderBy('captured_at').execute();
    expect(left.map((r) => Number(r.object_count))).toEqual([2, 4]);
  });
});

describe('worker monitoring', () => {
  it('heartbeat upserts one row per process', async () => {
    const who = heartbeatIdentity('ksp-worker-test');
    await writeHeartbeat(db, who, { a: 1 });
    await writeHeartbeat(db, who, { a: 2 });
    const rows = await db.selectFrom('worker_heartbeats').selectAll().where('service', '=', 'ksp-worker-test').execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pid: process.pid, info: { a: 2 } });
  });

  it('instrumented handlers and DB gauges appear in the Prometheus registry', async () => {
    const calls: Array<(jobs: unknown[]) => Promise<unknown>> = [];
    const fake = { work: async (_n: string, a: unknown, b?: unknown) => { calls.push((typeof a === 'function' ? a : b) as never); return 'id'; } };
    instrumentBoss(fake as never);
    await (fake.work as (n: string, o: object, h: (j: unknown[]) => Promise<void>) => Promise<string>)('report.build', {}, async () => undefined);
    await (fake.work as (n: string, h: (j: unknown[]) => Promise<void>) => Promise<string>)('media.process', async () => { throw new Error('boom'); });
    await calls[0]!([{}, {}]);
    await expect(calls[1]!([{}])).rejects.toThrow('boom');
    registerDbGauges(db);
    const text = await register.metrics();
    expect(text).toMatch(/ksp_worker_jobs_processed_total\{queue="report.build",outcome="completed"\} 2/);
    expect(text).toMatch(/ksp_worker_jobs_processed_total\{queue="media.process",outcome="failed"\} 1/);
    expect(text).toContain('ksp_worker_job_duration_seconds_bucket');
    expect(text).toMatch(/ksp_queue_depth\{queue="report.build",state="queued"\} \d+/);
    expect(text).toContain('ksp_queue_oldest_job_age_seconds');
    expect(text).toMatch(/ksp_fixity_checks_24h\{result="ok"\} \d+/);
    expect(text).toContain('ksp_worker_ffmpeg_duration_seconds');
    const qs = await queueStats(db);
    expect(qs.find((q) => q.queue === 'report.build.dead')?.deadLetter).toBe(true);
  });
});
