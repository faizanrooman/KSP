// Single-request latency (no concurrency) per scenario: median of N sequential calls. Quick before/after checks.
//   node tests/perf/single.mjs [N]
import { getJson, login, postJson } from './lib.mjs';

const N = Number(process.argv[2] ?? 5);
const t = { station: await login('io.meera'), district: await login('perf.sup'), state: await login('perf.state') };
const cases = [
  ['evidence-list station', () => getJson('/api/v1/evidence?pageSize=25', t.station)],
  ['evidence-list district', () => getJson('/api/v1/evidence?pageSize=25', t.district)],
  ['evidence-list state', () => getJson('/api/v1/evidence?pageSize=25', t.state)],
  ['evidence-list state q=snatching', () => getJson('/api/v1/evidence?q=snatching&pageSize=25', t.state)],
  ['search text state', () => postJson('/api/v1/search/evidence', t.state, { text: 'chain snatching', pageSize: 25 })],
  ['search text station', () => postJson('/api/v1/search/evidence', t.station, { text: 'chain snatching', pageSize: 25 })],
  ['search radius state', () => postJson('/api/v1/search/evidence', t.state, { location: { lat: 12.97, lon: 77.59, radiusKm: 5 }, pageSize: 25 })],
  ['search facets state', () => postJson('/api/v1/search/evidence', t.state, { text: 'theft', includeFacets: true, pageSize: 25 })],
  ['search facets station', () => postJson('/api/v1/search/evidence', t.station, { includeFacets: true, pageSize: 25 })],
  ['dashboard station', () => getJson('/api/v1/dashboard/summary', t.station)],
  ['dashboard district', () => getJson('/api/v1/dashboard/summary', t.district)],
  ['dashboard state', () => getJson('/api/v1/dashboard/summary', t.state)],
];
const only = process.argv[3];
for (const [name, fn] of cases) {
  if (only && !name.includes(only)) continue;
  const ms = [];
  let timings;
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    const r = await fn();
    ms.push(performance.now() - t0);
    timings = r.timings ?? r.tookMs ?? timings;
  }
  ms.sort((a, b) => a - b);
  console.log(`${name.padEnd(34)} median ${ms[Math.floor(N / 2)].toFixed(0).padStart(6)} ms  min ${ms[0].toFixed(0)}${timings ? `  ${JSON.stringify(timings)}` : ''}`);
}
