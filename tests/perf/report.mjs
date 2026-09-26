// Markdown before/after table from two api-load result files.
//   node tests/perf/report.mjs tests/perf/results/before.jsonl tests/perf/results/after.jsonl
import { readFileSync } from 'node:fs';

const load = (f) => new Map(readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map((r) => [`${r.scenario}@${r.connections}`, r]));
const [a, b] = process.argv.slice(2).map(load);
const cell = (r) => (r ? `${r.rps} / ${r.p50} / ${r.p95} / ${r.p99}${r.errors || r.non2xx ? ` (err ${r.errors + r.non2xx})` : ''}` : '—');
console.log('| Scenario | Conc. | Before: rps / p50 / p95 / p99 ms | After: rps / p50 / p95 / p99 ms |');
console.log('|---|---|---|---|');
for (const [k, r] of b ?? a) {
  const [s, c] = k.split('@');
  console.log(`| ${s} | ${c} | ${cell(a.get(k))} | ${b ? cell(r) : ''} |`);
}
