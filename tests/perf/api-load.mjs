// HTTP load scenarios against a running API on the perf dataset (tests/perf/seed/*.sql).
//   PERF_BASE=http://127.0.0.1:4130 node tests/perf/api-load.mjs [--only name1,name2] [--levels 10,50,100] [--out file.jsonl]
import { appendFileSync } from 'node:fs';
import { BASE, getJson, login, run } from './lib.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const only = arg('only')?.split(',');
const levels = (arg('levels', '10,50,100')).split(',').map(Number);
const out = arg('out');
const label = arg('label', '');

const tokens = {
  station: await login('io.meera'),
  district: await login('perf.sup'),
  state: await login('perf.state'),
};
const ids = (await getJson('/api/v1/evidence?pageSize=200&sort=-recorded_at', tokens.state)).items.map((e) => e.id);
const hot = (await getJson('/api/v1/audit/events?limit=1&actor=perf.hot', tokens.state).catch(() => ({ items: [] }))).items[0]?.evidenceId;
const head = (await getJson('/api/v1/audit/events?limit=1', tokens.state)).items[0].seq;
const J = (b) => JSON.stringify(b);

const scenarios = {
  'login': { requests: [{ method: 'POST', path: '/api/v1/auth/login', setup: (req, n) => ({ ...req, body: J({ username: `perf.u${String(1 + (n % 2900)).padStart(5, '0')}`, password: 'Ksp@Dev-Passw0rd!', tokenMode: 'bearer' }) }) }] },
  'evidence-list:station': { token: tokens.station, requests: [{ method: 'GET', path: '/api/v1/evidence?page=1&pageSize=25' }] },
  'evidence-list:district': { token: tokens.district, requests: [{ method: 'GET', path: '/api/v1/evidence?page=1&pageSize=25' }] },
  'evidence-list:state': { token: tokens.state, requests: [{ method: 'GET', path: '/api/v1/evidence?page=1&pageSize=25' }] },
  'evidence-list:state-filters': { token: tokens.state, requests: [
    { method: 'GET', path: '/api/v1/evidence?category=TRAFFIC&tag=court&sort=-recorded_at&pageSize=25' },
    { method: 'GET', path: `/api/v1/evidence?recordedFrom=${new Date(Date.now() - 30 * 864e5).toISOString()}&sort=-recorded_at&pageSize=25` },
    { method: 'GET', path: '/api/v1/evidence?q=snatching&pageSize=25' },
    { method: 'GET', path: '/api/v1/evidence?page=200&pageSize=25&sort=-created_at' },
  ] },
  'search:text': { token: tokens.state, requests: [{ method: 'POST', path: '/api/v1/search/evidence', body: J({ text: 'chain snatching', pageSize: 25 }) }] },
  'search:ai': { token: tokens.state, requests: [{ method: 'POST', path: '/api/v1/search/evidence', body: J({ ai: { labels: ['motorcycle'], minConfidence: 0.8 }, pageSize: 25 }) }] },
  'search:plate': { token: tokens.state, requests: [{ method: 'POST', path: '/api/v1/search/evidence', body: J({ ai: { plateText: 'KA12' }, pageSize: 25 }) }] },
  'search:radius': { token: tokens.state, requests: [{ method: 'POST', path: '/api/v1/search/evidence', body: J({ location: { lat: 12.97, lon: 77.59, radiusKm: 5 }, pageSize: 25 }) }] },
  'search:facets': { token: tokens.state, requests: [{ method: 'POST', path: '/api/v1/search/evidence', body: J({ text: 'theft', includeFacets: true, pageSize: 25 }) }] },
  'search:station-facets': { token: tokens.station, requests: [{ method: 'POST', path: '/api/v1/search/evidence', body: J({ includeFacets: true, pageSize: 25 }) }] },
  'evidence-detail': { token: tokens.state, requests: [{ method: 'GET', path: '/api/v1/evidence/x', setup: (req, n) => ({ ...req, path: `/api/v1/evidence/${ids[n % ids.length]}` }) }] },
  'dashboard:station': { token: tokens.station, requests: [{ method: 'GET', path: '/api/v1/dashboard/summary' }] },
  'dashboard:district': { token: tokens.district, requests: [{ method: 'GET', path: '/api/v1/dashboard/summary' }] },
  'dashboard:state': { token: tokens.state, requests: [{ method: 'GET', path: '/api/v1/dashboard/summary' }] },
  'audit:page1': { token: tokens.state, requests: [{ method: 'GET', path: '/api/v1/audit/events?limit=50' }] },
  'audit:keyset-deep': { token: tokens.state, requests: [{ method: 'GET', path: '/api/v1/audit/events', setup: (req, n) => ({ ...req, path: `/api/v1/audit/events?limit=50&before=${Math.max(51, Number(head) - ((n * 104729) % Number(head)))}` }) }] },
  'audit:filter-evidence': { token: tokens.state, requests: [{ method: 'GET', path: '/api/v1/audit/events', setup: (req, n) => ({ ...req, path: `/api/v1/audit/events?limit=50&evidenceId=${ids[n % ids.length]}` }) }] },
  'custody:hot-1k': { token: tokens.state, requests: [{ method: 'GET', path: `/api/v1/custody/evidence/${hot}` }] },
};

console.log(`base ${BASE}; ${ids.length} ids; hot=${hot}; audit head=${head}`);
for (const [name, s] of Object.entries(scenarios)) {
  if (only && !only.some((o) => name.startsWith(o))) continue;
  for (const c of levels) {
    const row = await run(name, { connections: c, ...s });
    if (out) appendFileSync(out, `${JSON.stringify({ ...row, label })}\n`);
  }
}
