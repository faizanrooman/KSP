/**
 * Data-driven IDOR / object-level authorization matrix (security round 2).
 *
 * One resource of every kind is created in ps_cubbonpark (security-support.ts buildWorld). Then EVERY registered
 * route that takes an id parameter is called by three probers who must not reach those objects:
 *   io.arjun   — IO at ps_indiranagar (same role, other station)
 *   fo.ravi    — field officer at ps_cubbonpark (same station, read_own only)
 *   east.sup   — a supervisor-equivalent at ps_indiranagar holding almost every permission
 * Bodies are generated from each route's OpenAPI schema so requests pass validation and reach authorization.
 *
 * Oracle (no existence leak): the response to the REAL foreign id must be identical (status + error code) to the
 * response for a random, non-existent id — and never 2xx, and never contain the owner's data (MARK). The owner
 * (or the natural owner) must get 2xx on every GET, which proves the id wiring is real and the matrix is not
 * comparing two meaningless 404s. Documented, reviewed exceptions are listed in EXCEPTIONS.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { closeApp, login, type Agent, type Res } from './helpers.js';
import { evidenceTestSetup, evidenceTestTeardown } from './evidence-setup.js';
import { MARK, bodySchema, buildWorld, eastSupervisor, genValue, type World } from './security-support.js';

let app: FastifyInstance;
let world: World;
let probers: Record<string, Agent>;

/** Resource id for each route parameter, chosen by route prefix. `null` = route not in scope of this matrix. */
function paramValue(url: string, param: string, ids: Record<string, string>): string | null {
  const p = (prefix: string) => url.startsWith(`/api/v1/${prefix}`);
  if (param === '*') return ids.hlsRel!;
  if (param === 'evidenceId' || (param === 'id' && (p('evidence/') || p('media/evidence') || p('ai/evidence') || p('custody/evidence') || p('search/evidence')))) {
    if (url.includes('/quarantine/')) return ids.evidence!;
    return ids.evidence!;
  }
  if (param === 'requestId') return url.includes('/quarantine/releases/') ? ids.quarantineRelease! : ids.disposal!;
  if (param === 'derivativeId') return ids.snapshot!;
  if (param === 'detectionId') return ids.detection!;
  if (param === 'tag') return 'idor';
  if (param === 'noteId') return ids.note!;
  if (param === 'itemId') return ids.wsItem!;
  if (param === 'eventId') return ids.wsEvent!;
  if (param === 'sessionId') return ids.session!;
  if (param === 'assignmentId') return ids.roleAssignment!;
  if (param === 'userId') return ids.meera!;
  if (param === 'seq') return ids.auditSeq!;
  if (param === 'n') return '1';
  if (param !== 'id') return null;
  const map: Array<[string, string]> = [
    ['ai/jobs', 'aiJob'], ['review/detections', 'detection'], ['alerts/', 'alert'], ['notifications/', 'notification'],
    ['auth/sessions', 'session'], ['cases/', 'case'], ['devices/', 'device'], ['exports/', 'export'], ['firs/', 'fir'],
    ['reports/runs', 'reportRun'], ['reports/schedules', 'reportSchedule'], ['media/snapshot-requests', 'snapshotRequest'], ['search/saved', 'savedSearch'], ['shares/', 'share'], ['uploads/batches', 'batch'],
    ['uploads/', 'upload'], ['users/', 'meera'], ['workspaces/bookmarks', 'bookmark'], ['workspaces/annotations', 'annotation'],
    ['workspaces/relations', 'relation'], ['workspaces/', 'workspace'],
  ];
  const hit = map.find(([pre]) => p(pre));
  return hit ? ids[hit[1]]! : null;
}

/**
 * Reviewed cases where the real id legitimately answers differently from a random id for a prober.
 * key: `<prober> <METHOD> <route>`; value: justification (goes into the security report).
 */
const EXCEPTIONS: Record<string, string> = {
  // fo.ravi is in the SAME station and holds devices:read there: the station's devices are legitimately visible;
  // managing them needs devices:manage (403 on a visible object is the documented contract for non-evidence resources).
  'fo.ravi GET /api/v1/devices/:id': 'same-station device, devices:read granted at ps_cubbonpark',
  'fo.ravi PATCH /api/v1/devices/:id': 'visible (same station) but devices:manage missing -> 403',
  'fo.ravi POST /api/v1/devices/:id/assign': 'visible (same station) but devices:manage missing -> 403',
  'fo.ravi POST /api/v1/devices/:id/unassign': 'visible (same station) but devices:manage missing -> 403',
  'fo.ravi POST /api/v1/devices/:id/retire': 'visible (same station) but devices:manage missing -> 403',
};

/** Ids placed in bodies (evidenceIds, caseId, ...) — always the owner's objects, so bodies are foreign too. */
const bodyIdFor = (ids: Record<string, string>) => (key: string): string | undefined => {
  const k = key.toLowerCase();
  if (k.startsWith('evidence')) return ids.evidence;
  if (k === 'caseid') return ids.case;
  if (k === 'workspaceid') return ids.workspace;
  if (k === 'firid') return ids.fir;
  if (k === 'userid' || k === 'recipientuserid' || k === 'officerid') return ids.kavya;
  if (k === 'orgunitid') return ids.cubbon;
  if (k === 'batchid') return ids.batch;
  return undefined;
};

/** Fixed bodies where the generic generator cannot produce a valid one. */
function bodyFor(method: string, url: string, ids: Record<string, string>): unknown {
  const key = `${method} ${url}`;
  const fixed: Record<string, unknown> = {
    'PUT /api/v1/workspaces/:id/items/offsets': { items: [{ itemId: ids.wsItem, syncOffsetMs: 10 }] },
    'POST /api/v1/review/detections/:id': { action: 'APPROVE' },
    'POST /api/v1/cases/:id/status': { status: 'CLOSED', reason: 'Security probe closing reason' },
    'POST /api/v1/firs/:id/status': { status: 'CLOSED', reason: 'Security probe closing reason' },
    'POST /api/v1/evidence/:id/tier': { targetTier: 'ARCHIVE' },
  };
  if (key in fixed) return fixed[key];
  const s = bodySchema(app, method, url);
  if (!s) return method === 'GET' ? undefined : {};
  return genValue(s as never, '', bodyIdFor(ids));
}

interface Probe { method: string; route: string; url: string; randomUrl: string; body: unknown }
let probes: Probe[];

beforeAll(async () => {
  app = await evidenceTestSetup();
  await app.ready();
  world = await buildWorld(app);
  probers = { 'io.arjun': await login('io.arjun'), 'fo.ravi': await login('fo.ravi'), 'east.sup': await eastSupervisor() };
  const routes = app.routeRegistry.filter((r) => r.url.startsWith('/api/v1') && /[:*]/.test(r.url) && !['HEAD', 'OPTIONS'].includes(r.method));
  probes = [];
  for (const r of routes) {
    // Integration API routes only accept API-client credentials (covered in integration-api tests); settings/alert
    // rules/roles/org/models/etc. are keyed by codes or admin-only ids handled in module tests.
    const params = [...r.url.matchAll(/:([A-Za-z0-9_]+)|(\*)$/g)].map((m) => m[1] ?? '*');
    const values = params.map((pn) => paramValue(r.url, pn, world.ids));
    if (values.some((v) => v === null)) continue;
    let i = 0;
    const url = r.url.replace(/:([A-Za-z0-9_]+)|\*$/g, () => encodeURI(values[i++]!));
    const randomUrl = r.url.replace(/:([A-Za-z0-9_]+)|\*$/g, (_m, pn: string | undefined) => (pn === 'tag' ? 'idor' : pn === 'n' ? '1' : pn === 'seq' ? '999999999' : pn === undefined ? world.ids.hlsRel! : randomUUID()));
    // Public token routes: a syntactically valid but forged token (the prober's own tokens are tested in security-media).
    const q = r.public && r.method === 'GET' && !r.url.includes('share-portal') ? `?t=${'A'.repeat(40)}` : '';
    probes.push({ method: r.method, route: r.url, url: url + q, randomUrl: randomUrl + q, body: bodyFor(r.method, r.url, world.ids) });
  }
  // Order: reads first, destructive verbs last (nothing should succeed, but keep the fixture intact if one does).
  const rank = (m: string) => ({ GET: 0, PUT: 1, PATCH: 1, POST: 2, DELETE: 3 })[m] ?? 4;
  probes.sort((a, b) => rank(a.method) - rank(b.method));
}, 600_000);

afterAll(async () => {
  await evidenceTestTeardown();
  await closeApp();
});

const send = (a: Agent, method: string, url: string, body: unknown): Promise<Res> =>
  a.request(method as 'GET', url, method === 'GET' || body === undefined ? {} : { body });

describe('IDOR matrix', () => {
  it('covers every id-parameter route family', () => {
    console.log(`IDOR matrix: ${probes.length} routes x ${Object.keys(probers).length} probers`);
    expect(probes.length).toBeGreaterThan(90);
  });

  it('the owner can read every GET object (fixture ids are real)', async () => {
    const owners: Record<string, Agent> = { reports: world.kavya, notifications: world.kavya, 'evidence/disposal': world.latha, 'media/evidence/:id/original': world.kavya };
    const skip = new Set([
      '/api/v1/media/stream/:evidenceId/*', '/api/v1/media/image/:derivativeId', '/api/v1/media/download/:evidenceId', '/api/v1/ai/crops/:detectionId',
      '/api/v1/exports/:id/package', '/api/v1/reports/runs/:id/download', '/api/v1/media/evidence/:id/original', // token routes / needs download_original (401 without ?t=)
      '/api/v1/exports/:id/download', // export not built in this fixture (409)
    ]);
    const failures: string[] = [];
    for (const pr of probes.filter((x) => x.method === 'GET' && !skip.has(x.route) && !x.route.includes('share-portal') && !x.route.includes('/audit/') && !x.route.includes('/users/') && !x.route.includes('/devices/'))) {
      const ownerKey = Object.keys(owners).find((k) => pr.route.startsWith(`/api/v1/${k}`));
      const r = await send(ownerKey ? owners[ownerKey]! : world.owner, 'GET', pr.url, undefined);
      if (r.status >= 300) failures.push(`${pr.route} -> ${r.status} ${r.raw.slice(0, 120)}`);
    }
    expect(failures).toEqual([]);
  });

  for (const who of ['io.arjun', 'fo.ravi', 'east.sup']) {
    it(`${who}: foreign ids answer exactly like non-existent ids, never 2xx, never leak data`, async () => {
      const failures: string[] = [];
      const table: string[] = [];
      for (const pr of probes) {
        const a = probers[who]!;
        const real = await send(a, pr.method, pr.url, pr.body);
        const fake = await send(a, pr.method, pr.randomUrl, pr.body);
        const key = `${who} ${pr.method} ${pr.route}`;
        const code = (r: Res) => `${r.status}:${(r.body as { error?: { code?: string } } | undefined)?.error?.code ?? ''}`;
        table.push(`${key} real=${code(real)} random=${code(fake)}`);
        if (EXCEPTIONS[key]) continue;
        if (real.status >= 200 && real.status < 300) failures.push(`${key} -> ${real.status} (2xx!) ${real.raw.slice(0, 160)}`);
        else if (real.raw.includes(MARK)) failures.push(`${key} -> body leaks owner data`);
        else if (real.status === 400 && (real.body as { error?: { code?: string } })?.error?.code === 'VALIDATION_FAILED') failures.push(`${key} -> 400 VALIDATION_FAILED (probe body invalid: ${JSON.stringify(real.body?.error?.details)?.slice(0, 200)})`);
        else if (code(real) !== code(fake) && !EXCEPTIONS[key]) failures.push(`${key} -> real ${code(real)} vs random ${code(fake)} (existence leak?)`);
      }
      console.log(`IDOR ${who}:\n${table.join('\n')}`);
      expect(failures).toEqual([]);
    }, 300_000);
  }
});
