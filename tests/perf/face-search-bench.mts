/**
 * Tender §20 benchmark: "match the suspect person in less than one minute with a database size of 1 lakh".
 *
 *   npx tsx --conditions=ksp-src tests/perf/face-search-bench.mts [--faces 100000] [--keep]
 *
 * Seeds N synthetic 128-d face embeddings (unit vectors; one planted near the probe) as the schema owner, then runs
 * the production matcher (`scanEmbeddings`, as the ksp_ai role) and reports wall-clock time. Requires a migrated DB
 * with an ACTIVE face-recognition model (npm run fetch-models -w @ksp/ai-worker). Cleans up unless --keep.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createDb, loadConfig } from '@ksp/core';
import { scanEmbeddings } from '../../apps/ai-worker/src/face-search.js';
import type { AiContext } from '../../apps/ai-worker/src/context.js';

const args = process.argv.slice(2);
const N = Number(args[args.indexOf('--faces') + 1] || 100_000);
const keep = args.includes('--keep');
const cfg = loadConfig();
const owner = new pg.Client({ connectionString: cfg.DATABASE_MIGRATION_URL ?? cfg.DATABASE_URL });
await owner.connect();

const model = (await owner.query("SELECT id, code, version FROM ai_models WHERE task='FACE_RECOGNITION' AND status='ACTIVE' LIMIT 1")).rows[0];
if (!model) throw new Error('no ACTIVE FACE_RECOGNITION model');
const ev = (await owner.query("SELECT id FROM evidence WHERE status='REGISTERED' ORDER BY created_at LIMIT 1")).rows[0];
if (!ev) throw new Error('no REGISTERED evidence row to attach synthetic detections to');
const user = (await owner.query("SELECT id FROM users ORDER BY created_at LIMIT 1")).rows[0];
const jobId = randomUUID();
await owner.query(
  `INSERT INTO ai_jobs (id, evidence_id, requested_by, tasks, input, params, model_ids, status) VALUES ($1,$2,$3,'{FACE_RECOGNITION}','{}','{}',ARRAY[$4]::uuid[],'COMPLETED')`,
  [jobId, ev.id, user.id, model.id],
);

function unit(): number[] {
  const v = Array.from({ length: 128 }, () => Math.random() * 2 - 1);
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}
const probe = Float32Array.from(unit());
// planted near-duplicate (cos ≈ 0.98)
const planted = probe.map((x, i) => x + (i % 7 === 0 ? 0.03 : 0));
const pn = Math.hypot(...planted);

console.log(`seeding ${N.toLocaleString()} synthetic face embeddings…`);
const t0 = Date.now();
const BATCH = 5000;
for (let i = 0; i < N; i += BATCH) {
  const rows: string[] = [];
  const vals: unknown[] = [];
  for (let j = 0; j < Math.min(BATCH, N - i); j++) {
    const k = vals.length;
    const emb = i + j === 0 ? Array.from(planted, (x) => x / pn) : unit();
    rows.push(`($${k + 1},$${k + 2},$${k + 3},$${k + 4},$${k + 6},$${k + 7},'FACE_RECOGNITION','bench',0.9,0.5,${(i + j) * 40},$${k + 5}::real[],'{}'::jsonb)`);
    vals.push(randomUUID(), jobId, ev.id, model.id, emb, model.code, model.version);
  }
  await owner.query(
    `INSERT INTO ai_detections (id, job_id, evidence_id, model_id, model_code, model_version, task, label, confidence, threshold, frame_time_ms, embedding, attributes) VALUES ${rows.join(',')}`,
    vals,
  );
}
console.log(`seeded in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

const { db } = createDb(cfg.DATABASE_AI_URL ?? cfg.DATABASE_URL, 2);
const ctx = { db, cfg } as unknown as AiContext;
for (const run of [1, 2, 3]) {
  const t1 = Date.now();
  const r = await scanEmbeddings(ctx, model.id, probe, 0.35, 50);
  const ms = Date.now() - t1;
  console.log(`run ${run}: scanned ${r.candidates.toLocaleString()} faces in ${ms} ms; best similarity ${r.matches[0]?.similarity} (planted match ${r.matches[0]?.similarity && r.matches[0].similarity > 0.95 ? 'found' : 'NOT found'})`);
}
await db.destroy();
if (!keep) {
  await owner.query('DELETE FROM ai_detections WHERE job_id = $1', [jobId]);
  await owner.query('DELETE FROM ai_jobs WHERE id = $1', [jobId]);
  console.log('cleaned up');
}
await owner.end();
