/**
 * FN-13 / FN-19 before/after measurements on a perf database (tests/perf/seed/*.sql):
 *  - search: the old page query with `count(*) OVER ()` vs the new page query + count capped at TOTAL_CAP
 *    (same WHERE clause, as the state-level auditor persona `perf.state` and the station IO `io.meera`);
 *  - custody: GET /custody/evidence/:hot as one 200-event page vs the whole 1 000-event chain (the old response
 *    shape), response size and latency, over HTTP against an API started on that database (PERF_BASE).
 *   KSP_ENV_FILE=<perf .env> PERF_BASE=http://127.0.0.1:<api port> npx tsx --conditions=ksp-src tests/perf/paging-bench.mts [N]
 */
import { randomUUID } from 'node:crypto';
import { sql, type RawBuilder } from 'kysely';
import { createDb, loadConfig } from '@ksp/core';
import { loadUserPrincipal } from '../../apps/api/src/lib/load-principal.js';
import { buildConditions, whereSql, type SearchCriteria } from '../../apps/api/src/modules/search/criteria.js';
import { countQuery, facets, pageQuery, rankSql } from '../../apps/api/src/modules/search/service.js';
import { getJson, login } from './lib.mjs';

const N = Number(process.argv[2] ?? 5);
const { db } = createDb(loadConfig().DATABASE_URL, 4);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
async function time(fn: () => Promise<unknown>): Promise<number> {
  const ms: number[] = [];
  await fn(); // warm-up
  for (let i = 0; i < N; i++) {
    const t = performance.now();
    await fn();
    ms.push(performance.now() - t);
  }
  return median(ms);
}
const principal = async (username: string) => {
  const u = await db.selectFrom('users').select('id').where('username', '=', username).executeTakeFirstOrThrow();
  return (await loadUserPrincipal(db, u.id, randomUUID(), true))!;
};
const oldPage = (p: Awaited<ReturnType<typeof principal>>, c: SearchCriteria, order: RawBuilder<unknown>) =>
  sql`SELECT e.id, ${rankSql(c)} AS rank, count(*) OVER () AS total FROM evidence e WHERE ${whereSql(buildConditions(p, c))} ORDER BY ${order} LIMIT 25`;

const state = await principal('perf.state');
const station = await principal('io.meera');
const cases: Array<[string, typeof state, SearchCriteria, 'relevance' | '-recorded_at']> = [
  ['state  text "theft"', state, { text: 'theft', tagMode: 'any' }, 'relevance'],
  ['state  no criteria (all)', state, { tagMode: 'any' }, '-recorded_at'],
  ['state  category INCIDENT', state, { categories: ['INCIDENT'], tagMode: 'any' } as SearchCriteria, '-recorded_at'],
  ['station no criteria', station, { tagMode: 'any' }, '-recorded_at'],
];
console.log(`search (median of ${N}, ms)                  old page+window   new page ‖ capped count   matches`);
for (const [name, p, c, sort] of cases) {
  const order = sort === 'relevance' ? sql`rank DESC, e.id` : sql`e.recorded_at DESC NULLS LAST, e.id`;
  const before = await time(() => oldPage(p, c, order).execute(db));
  const newPage = await time(() => pageQuery(p, c, sort, 1, 25).execute(db));
  const newCount = await time(() => countQuery(p, c).execute(db));
  const both = await time(() => Promise.all([pageQuery(p, c, sort, 1, 25).execute(db), countQuery(p, c).execute(db)]));
  const n = Number((await sql<{ n: string }>`SELECT count(*) n FROM evidence e WHERE ${whereSql(buildConditions(p, c))}`.execute(db)).rows[0]!.n);
  const fac = await time(() => facets(db, p, c));
  console.log(`${name.padEnd(42)} ${before.toFixed(1).padStart(8)}   ${newPage.toFixed(1).padStart(8)} ‖ ${newCount.toFixed(1).padStart(6)} (together ${both.toFixed(1)})   ${String(n).padStart(6)}   facets ${fac.toFixed(1)}`);
}

// Custody view over HTTP: the hot item (most audit rows).
const hot = (await sql<{ id: string; n: string }>`SELECT evidence_id AS id, count(*) n FROM audit_events WHERE evidence_id IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 1`.execute(db)).rows[0]!;
const token = await login('perf.state');
const measure = async (qs: string) => {
  let bytes = 0;
  let events = 0;
  const ms = await time(async () => {
    const r = await getJson(`/api/v1/custody/evidence/${hot.id}${qs}`, token);
    bytes = Buffer.byteLength(JSON.stringify(r));
    events = (r as { events: unknown[] }).events.length;
  });
  return { ms, bytes, events };
};
const page = await measure('');
const all = await measure('?limit=1000');
console.log(`\ncustody hot item (${hot.n} events), median of ${N}`);
console.log(`  first page (default 200):  ${page.ms.toFixed(0)} ms, ${(page.bytes / 1024).toFixed(0)} KiB, ${page.events} events, whole chain verified`);
console.log(`  whole chain in one response (old shape, limit=1000): ${all.ms.toFixed(0)} ms, ${(all.bytes / 1024).toFixed(0)} KiB, ${all.events} events`);
await db.destroy();
