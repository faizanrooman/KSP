/**
 * Advanced search (module 10): permission-aware results + facets, AI filters (approved-only default,
 * explicit unreviewed opt-in, rejected never), colour/plate/label, location, case/FIR, text relevance,
 * pagination/sort, federated tiers, audit, saved searches, related suggestions, and a ≥5k-row EXPLAIN check.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { closeApp, getApp, login, type Agent } from './helpers.js';
import { evidenceTestSetup, evidenceTestTeardown, userId } from './evidence-setup.js';
import { asOwner, insertDetections, insertEvidence, orgOf, token } from './search-support.js';
import { loadUserPrincipal } from '../src/lib/load-principal.js';
import { countQuery, pageQuery, runSearch } from '../src/modules/search/service.js';
import type { Principal } from '../src/lib/principal.js';

const S = '/api/v1/search/evidence';
const tok = token();
const tokX = token('zx');
const tokR = token('zr');
const T0 = new Date('2026-03-10T10:00:00Z');
const CUBBON = { lat: 12.9763, lon: 77.5929 };

let meera: Agent;
let arjun: Agent;
let kavya: Agent;
let ravi: Agent;
const ids: Record<string, string> = {};
let caseNumber = '';
let firNumber = '';

const idsOf = (res: { body: { items: Array<{ id: string }> } }) => res.body.items.map((i) => i.id).sort();
const sorted = (...keys: string[]) => keys.map((k) => ids[k]!).sort();

beforeAll(async () => {
  const app = await evidenceTestSetup();
  const meeraId = await userId('io.meera');
  const arjunId = await userId('io.arjun');
  const raviId = await userId('fo.ravi');
  const mk = async (key: string, o: Parameters<typeof insertEvidence>[0]) => (ids[key] = (await insertEvidence(o)).id);
  await mk('A1', { orgCode: 'ps_cubbonpark', uploadedBy: meeraId, officerId: raviId, title: `Robbery near MG Road ${tok}`, description: `Two suspects on a red motorcycle ${tok}`, gps: CUBBON, recordedAt: T0, tags: [`${tok}-shared`, 'robbery'] });
  await mk('A2', { orgCode: 'ps_cubbonpark', uploadedBy: meeraId, officerId: raviId, title: `Traffic stop ${tok}`, gps: { lat: 12.93, lon: 77.59 }, recordedAt: new Date(T0.getTime() + 20 * 60_000), storageTier: 'ARCHIVE', legalHold: true, tags: [`${tok}-shared`] });
  await mk('B1', { orgCode: 'ps_indiranagar', uploadedBy: arjunId, title: `Robbery at 100ft road ${tok}`, gps: { lat: 12.9784, lon: 77.6408 }, recordedAt: T0, tags: [`${tok}-shared`, `${tok}-onlyb`] });
  await mk('B2', { orgCode: 'ps_indiranagar', uploadedBy: arjunId, title: `Night patrol ${tok}`, storageTier: 'LONG_TERM', recordedAt: T0 });
  await mk('A4', { orgCode: 'ps_cubbonpark', uploadedBy: meeraId, title: `Arson arson ${tokX}`, recordedAt: T0 });
  await mk('A5', { orgCode: 'ps_cubbonpark', uploadedBy: meeraId, title: `Market fire`, description: `possible arson ${tokX}`, recordedAt: T0 });
  // related: same plate (approved) and nearby + overlapping
  await mk('A6', { orgCode: 'ps_cubbonpark', uploadedBy: meeraId, title: `Parking lot ${tokR}`, recordedAt: new Date(T0.getTime() - 5 * 86_400_000) });
  await mk('A7', { orgCode: 'ps_cubbonpark', uploadedBy: meeraId, title: `Bystander clip ${tokR}`, gps: { lat: CUBBON.lat + 0.0005, lon: CUBBON.lon }, recordedAt: new Date(T0.getTime() + 30_000) });

  const plate = { plateText: 'KA 01 AB 1234' };
  await insertDetections(ids.A1!, meeraId, [
    { label: 'car', attributes: { colorName: 'Red', ...plate }, frameTimeMs: 5000 },
    { label: 'knife', reviewStatus: 'PENDING', frameTimeMs: 7000 },
    { label: 'person', reviewStatus: 'REJECTED', frameTimeMs: 8000 },
  ]);
  await insertDetections(ids.B1!, arjunId, [{ label: 'car', attributes: { colorName: 'red', ...plate } }]);
  await insertDetections(ids.A6!, meeraId, [{ task: 'ANPR', label: 'KA01AB1234', attributes: { plateText: 'KA-01-AB-1234' } }]);

  // FIR + case at Cubbon Park, A1 linked
  const org = await orgOf('ps_cubbonpark');
  firNumber = `${Math.floor(Math.random() * 90000) + 10000}`;
  const fir = await app.db.insertInto('firs').values({ fir_number: firNumber, fir_year: 2026, org_unit_id: org.id, org_path: org.path, registered_at: T0 }).returning('id').executeTakeFirstOrThrow();
  caseNumber = `CASE-${tok}`.toUpperCase();
  const c = await app.db.insertInto('cases').values({ case_number: caseNumber, title: 'Robbery case', fir_id: fir.id, org_unit_id: org.id, org_path: org.path }).returning('id').executeTakeFirstOrThrow();
  ids.case = c.id;
  await app.db.insertInto('case_evidence').values({ case_id: c.id, evidence_id: ids.A1!, linked_by: meeraId }).execute();

  [meera, arjun, kavya, ravi] = await Promise.all([login('io.meera'), login('io.arjun'), login('sup.kavya'), login('fo.ravi')]);
});

afterAll(async () => {
  await evidenceTestTeardown();
  await closeApp();
});

describe('search security', () => {
  it('401 unauthenticated, 403 without search:use, 400 on invalid criteria', async () => {
    const app = await getApp();
    expect((await app.inject({ method: 'POST', url: S, payload: {} })).statusCode).toBe(401);
    expect((await ravi.post(S, { text: tok })).status).toBe(403);
    expect((await meera.post(S, { nope: 1 })).status).toBe(400);
    expect((await meera.post(S, { recordedFrom: '2026-02-01', recordedTo: '2026-01-01' })).status).toBe(400);
    expect((await meera.post(S, { location: { lat: 99, lon: 0, radiusKm: 1 } })).status).toBe(400);
    expect((await meera.post(S, { ai: { reviewStatus: 'PENDING' } })).status).toBe(400);
  });

  it('routes are documented in the OpenAPI spec', async () => {
    const app = await getApp();
    const paths = Object.keys((app as unknown as { swagger(): { paths: Record<string, unknown> } }).swagger().paths);
    for (const p of ['/api/v1/search/evidence', '/api/v1/search/saved', '/api/v1/workspaces/{id}/timeline', '/api/v1/workspaces/annotations']) expect(paths).toContain(p);
  });

  it('identical query returns only each user’s jurisdiction', async () => {
    const m = await meera.post(S, { text: tok });
    const a = await arjun.post(S, { text: tok });
    const k = await kavya.post(S, { text: tok });
    expect(m.status).toBe(200);
    expect(idsOf(m)).toEqual(sorted('A1', 'A2'));
    expect(m.body.total).toBe(2);
    expect(idsOf(a)).toEqual(sorted('B1', 'B2'));
    expect(idsOf(k)).toEqual(sorted('A1', 'A2')); // blr_central covers Cubbon Park, not Indiranagar
    // list-item shape reused from the evidence module
    const it0 = m.body.items[0];
    expect(it0).toMatchObject({ evidenceNumber: expect.any(String), orgUnit: { name: 'Cubbon Park Police Station' }, tags: expect.any(Array), storageTier: expect.any(String) });
    expect(JSON.stringify(m.body)).not.toMatch(/storage_key|storageKey|bucket/i);
  });

  it('facets never count invisible items', async () => {
    const m = await meera.post(S, { text: tok });
    expect(m.body.facets.station).toEqual([{ key: expect.any(String), label: 'Cubbon Park Police Station', count: 2 }]);
    const tags = Object.fromEntries(m.body.facets.tag.map((b: { key: string; count: number }) => [b.key, b.count]));
    expect(tags[`${tok}-shared`]).toBe(2); // B1 carries the same tag but is invisible
    expect(tags[`${tok}-onlyb`]).toBeUndefined();
    const ai = Object.fromEntries(m.body.facets.aiLabel.map((b: { key: string; count: number }) => [b.key, b.count]));
    expect(ai).toEqual({ car: 1 }); // approved only (knife pending, person rejected; B1 car invisible)
    const tiers = Object.fromEntries(m.body.facets.storageTier.map((b: { key: string; count: number }) => [b.key, b.count]));
    expect(tiers).toEqual({ ACTIVE: 1, ARCHIVE: 1 });
  });
});

describe('AI-derived filters', () => {
  it('approved results only by default; matches carry frame times for jump-to-moment', async () => {
    const r = await meera.post(S, { text: tok, ai: { labels: ['car'] } });
    expect(idsOf(r)).toEqual(sorted('A1'));
    expect(r.body.includesUnreviewedAi).toBe(false);
    expect(r.body.items[0].matches.ai).toEqual([expect.objectContaining({ label: 'car', frameTimeMs: 5000, reviewStatus: 'APPROVED', unreviewed: false, colorName: 'Red' })]);
    expect((await meera.post(S, { text: tok, ai: { labels: ['knife'] } })).body.total).toBe(0);
  });

  it('unreviewed output only when explicitly opted in, and labelled; rejected never', async () => {
    const r = await meera.post(S, { text: tok, ai: { labels: ['knife'], reviewStatus: 'ANY_NON_REJECTED' } });
    expect(idsOf(r)).toEqual(sorted('A1'));
    expect(r.body.includesUnreviewedAi).toBe(true);
    expect(r.body.items[0].matches.ai[0]).toMatchObject({ label: 'knife', unreviewed: true, reviewStatus: 'PENDING', frameTimeMs: 7000 });
    expect((await meera.post(S, { text: tok, ai: { labels: ['person'], reviewStatus: 'ANY_NON_REJECTED' } })).body.total).toBe(0);
    expect((await meera.post(S, { text: tok, ai: { labels: ['person'] } })).body.total).toBe(0);
  });

  it('colour, plate (normalised prefix), task and confidence', async () => {
    expect(idsOf(await meera.post(S, { text: tok, ai: { labels: ['car'], colors: ['red'] } }))).toEqual(sorted('A1'));
    expect((await meera.post(S, { text: tok, ai: { labels: ['car'], colors: ['blue'] } })).body.total).toBe(0);
    expect(idsOf(await meera.post(S, { text: tok, ai: { plateText: 'ka01ab' } }))).toEqual(sorted('A1'));
    expect(idsOf(await meera.post(S, { text: tok, ai: { plateText: 'KA-01-AB-1234' } }))).toEqual(sorted('A1'));
    expect((await meera.post(S, { text: tok, ai: { plateText: 'KA02' } })).body.total).toBe(0);
    expect((await meera.post(S, { text: tok, ai: { tasks: ['ANPR'] } })).body.total).toBe(0);
    expect((await meera.post(S, { text: tok, ai: { labels: ['car'], minConfidence: 0.95 } })).body.total).toBe(0);
    // same plate for arjun only finds his own item
    expect(idsOf(await arjun.post(S, { text: tok, ai: { plateText: 'KA01AB1234' } }))).toEqual(sorted('B1'));
  });
});

describe('metadata filters', () => {
  it('location radius (haversine) and bbox', async () => {
    expect(idsOf(await meera.post(S, { text: tok, location: { ...CUBBON, radiusKm: 1 } }))).toEqual(sorted('A1'));
    expect(idsOf(await meera.post(S, { text: tok, location: { ...CUBBON, radiusKm: 10 } }))).toEqual(sorted('A1', 'A2'));
    expect(idsOf(await meera.post(S, { text: tok, bbox: { minLat: 12.9, maxLat: 12.95, minLon: 77.5, maxLon: 77.6 } }))).toEqual(sorted('A2'));
    expect((await meera.post(S, { location: CUBBON, bbox: { minLat: 1, maxLat: 2, minLon: 1, maxLon: 2 } })).status).toBe(400);
  });

  it('case and FIR filters (cases the caller can read only)', async () => {
    expect(idsOf(await meera.post(S, { caseNumber }))).toEqual(sorted('A1'));
    expect(idsOf(await meera.post(S, { caseIds: [ids.case] }))).toEqual(sorted('A1'));
    expect(idsOf(await meera.post(S, { firNumber, firYear: 2026 }))).toEqual(sorted('A1'));
    const station = (await orgOf('ps_cubbonpark')).id;
    expect(idsOf(await meera.post(S, { firNumber, firOrgUnitId: station }))).toEqual(sorted('A1'));
    expect((await meera.post(S, { firNumber, firYear: 2025 })).body.total).toBe(0);
    expect((await arjun.post(S, { caseIds: [ids.case] })).body.total).toBe(0);
    expect((await meera.post(S, { firYear: 2026 })).status).toBe(400);
  });

  it('federated tiers, legal hold, tags any/all, officer, status', async () => {
    expect(idsOf(await meera.post(S, { text: tok, storageTiers: ['ARCHIVE', 'LONG_TERM'] }))).toEqual(sorted('A2'));
    expect(idsOf(await arjun.post(S, { text: tok, storageTiers: ['LONG_TERM'] }))).toEqual(sorted('B2'));
    expect(idsOf(await meera.post(S, { text: tok, legalHold: true }))).toEqual(sorted('A2'));
    expect(idsOf(await meera.post(S, { text: tok, tags: [`${tok}-shared`, 'robbery'], tagMode: 'all' }))).toEqual(sorted('A1'));
    expect(idsOf(await meera.post(S, { text: tok, tags: [`${tok}-shared`, 'robbery'], tagMode: 'any' }))).toEqual(sorted('A1', 'A2'));
    const ravi = await userId('fo.ravi');
    expect(idsOf(await meera.post(S, { text: tok, officerIds: [ravi] }))).toEqual(sorted('A1', 'A2'));
    expect(idsOf(await meera.post(S, { text: tok, officerBadge: 'ksp-fo-1001' }))).toEqual(sorted('A1', 'A2'));
    expect((await meera.post(S, { text: tok, statuses: ['DISPOSED'] })).body.total).toBe(0);
    expect(idsOf(await meera.post(S, { text: tok, recordedFrom: new Date(T0.getTime() + 60_000).toISOString() }))).toEqual(sorted('A2'));
  });
});

describe('text relevance, snippets, pagination', () => {
  it('ranks title matches above description matches and highlights snippets', async () => {
    const r = await meera.post(S, { text: `arson ${tokX}` });
    expect(r.body.items.map((i: { id: string }) => i.id)).toEqual([ids.A4, ids.A5]);
    expect(r.body.sort).toBe('relevance');
    expect(r.body.items[0].matches.score).toBeGreaterThan(r.body.items[1].matches.score);
    const hits = r.body.items[1].matches.snippet.filter((s: { hit: boolean }) => s.hit).map((s: { text: string }) => s.text.toLowerCase());
    expect(hits).toContain('arson');
  });

  it('exclusions and phrases are honoured (fuzzy fallback must not re-include excluded items)', async () => {
    expect(idsOf(await meera.post(S, { text: `${tok} -traffic` }))).toEqual(sorted('A1'));
    expect(idsOf(await meera.post(S, { text: `"traffic stop" ${tok}` }))).toEqual(sorted('A2'));
    expect(idsOf(await meera.post(S, { text: `robbery or traffic ${tok}` }))).toEqual(sorted('A1', 'A2'));
  });

  it('trigram fallback on evidence number / filename', async () => {
    const app = await getApp();
    const n = (await app.db.selectFrom('evidence').select('evidence_number').where('id', '=', ids.A1!).executeTakeFirstOrThrow()).evidence_number!;
    expect(idsOf(await meera.post(S, { text: n.slice(4) }))).toContain(ids.A1);
    expect(idsOf(await meera.post(S, { evidenceNumber: n }))).toEqual(sorted('A1'));
  });

  it('paginates stably and sorts by recorded_at both ways', async () => {
    const p1 = await meera.post(S, { text: tok, pageSize: 1, page: 1, sort: 'recorded_at' });
    const p2 = await meera.post(S, { text: tok, pageSize: 1, page: 2, sort: 'recorded_at' });
    const p3 = await meera.post(S, { text: tok, pageSize: 1, page: 3, sort: 'recorded_at' });
    expect(p1.body.total).toBe(2);
    expect(p3.body.total).toBe(2);
    expect(p3.body.items).toEqual([]);
    expect([p1.body.items[0].id, p2.body.items[0].id]).toEqual([ids.A1, ids.A2]);
    const desc = await meera.post(S, { text: tok, sort: '-recorded_at', includeFacets: false });
    expect(desc.body.items.map((i: { id: string }) => i.id)).toEqual([ids.A2, ids.A1]);
    expect(desc.body.facets).toBeNull();
  });
});

describe('audit & saved searches', () => {
  it('SEARCH_PERFORMED records sanitised criteria + count, never results', async () => {
    const app = await getApp();
    await meera.post(S, { text: tok, ai: { labels: ['car'] } });
    const ev = await app.db.selectFrom('audit_events').select(['action', 'details', 'actor_id']).where('action', '=', 'SEARCH_PERFORMED').orderBy('seq', 'desc').limit(1).executeTakeFirstOrThrow();
    expect(ev.actor_id).toBe(await userId('io.meera'));
    const d = ev.details as { criteria: { text: string; ai: { labels: string[]; reviewStatus: string } }; resultCount: number };
    expect(d.criteria.text).toBe(tok);
    expect(d.criteria.ai).toEqual({ labels: ['car'], reviewStatus: 'APPROVED' });
    expect(d.resultCount).toBe(1);
    expect(JSON.stringify(d)).not.toContain(ids.A1);
  });

  it('saved searches are per user', async () => {
    const name = `Robberies ${tok}`;
    const c = await meera.post('/api/v1/search/saved', { name, criteria: { text: tok, ai: { labels: ['car'] } } });
    expect(c.status).toBe(201);
    expect(c.body.criteria).toMatchObject({ text: tok, ai: { labels: ['car'], reviewStatus: 'APPROVED' } });
    expect((await meera.post('/api/v1/search/saved', { name, criteria: {} })).status).toBe(409);
    expect((await meera.post('/api/v1/search/saved', { name: 'bad', criteria: { bogus: 1 } })).status).toBe(400);
    expect((await meera.get('/api/v1/search/saved')).body.items.map((s: { id: string }) => s.id)).toContain(c.body.id);
    expect((await arjun.get('/api/v1/search/saved')).body.items.map((s: { id: string }) => s.id)).not.toContain(c.body.id);
    expect((await arjun.delete(`/api/v1/search/saved/${c.body.id}`)).status).toBe(404);
    expect((await ravi.get('/api/v1/search/saved')).status).toBe(403);
    expect((await meera.delete(`/api/v1/search/saved/${c.body.id}`)).status).toBe(204);
    expect((await meera.delete(`/api/v1/search/saved/${c.body.id}`)).status).toBe(404);
  });
});

describe('related evidence suggestions', () => {
  it('suggests same officer / nearby+overlapping / shared approved plate — visible items only', async () => {
    const r = await meera.get(`/api/v1/search/evidence/${ids.A1}/related`);
    expect(r.status).toBe(200);
    const byId = Object.fromEntries(r.body.items.map((i: { id: string; reasons: Array<{ kind: string }> }) => [i.id, i.reasons.map((x) => x.kind)]));
    expect(byId[ids.A2!]).toContain('SAME_OFFICER');
    expect(byId[ids.A7!]).toContain('NEARBY');
    expect(byId[ids.A6!]).toContain('SHARED_PLATE');
    expect(byId[ids.B1!]).toBeUndefined(); // same plate, but other jurisdiction
    expect(byId[ids.A1!]).toBeUndefined();
  });

  it('401 / 403 / 404', async () => {
    const app = await getApp();
    expect((await app.inject({ method: 'GET', url: `/api/v1/search/evidence/${ids.A1}/related` })).statusCode).toBe(401);
    expect((await ravi.get(`/api/v1/search/evidence/${ids.A1}/related`)).status).toBe(403);
    expect((await meera.get(`/api/v1/search/evidence/${ids.B1}/related`)).status).toBe(404);
    expect((await meera.get(`/api/v1/search/evidence/${randomUUID()}/related`)).status).toBe(404);
  });
});

describe('performance on ≥5k synthetic rows', () => {
  let p: Principal;
  const ptok = token('perf');
  const ntok = token('n').toUpperCase();
  beforeAll(async () => {
    const app = await getApp();
    const org = await orgOf('ps_cubbonpark');
    const other = await orgOf('ps_indiranagar');
    const up = await userId('io.meera');
    await sql`INSERT INTO evidence (evidence_number, status, org_unit_id, org_path, uploaded_by, title, description, category, original_filename, size_bytes,
        storage_tier, recorded_at, recorded_end_at, duration_ms, gps_latitude, gps_longitude, media_status, registered_at, created_at)
      SELECT 'P5K-' || ${ntok} || '-' || g,
        'REGISTERED',
        CASE WHEN g % 2 = 0 THEN ${org.id}::uuid ELSE ${other.id}::uuid END,
        CASE WHEN g % 2 = 0 THEN ${org.path}::ltree ELSE ${other.path}::ltree END,
        ${up}::uuid,
        (ARRAY['Traffic stop','Robbery','Assault','Crowd control','Accident','Patrol'])[1 + g % 6] || ' ' || g || CASE WHEN g % 500 = 0 THEN ' ' || ${ptok} ELSE '' END,
        'Synthetic body-worn camera clip number ' || g,
        (ARRAY['traffic','crime','public-order'])[1 + g % 3],
        'BWC_' || g || '.mp4', 1000,
        (ARRAY['ACTIVE','ARCHIVE','LONG_TERM'])[1 + g % 3],
        now() - (g || ' minutes')::interval, now() - (g || ' minutes')::interval + interval '1 minute', 60000,
        12.80 + (g % 400) * 0.001, 77.45 + (g / 400) * 0.01, 'READY', now(), now()
      FROM generate_series(1, 6000) g`.execute(app.db);
    await asOwner((c) => c.query('ANALYZE evidence; ANALYZE ai_detections; ANALYZE evidence_tags;'));
    const meeraId = await userId('io.meera');
    p = (await loadUserPrincipal(app.db, meeraId, randomUUID(), true))!;
  });

  async function explain(q: ReturnType<typeof pageQuery>) {
    const app = await getApp();
    const compiled = q.compile(app.db);
    const res = await asOwner((c) => c.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${compiled.sql}`, compiled.parameters as unknown[]));
    const plan = (res.rows[0] as { 'QUERY PLAN': Array<{ Plan: unknown; 'Execution Time': number }> })['QUERY PLAN'][0]!;
    return { text: JSON.stringify(plan.Plan), ms: plan['Execution Time'] };
  }

  it('text, geo-radius and tier queries use indexes and run fast', async () => {
    const app = await getApp();
    const text = await explain(pageQuery(p, { text: ptok, tagMode: 'any' }, 'relevance', 1, 25));
    const geo = await explain(pageQuery(p, { location: { lat: 12.9, lon: 77.46, radiusKm: 2 }, tagMode: 'any' }, '-recorded_at', 1, 25));
    const tier = await explain(pageQuery(p, { storageTiers: ['LONG_TERM'], evidenceNumber: `P5K-${ntok}-12`, tagMode: 'any' }, '-created_at', 1, 25));
    // eslint-disable-next-line no-console
    console.log(`[search perf] rows=${(await sql<{ n: string }>`SELECT count(*) n FROM evidence`.execute(app.db)).rows[0]!.n} text=${text.ms.toFixed(2)}ms geo=${geo.ms.toFixed(2)}ms tier+number=${tier.ms.toFixed(2)}ms`);
    expect(text.text).toMatch(/evidence_search|evidence_title_trgm|evidence_number_trgm|evidence_filename_trgm/);
    expect(geo.text).toMatch(/evidence_geo/);
    expect(tier.text).toMatch(/evidence_number_trgm|evidence_storage_tier/);
    for (const x of [text, geo, tier]) expect(x.ms).toBeLessThan(300);
    // end-to-end API latency (incl. facets, hydration and audit)
    const t = performance.now();
    const r = await meera.post(S, { text: ptok });
    const apiMs = performance.now() - t;
    // eslint-disable-next-line no-console
    console.log(`[search perf] API text search with facets: ${apiMs.toFixed(1)}ms (server tookMs=${r.body.tookMs})`);
    expect(r.body.total).toBe(12); // g % 500 = 0 -> 12 rows, all even -> Cubbon Park
    expect(r.body.totalApprox).toBe(false);
    expect(apiMs).toBeLessThan(1000);
  });

  it('caps the exact total (FN-13): beyond the cap the count stops and says totalApprox', async () => {
    const app = await getApp();
    const c = { evidenceNumber: `P5K-${ntok}-`, tagMode: 'any' as const };
    const exact = await runSearch(app.db, p, c, { page: 1, pageSize: 25, includeFacets: true });
    expect(exact).toMatchObject({ total: 3000, totalApprox: false, facetsTruncated: false }); // Meera sees the even half
    const capped = await runSearch(app.db, p, c, { page: 1, pageSize: 25, includeFacets: true, totalCap: 1000 });
    expect(capped).toMatchObject({ total: 1000, totalApprox: true, facetsTruncated: true });
    expect(capped.items.map((i) => i.id)).toEqual(exact.items.map((i) => i.id)); // same page, only the count differs
    const atCap = await runSearch(app.db, p, c, { page: 1, pageSize: 25, includeFacets: false, totalCap: 3000 });
    expect(atCap).toMatchObject({ total: 3000, totalApprox: false }); // exactly cap matches is still exact
    // The count query never scans past cap + 1 rows.
    const compiled = countQuery(p, c, 1000).compile(app.db);
    const res = await asOwner((cl) => cl.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${compiled.sql}`, compiled.parameters as unknown[]));
    const plan = JSON.stringify((res.rows[0] as { 'QUERY PLAN': unknown[] })['QUERY PLAN']);
    expect(plan).toMatch(/"Node Type":"Limit"/);
    expect(Math.max(...[...plan.matchAll(/"Actual Rows":(\d+)/g)].map((m) => Number(m[1])))).toBeLessThanOrEqual(1001);
  });
});
