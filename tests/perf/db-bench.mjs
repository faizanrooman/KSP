// Database-level benchmarks on the perf DB (connects as ksp_app, the role the API uses):
//   node tests/perf/db-bench.mjs verify            audit_verify() over the whole ledger (and the last 100k)
//   node tests/perf/db-bench.mjs append 1,10,50    audit_append() throughput: N concurrent sessions, 1 event / tx
// DATABASE_URL is read from .env (scripts/dev/agent-env.sh).
import { readFileSync } from 'node:fs';
import pg from 'pg';

const env = Object.fromEntries(readFileSync(new URL('../../.env', import.meta.url), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const url = process.env.DATABASE_URL ?? env.DATABASE_URL;
const mode = process.argv[2];

if (mode === 'verify') {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const head = Number((await c.query('SELECT max(seq) AS m FROM audit_events')).rows[0].m);
  for (const [label, from] of [['full', 1], ['last-100k', head - 100_000]]) {
    const t0 = performance.now();
    const r = (await c.query('SELECT * FROM audit_verify($1)', [from])).rows[0];
    const ms = performance.now() - t0;
    console.log(JSON.stringify({ scenario: `audit_verify:${label}`, checked: Number(r.checked), firstBad: r.first_bad_seq, headSeq: Number(r.head_seq), ms: Math.round(ms), eventsPerS: Math.round(Number(r.checked) / (ms / 1000)) }));
  }
  await c.end();
} else if (mode === 'append') {
  const levels = (process.argv[3] ?? '1,10,50').split(',').map(Number);
  const seconds = Number(process.env.PERF_DURATION ?? 10);
  for (const n of levels) {
    const pool = new pg.Pool({ connectionString: url, max: n });
    const lat = [];
    let count = 0;
    const stop = Date.now() + seconds * 1000;
    await Promise.all(Array.from({ length: n }, async (_, w) => {
      const c = await pool.connect();
      try {
        while (Date.now() < stop) {
          const t0 = performance.now();
          await c.query(`SELECT seq FROM audit_append('USER', $1, 'perf.append', '10.9.9.9'::inet, 'perf', NULL, 'EVIDENCE_VIEWED', 'CUSTODY', 'SUCCESS', 'evidence', $1, NULL, NULL, NULL, '{"bench":true}'::jsonb)`, [`w${w}`]);
          lat.push(performance.now() - t0);
          count++;
        }
      } finally { c.release(); }
    }));
    await pool.end();
    lat.sort((a, b) => a - b);
    const q = (p) => +lat[Math.min(lat.length - 1, Math.floor(lat.length * p))].toFixed(2);
    console.log(JSON.stringify({ scenario: 'audit_append', sessions: n, events: count, perS: Math.round(count / seconds), p50: q(0.5), p95: q(0.95), p99: q(0.99) }));
  }
} else {
  console.error('usage: verify | append 1,10,50');
  process.exit(2);
}
