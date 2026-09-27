/**
 * Investigation workspace (module 11): roles, restricted items (no metadata leak), bookmarks/annotations with
 * custody audit, soft delete, timeline merge + overlap detection, relations, archive, 401/403/404.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { closeApp, getApp, login, type Agent } from './helpers.js';
import { evidenceTestSetup, evidenceTestTeardown, userId } from './evidence-setup.js';
import { insertEvidence, orgOf, token } from './search-support.js';
import { detectOverlaps } from '../src/modules/workspaces/timeline.js';

const W = '/api/v1/workspaces';
const T0 = new Date('2026-04-01T10:00:00Z');
const MIN = 60_000;
let meera: Agent, arjun: Agent, kavya: Agent, ravi: Agent, naveen: Agent;
const U: Record<string, string> = {};
const E: Record<string, string> = {};
let ws = '';
let caseId = '';

async function lastAuditFor(action: string, resourceId?: string) {
  const app = await getApp();
  let q = app.db.selectFrom('audit_events').select(['action', 'evidence_id', 'resource_id', 'details', 'actor_id', 'category']).where('action', '=', action);
  if (resourceId) q = q.where('resource_id', '=', resourceId);
  return q.orderBy('seq', 'desc').limit(1).executeTakeFirst();
}

beforeAll(async () => {
  const app = await evidenceTestSetup();
  for (const u of ['io.meera', 'io.arjun', 'sup.kavya', 'fo.ravi', 'fa.naveen']) U[u] = await userId(u);
  const tok = token();
  E.A1 = (await insertEvidence({ orgCode: 'ps_cubbonpark', uploadedBy: U['io.meera']!, title: `Front camera ${tok}`, recordedAt: T0, durationMs: 10 * MIN })).id;
  E.A2 = (await insertEvidence({ orgCode: 'ps_cubbonpark', uploadedBy: U['io.meera']!, title: `Side camera ${tok}`, recordedAt: new Date(T0.getTime() + 5 * MIN), durationMs: 10 * MIN })).id;
  E.A3 = (await insertEvidence({ orgCode: 'ps_cubbonpark', uploadedBy: U['io.meera']!, title: `Unrelated ${tok}`, recordedAt: new Date(T0.getTime() + 60 * MIN), durationMs: MIN })).id;
  E.B1 = (await insertEvidence({ orgCode: 'ps_indiranagar', uploadedBy: U['io.arjun']!, title: `Indiranagar secret ${tok}`, recordedAt: new Date(T0.getTime() + 2 * MIN), durationMs: 2 * MIN })).id;
  const org = await orgOf('ps_cubbonpark');
  caseId = (await app.db.insertInto('cases').values({ case_number: `WS-${tok}`.toUpperCase(), title: 'Workspace case', org_unit_id: org.id, org_path: org.path }).returning('id').executeTakeFirstOrThrow()).id;
  [meera, arjun, kavya, ravi, naveen] = await Promise.all(['io.meera', 'io.arjun', 'sup.kavya', 'fo.ravi', 'fa.naveen'].map((u) => login(u)));
});

afterAll(async () => {
  await evidenceTestTeardown();
  await closeApp();
});

describe('workspaces: CRUD, members, security', () => {
  it('401 / 403 on every entry point', async () => {
    const app = await getApp();
    const id = randomUUID();
    const eps: Array<[string, string]> = [
      ['GET', W], ['POST', W], ['GET', `${W}/${id}`], ['PATCH', `${W}/${id}`], ['GET', `${W}/${id}/items`], ['POST', `${W}/${id}/items`],
      ['PUT', `${W}/${id}/items/offsets`], ['PATCH', `${W}/${id}/items/${id}`], ['DELETE', `${W}/${id}/items/${id}`], ['POST', `${W}/${id}/members`],
      ['PATCH', `${W}/${id}/members/${id}`], ['DELETE', `${W}/${id}/members/${id}`], ['GET', `${W}/${id}/timeline`], ['POST', `${W}/${id}/timeline/events`],
      ['PATCH', `${W}/${id}/timeline/events/${id}`], ['DELETE', `${W}/${id}/timeline/events/${id}`], ['GET', `${W}/bookmarks?evidenceId=${id}`], ['POST', `${W}/bookmarks`],
      ['DELETE', `${W}/bookmarks/${id}`], ['GET', `${W}/annotations?evidenceId=${id}`], ['POST', `${W}/annotations`], ['PATCH', `${W}/annotations/${id}`],
      ['DELETE', `${W}/annotations/${id}`], ['GET', `${W}/relations?evidenceId=${id}`], ['POST', `${W}/relations`], ['DELETE', `${W}/relations/${id}`],
    ];
    for (const [method, url] of eps) {
      const unauth = await app.inject({ method: method as 'GET', url, payload: method === 'GET' ? undefined : {} });
      expect(unauth.statusCode, `${method} ${url} unauthenticated`).toBe(401);
      const r = await ravi.request(method as 'GET', url, method === 'GET' ? {} : { body: {} });
      expect(r.status, `${method} ${url} without workspace:use`).toBe(403);
    }
  });

  it('creates a workspace for a readable case; other jurisdiction cannot attach that case', async () => {
    const c = await meera.post(W, { title: 'Incident at MG Road', description: 'Reconstruction', caseId });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ title: 'Incident at MG Road', myRole: 'OWNER', status: 'ACTIVE', case: { id: caseId }, orgUnit: { name: 'Cubbon Park Police Station' } });
    ws = c.body.id;
    expect((await arjun.post(W, { title: 'x', caseId })).status).toBe(404);
    expect((await meera.post(W, { title: '' })).status).toBe(400);
    expect((await lastAuditFor('WORKSPACE_CREATED', ws))?.details).toMatchObject({ title: 'Incident at MG Road' });
  });

  it('non-members get 404; members are managed by the owner only', async () => {
    expect((await arjun.get(`${W}/${ws}`)).status).toBe(404);
    expect((await meera.get(`${W}/${randomUUID()}`)).status).toBe(404);
    expect((await meera.post(`${W}/${ws}/members`, { userId: U['io.arjun'], role: 'VIEWER' })).status).toBe(201);
    expect((await meera.post(`${W}/${ws}/members`, { userId: U['fa.naveen'], role: 'EDITOR' })).status).toBe(201);
    expect((await meera.post(`${W}/${ws}/members`, { userId: U['sup.kavya'], role: 'VIEWER' })).status).toBe(201);
    expect((await meera.post(`${W}/${ws}/members`, { userId: U['io.arjun'], role: 'VIEWER' })).status).toBe(409);
    expect((await meera.post(`${W}/${ws}/members`, { userId: U['fo.ravi'], role: 'VIEWER' })).status).toBe(422); // no workspace:use
    expect((await naveen.post(`${W}/${ws}/members`, { userId: U['fo.ravi'], role: 'VIEWER' })).status).toBe(403);
    expect((await meera.delete(`${W}/${ws}/members/${U['io.meera']}`)).status).toBe(409); // owner
    const d = await arjun.get(`${W}/${ws}`);
    expect(d.status).toBe(200);
    expect(d.body.myRole).toBe('VIEWER');
    expect(d.body.case).toBeNull(); // arjun cannot read the Cubbon Park case
    expect(d.body.caseRestricted).toBe(true);
    const list = await arjun.get(`${W}?scope=shared`);
    expect(list.body.items.map((w: { id: string }) => w.id)).toContain(ws);
    expect((await arjun.get(`${W}?scope=mine`)).body.items.map((w: { id: string }) => w.id)).not.toContain(ws);
  });
});

describe('workspace items never grant evidence access', () => {
  it('editors add only evidence they can read; viewers cannot add', async () => {
    const add = await meera.post(`${W}/${ws}/items`, { evidenceIds: [E.A1, E.A2] });
    expect(add.status).toBe(201);
    expect(add.body.added).toHaveLength(2);
    expect((await meera.post(`${W}/${ws}/items`, { evidenceIds: [E.B1] })).status).toBe(404);
    expect((await arjun.post(`${W}/${ws}/items`, { evidenceIds: [E.B1] })).status).toBe(403);
    expect((await naveen.post(`${W}/${ws}/items`, { evidenceIds: [E.B1] })).status).toBe(201); // analyst at city level sees B1
    const a = await lastAuditFor('WORKSPACE_EVIDENCE_ADDED', ws);
    expect(a).toMatchObject({ evidence_id: E.B1, category: 'INVESTIGATION' });
  });

  it('members without evidence access see restricted stubs with no metadata', async () => {
    const m = await meera.get(`${W}/${ws}/items`);
    expect(m.body.items).toHaveLength(3);
    const restricted = m.body.items.filter((i: { restricted: boolean }) => i.restricted);
    expect(restricted).toHaveLength(1);
    expect(Object.keys(restricted[0]).sort()).toEqual(['addedAt', 'id', 'restricted', 'sortOrder']);
    expect(JSON.stringify(m.body)).not.toContain(E.B1);
    expect(JSON.stringify(m.body)).not.toContain('Indiranagar secret');
    const a = await arjun.get(`${W}/${ws}/items`);
    const vis = a.body.items.filter((i: { restricted: boolean }) => !i.restricted);
    expect(vis.map((i: { evidenceId: string }) => i.evidenceId)).toEqual([E.B1]);
    expect(JSON.stringify(a.body)).not.toContain('Front camera');
    const n = await naveen.get(`${W}/${ws}/items`);
    expect(n.body.items.every((i: { restricted: boolean }) => !i.restricted)).toBe(true);
    expect(n.body.items[0].evidence).toMatchObject({ evidenceNumber: expect.any(String), recordedEndAt: expect.any(String), frameRate: 25 });
  });

  it('persists sync offsets (bulk + single) and audits them; restricted items cannot be touched', async () => {
    const items = (await meera.get(`${W}/${ws}/items`)).body.items as Array<{ id: string; evidenceId?: string; restricted: boolean }>;
    const i1 = items.find((i) => i.evidenceId === E.A1)!;
    const i2 = items.find((i) => i.evidenceId === E.A2)!;
    const hidden = items.find((i) => i.restricted)!;
    const r = await meera.put(`${W}/${ws}/items/offsets`, { items: [{ itemId: i1.id, syncOffsetMs: 0 }, { itemId: i2.id, syncOffsetMs: 300_000 }] });
    expect(r.status).toBe(200);
    expect(r.body.items.find((i: { id: string }) => i.id === i2.id).syncOffsetMs).toBe(300_000);
    expect((await lastAuditFor('WORKSPACE_ITEM_UPDATED', ws))).toMatchObject({ evidence_id: E.A2 });
    const p = await meera.patch(`${W}/${ws}/items/${i1.id}`, { notes: 'Front view', sortOrder: 5 });
    expect(p.status).toBe(200);
    expect((await meera.patch(`${W}/${ws}/items/${hidden.id}`, { notes: 'x' })).status).toBe(404);
    expect((await meera.put(`${W}/${ws}/items/offsets`, { items: [{ itemId: hidden.id, syncOffsetMs: 1 }] })).status).toBe(404);
    expect((await arjun.patch(`${W}/${ws}/items/${i1.id}`, { notes: 'x' })).status).toBe(403);
  });
});

describe('bookmarks & annotations', () => {
  let personal = '';
  let shared = '';
  it('create with custody audit; visibility personal vs workspace', async () => {
    const b1 = await meera.post(`${W}/bookmarks`, { evidenceId: E.A1, timeMs: 1000, label: 'Personal note' });
    expect(b1.status).toBe(201);
    personal = b1.body.id;
    const b2 = await meera.post(`${W}/bookmarks`, { evidenceId: E.A1, workspaceId: ws, timeMs: 120_000, label: 'Suspect enters' });
    expect(b2.status).toBe(201);
    shared = b2.body.id;
    const a = await lastAuditFor('BOOKMARK_CREATED', shared);
    expect(a).toMatchObject({ evidence_id: E.A1, actor_id: U['io.meera'] });
    expect((await meera.post(`${W}/bookmarks`, { evidenceId: E.A1, timeMs: 99 * MIN, label: 'beyond end' })).status).toBe(400);
    expect((await meera.post(`${W}/bookmarks`, { evidenceId: E.A3, workspaceId: ws, timeMs: 0, label: 'not an item' })).status).toBe(422);
    expect((await kavya.post(`${W}/bookmarks`, { evidenceId: E.A1, workspaceId: ws, timeMs: 0, label: 'viewer' })).status).toBe(403);
    expect((await arjun.post(`${W}/bookmarks`, { evidenceId: E.A1, timeMs: 0, label: 'no access' })).status).toBe(404);
    expect((await arjun.get(`${W}/bookmarks?evidenceId=${E.A1}`)).status).toBe(404);
    const n = await naveen.get(`${W}/bookmarks?evidenceId=${E.A1}`);
    expect(n.body.items.map((b: { id: string }) => b.id)).toEqual([shared]);
    const m = await meera.get(`${W}/bookmarks?evidenceId=${E.A1}`);
    expect(m.body.items.map((b: { id: string }) => b.id)).toEqual([personal, shared]);
    expect(m.body.items[1]).toMatchObject({ workspaceTitle: 'Incident at MG Road', timeMs: 120_000, canDelete: true });
  });

  it('bookmark deletion: creator or workspace owner; audited', async () => {
    expect((await naveen.delete(`${W}/bookmarks/${shared}`)).status).toBe(403);
    expect((await naveen.delete(`${W}/bookmarks/${personal}`)).status).toBe(404);
    const nb = await naveen.post(`${W}/bookmarks`, { evidenceId: E.A2, workspaceId: ws, timeMs: 1000, label: 'Analyst bookmark' });
    expect((await meera.delete(`${W}/bookmarks/${nb.body.id}`)).status).toBe(204); // owner may remove
    expect((await lastAuditFor('BOOKMARK_DELETED', nb.body.id))).toMatchObject({ evidence_id: E.A2, actor_id: U['io.meera'] });
    expect((await meera.delete(`${W}/bookmarks/${personal}`)).status).toBe(204);
    expect((await meera.delete(`${W}/bookmarks/${personal}`)).status).toBe(404);
  });

  let region = '';
  it('annotations: validation, edit by author only, custody audit', async () => {
    expect((await meera.post(`${W}/annotations`, { evidenceId: E.A1, workspaceId: ws, kind: 'REGION', startMs: 1000 })).status).toBe(400);
    expect((await meera.post(`${W}/annotations`, { evidenceId: E.A1, workspaceId: ws, kind: 'REGION', startMs: 1000, region: { x: 0.8, y: 0.1, w: 0.5, h: 0.2 } })).status).toBe(400);
    expect((await meera.post(`${W}/annotations`, { evidenceId: E.A1, kind: 'NOTE', startMs: 0 })).status).toBe(400);
    expect((await meera.post(`${W}/annotations`, { evidenceId: E.A1, kind: 'HIGHLIGHT', startMs: 5000, endMs: 1000 })).status).toBe(400);
    const r = await meera.post(`${W}/annotations`, { evidenceId: E.A1, workspaceId: ws, kind: 'REGION', startMs: 180_000, endMs: 185_000, body: 'Knife in hand', region: { x: 0.1, y: 0.2, w: 0.3, h: 0.25 }, color: '#ff0000' });
    expect(r.status).toBe(201);
    region = r.body.id;
    expect(r.body).toMatchObject({ kind: 'REGION', region: { x: 0.1, y: 0.2, w: 0.3, h: 0.25 }, canEdit: true, deleted: false });
    expect((await lastAuditFor('ANNOTATION_CREATED', region))).toMatchObject({ evidence_id: E.A1 });
    const note = await meera.post(`${W}/annotations`, { evidenceId: E.A1, kind: 'NOTE', startMs: 2000, body: 'Shared note on the evidence' });
    expect(note.status).toBe(201);
    // shared (workspace-less) annotations are visible to anyone who can read the evidence
    expect((await kavya.get(`${W}/annotations?evidenceId=${E.A1}`)).body.items.map((a: { id: string }) => a.id)).toEqual(expect.arrayContaining([note.body.id, region]));
    expect((await naveen.patch(`${W}/annotations/${region}`, { body: 'hijack' })).status).toBe(403);
    const e = await meera.patch(`${W}/annotations/${region}`, { body: 'Knife in right hand', region: { x: 0.12, y: 0.2, w: 0.3, h: 0.25 } });
    expect(e.status).toBe(200);
    expect(e.body.body).toBe('Knife in right hand');
    const up = await lastAuditFor('ANNOTATION_UPDATED', region);
    expect(up).toMatchObject({ evidence_id: E.A1 });
    expect((up!.details as { changes: { body: { before: string } } }).changes.body.before).toBe('Knife in hand');
    expect((await arjun.get(`${W}/annotations?evidenceId=${E.A1}`)).status).toBe(404);
  });

  it('soft delete keeps the row (deleted_by) and the DB refuses physical deletes', async () => {
    const tmp = await meera.post(`${W}/annotations`, { evidenceId: E.A2, workspaceId: ws, kind: 'HIGHLIGHT', startMs: 0, endMs: 1000 });
    expect((await meera.delete(`${W}/annotations/${tmp.body.id}`, { reason: 'duplicate' })).status).toBe(204);
    expect((await lastAuditFor('ANNOTATION_DELETED', tmp.body.id))).toMatchObject({ evidence_id: E.A2 });
    const app = await getApp();
    const row = await app.db.selectFrom('annotations').select(['deleted_at', 'deleted_by']).where('id', '=', tmp.body.id).executeTakeFirstOrThrow();
    expect(row.deleted_by).toBe(U['io.meera']);
    expect(row.deleted_at).toBeInstanceOf(Date);
    const list = await meera.get(`${W}/annotations?evidenceId=${E.A2}`);
    expect(list.body.items.map((a: { id: string }) => a.id)).not.toContain(tmp.body.id);
    const withDel = await meera.get(`${W}/annotations?evidenceId=${E.A2}&includeDeleted=true`);
    expect(withDel.body.items.find((a: { id: string }) => a.id === tmp.body.id)).toMatchObject({ deleted: true, deletedBy: expect.any(String), canEdit: false });
    expect((await meera.patch(`${W}/annotations/${tmp.body.id}`, { body: 'x' })).status).toBe(409);
    await expect(sql`DELETE FROM annotations WHERE id = ${tmp.body.id}::uuid`.execute(app.db)).rejects.toThrow(/permission denied/);
  });
});

describe('timeline reconstruction', () => {
  it('detectOverlaps (pure)', () => {
    const o = detectOverlaps([
      { evidenceId: 'a', startMs: 0, endMs: 100 },
      { evidenceId: 'b', startMs: 50, endMs: 150 },
      { evidenceId: 'c', startMs: 150, endMs: 200 },
      { evidenceId: 'd', startMs: 10, endMs: 20 },
    ]);
    expect(o.map((x) => [x.a, x.b, x.durationMs, x.aTimeMs, x.bTimeMs])).toEqual([['a', 'd', 10, 10, 0], ['a', 'b', 50, 50, 0]]);
  });

  it('merges recordings, events, bookmarks, annotations in wall-clock order with overlaps', async () => {
    const ev = await meera.post(`${W}/${ws}/timeline/events`, { title: 'Call received', occurredAt: new Date(T0.getTime() - MIN).toISOString() });
    expect(ev.status).toBe(201);
    const ev2 = await meera.post(`${W}/${ws}/timeline/events`, { title: 'Suspect flees', occurredAt: new Date(T0.getTime() + 7 * MIN).toISOString(), evidenceId: E.A1, timeMs: 7 * MIN });
    expect(ev2.status).toBe(201);
    expect((await lastAuditFor('TIMELINE_EVENT_CHANGED', ev2.body.id))).toMatchObject({ evidence_id: E.A1 });
    expect((await meera.post(`${W}/${ws}/timeline/events`, { title: 'x', occurredAt: T0.toISOString(), evidenceId: E.A3 })).status).toBe(422);
    expect((await kavya.post(`${W}/${ws}/timeline/events`, { title: 'x', occurredAt: T0.toISOString() })).status).toBe(403);

    const t = await meera.get(`${W}/${ws}/timeline`);
    expect(t.status).toBe(200);
    expect(t.body.lanes.map((l: { evidenceId: string }) => l.evidenceId).sort()).toEqual([E.A1, E.A2].sort());
    const lane2 = t.body.lanes.find((l: { evidenceId: string }) => l.evidenceId === E.A2);
    expect(lane2.suggestedOffsetMs).toBe(5 * MIN);
    expect(t.body.overlaps).toEqual([{ a: E.A1, b: E.A2, start: new Date(T0.getTime() + 5 * MIN).toISOString(), end: new Date(T0.getTime() + 10 * MIN).toISOString(), durationMs: 5 * MIN, aTimeMs: 5 * MIN, bTimeMs: 0 }]);
    const kinds = t.body.entries.map((e: { kind: string; at: string }) => `${e.kind}@${e.at}`);
    expect(kinds).toEqual([
      `EVENT@${new Date(T0.getTime() - MIN).toISOString()}`,
      `RECORDING@${T0.toISOString()}`,
      `BOOKMARK@${new Date(T0.getTime() + 120_000).toISOString()}`,
      `ANNOTATION@${new Date(T0.getTime() + 180_000).toISOString()}`,
      `RECORDING@${new Date(T0.getTime() + 5 * MIN).toISOString()}`,
      `EVENT@${new Date(T0.getTime() + 7 * MIN).toISOString()}`,
    ]);
    const sorted = [...t.body.entries].map((e: { at: string }) => e.at);
    expect(sorted).toEqual([...sorted].sort());
    expect(JSON.stringify(t.body)).not.toContain(E.B1);
    // an analyst who sees everything gets the Indiranagar lane and its overlaps too
    const n = await naveen.get(`${W}/${ws}/timeline`);
    expect(n.body.lanes).toHaveLength(3);
    expect(n.body.overlaps.some((o: { a: string; b: string }) => [o.a, o.b].includes(E.B1!))).toBe(true);
    // a member without access to A1 sees the event but not the evidence link
    const a = await arjun.get(`${W}/${ws}/timeline`);
    expect(a.body.lanes.map((l: { evidenceId: string }) => l.evidenceId)).toEqual([E.B1]);
    const flee = a.body.entries.find((e: { kind: string; title?: string }) => e.title === 'Suspect flees');
    expect(flee).toMatchObject({ restricted: true, evidenceId: null, timeMs: null });
    expect(JSON.stringify(a.body)).not.toContain(E.A1);

    const p = await meera.patch(`${W}/${ws}/timeline/events/${ev.body.id}`, { title: 'Control room call' });
    expect(p.status).toBe(200);
    expect((await meera.delete(`${W}/${ws}/timeline/events/${ev.body.id}`)).status).toBe(204);
    expect((await meera.delete(`${W}/${ws}/timeline/events/${ev.body.id}`)).status).toBe(404);
    // FN-12: soft-deleted (row kept with deleted_at/by), gone from the timeline, not editable
    const app = await getApp();
    const row = await app.db.selectFrom('timeline_events').selectAll().where('id', '=', ev.body.id).executeTakeFirstOrThrow();
    expect(row.title).toBe('Control room call');
    expect(row.deleted_at).toBeInstanceOf(Date);
    expect(row.deleted_by).toBe(await userId('io.meera'));
    expect((await meera.get(`${W}/${ws}/timeline`)).body.entries.some((e: { id?: string }) => e.id === ev.body.id)).toBe(false);
    expect((await meera.patch(`${W}/${ws}/timeline/events/${ev.body.id}`, { title: 'resurrect' })).status).toBe(404);
    await expect(app.db.deleteFrom('timeline_events').where('id', '=', ev.body.id).execute()).rejects.toThrow(/permission denied/);
  });
});

describe('relations & archive', () => {
  it('relations between visible items, custody-audited on both; hidden for users missing either side', async () => {
    const r = await meera.post(`${W}/relations`, { evidenceA: E.A2, evidenceB: E.A1, relation: 'DIFFERENT_ANGLE', note: 'Same scene' });
    expect(r.status).toBe(201);
    expect((await meera.post(`${W}/relations`, { evidenceA: E.A1, evidenceB: E.A2, relation: 'DIFFERENT_ANGLE' })).status).toBe(409);
    expect((await meera.post(`${W}/relations`, { evidenceA: E.A1, evidenceB: E.A1, relation: 'RELATED' })).status).toBe(400);
    expect((await meera.post(`${W}/relations`, { evidenceA: E.A1, evidenceB: E.B1, relation: 'RELATED' })).status).toBe(404);
    const app = await getApp();
    const audits = await app.db.selectFrom('audit_events').select('evidence_id').where('action', '=', 'EVIDENCE_RELATION_CHANGED').where('resource_id', '=', r.body.id).execute();
    expect(audits.map((a) => a.evidence_id).sort()).toEqual([E.A1, E.A2].sort());
    const nr = await naveen.post(`${W}/relations`, { evidenceA: E.A1, evidenceB: E.B1, relation: 'SAME_INCIDENT' });
    expect(nr.status).toBe(201);
    const m = await meera.get(`${W}/relations?evidenceId=${E.A1}`);
    expect(m.body.items.map((x: { id: string }) => x.id)).toEqual([r.body.id]);
    expect((await arjun.get(`${W}/relations?evidenceId=${E.A1}`)).status).toBe(404);
    expect((await meera.delete(`${W}/relations/${nr.body.id}`)).status).toBe(404);
    const rel = await meera.get(`/api/v1/search/evidence/${E.A1}/related`);
    expect(rel.body.items.find((i: { id: string }) => i.id === E.A2).reasons.map((x: { kind: string }) => x.kind)).toContain('RELATION');
    expect((await meera.delete(`${W}/relations/${r.body.id}`)).status).toBe(204);
  });

  it('archived workspaces are read-only until the owner re-activates them', async () => {
    expect((await naveen.patch(`${W}/${ws}`, { status: 'ARCHIVED' })).status).toBe(403);
    expect((await meera.patch(`${W}/${ws}`, { status: 'ARCHIVED' })).status).toBe(200);
    expect((await naveen.post(`${W}/${ws}/items`, { evidenceIds: [E.A3] })).status).toBe(409);
    expect((await meera.get(`${W}/${ws}/timeline`)).status).toBe(200);
    expect((await meera.get(W)).body.items.map((w: { id: string }) => w.id)).not.toContain(ws);
    expect((await meera.get(`${W}?status=ARCHIVED`)).body.items.map((w: { id: string }) => w.id)).toContain(ws);
    expect((await meera.patch(`${W}/${ws}`, { status: 'ACTIVE' })).status).toBe(200);
    expect((await naveen.patch(`${W}/${ws}`, { title: 'Renamed by editor' })).status).toBe(200);
  });

  it('members can leave; removed members lose access (404)', async () => {
    expect((await arjun.delete(`${W}/${ws}/members/${U['io.arjun']}`)).status).toBe(204);
    expect((await arjun.get(`${W}/${ws}`)).status).toBe(404);
    expect((await meera.patch(`${W}/${ws}/members/${U['fa.naveen']}`, { role: 'VIEWER' })).status).toBe(200);
    expect((await naveen.post(`${W}/${ws}/items`, { evidenceIds: [E.A3] })).status).toBe(403);
    const items = (await meera.get(`${W}/${ws}/items`)).body.items as Array<{ id: string; evidenceId?: string }>;
    const i2 = items.find((i) => i.evidenceId === E.A2)!;
    expect((await meera.delete(`${W}/${ws}/items/${i2.id}`)).status).toBe(204);
    expect((await lastAuditFor('WORKSPACE_EVIDENCE_REMOVED', ws))).toMatchObject({ evidence_id: E.A2 });
  });
});
