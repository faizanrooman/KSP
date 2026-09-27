/**
 * Shared fixtures for the round-2 security suites (IDOR matrix, mass assignment): one resource of every kind
 * owned by io.meera (@ps_cubbonpark) — or by the natural owner where io.meera lacks the permission — plus a
 * JSON-schema-driven body generator that produces VALID request bodies from the OpenAPI document, so probes
 * get past validation and actually reach the authorization code.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { dispatchPendingAlerts, raiseAlert } from '@ksp/core';
import { login, type Agent } from './helpers.js';
import { userId } from './evidence-setup.js';
import { processedEvidence, userWithPerms } from './custody-support.js';
import { createRegisteredEvidence } from './fixtures/evidence.js';
import { insertDetections } from './search-support.js';
import { smallVideo, sha256File, initUpload } from './uploads-support.js';

/** A marker embedded in every text field of the owner's resources; must never appear in a prober's response. */
export const MARK = `IDORMARK${randomUUID().slice(0, 8)}`;

export interface World {
  ids: Record<string, string>;
  owner: Agent; // io.meera
  kavya: Agent; // sup.kavya (blr_central) — owner of approvals/report runs/notifications
  latha: Agent; // ec.latha — disposal requester
}

const must = <T extends { status: number; raw: string }>(what: string, r: T, ok = [200, 201, 202]): T => {
  if (!ok.includes(r.status)) throw new Error(`${what} failed: ${r.status} ${r.raw.slice(0, 300)}`);
  return r;
};

export async function orgIdOf(app: FastifyInstance, code: string): Promise<string> {
  return (await app.db.selectFrom('org_units').select('id').where('code', '=', code).executeTakeFirstOrThrow()).id;
}

/** Build one resource of each kind in ps_cubbonpark. */
export async function buildWorld(app: FastifyInstance): Promise<World> {
  const [owner, kavya, latha] = await Promise.all(['io.meera', 'sup.kavya', 'ec.latha'].map((u) => login(u)));
  const meeraId = await userId('io.meera');
  const cubbon = await orgIdOf(app, 'ps_cubbonpark');
  const ids: Record<string, string> = { meera: meeraId, kavya: await userId('sup.kavya'), cubbon };

  const ev = await processedEvidence('h264', 'ps_cubbonpark', 'io.meera');
  ids.evidence = ev.id;
  await app.db.updateTable('evidence').set({ description: `${MARK} description` }).where('id', '=', ev.id).execute();
  const ev2 = await createRegisteredEvidence({ orgCode: 'ps_cubbonpark', uploadedBy: meeraId, title: `${MARK} second` });
  ids.evidence2 = ev2.id;
  const ev3 = await createRegisteredEvidence({ orgCode: 'ps_cubbonpark', uploadedBy: meeraId, title: `${MARK} dispose` });
  ids.evidence3 = ev3.id;
  must('tag', await owner.post(`/api/v1/evidence/${ev.id}/tags`, { tag: 'idor' }));

  ids.snapshot = must('snapshot', await owner.post(`/api/v1/media/evidence/${ev.id}/snapshots`, { timeMs: 1000 })).body.id;
  ids.hlsRel = (await app.db.selectFrom('evidence_derivatives').select('object_key').where('evidence_id', '=', ev.id).where('kind', '=', 'PROXY_MP4').executeTakeFirstOrThrow()).object_key.slice(`evidence/${ev.id}/`.length);

  ids.batch = must('batch', await owner.post('/api/v1/uploads/batches', { orgUnitId: cubbon, label: `${MARK} batch` })).body.id;
  const clip = await smallVideo(`idor-${randomUUID().slice(0, 6)}.mp4`, 3);
  ids.upload = must('upload', await initUpload(owner, clip, { orgUnitId: cubbon, sha256: sha256File(clip), metadata: { title: `${MARK} upload` } })).body.id;

  ids.fir = must('fir', await owner.post('/api/v1/firs', { firNumber: String(Math.floor(Math.random() * 9000) + 1000), firYear: 2026, orgUnitId: cubbon, registeredAt: '2026-03-01T10:00:00Z', briefFacts: `${MARK} facts` })).body.id;
  ids.case = must('case', await owner.post('/api/v1/cases', { title: `${MARK} case`, firId: ids.fir })).body.id;
  must('case link', await owner.post(`/api/v1/cases/${ids.case}/evidence`, { evidenceIds: [ev.id] }));
  ids.note = must('note', await owner.post(`/api/v1/cases/${ids.case}/notes`, { body: `${MARK} note` })).body.id;

  ids.workspace = must('ws', await owner.post('/api/v1/workspaces', { title: `${MARK} workspace`, caseId: ids.case })).body.id;
  const items = must('ws items', await owner.post(`/api/v1/workspaces/${ids.workspace}/items`, { evidenceIds: [ev.id, ev2.id] })).body;
  ids.wsItem = (items.items ?? items)[0]?.id ?? (await app.db.selectFrom('workspace_items').select('id').where('workspace_id', '=', ids.workspace).executeTakeFirstOrThrow()).id;
  ids.wsEvent = must('ws event', await owner.post(`/api/v1/workspaces/${ids.workspace}/timeline/events`, { title: `${MARK} event`, occurredAt: '2026-03-01T10:00:00Z', evidenceId: ev.id })).body.id;
  ids.bookmark = must('bookmark', await owner.post('/api/v1/workspaces/bookmarks', { evidenceId: ev.id, workspaceId: ids.workspace, timeMs: 500, label: `${MARK} bm` })).body.id;
  ids.annotation = must('annotation', await owner.post('/api/v1/workspaces/annotations', { evidenceId: ev.id, workspaceId: ids.workspace, kind: 'NOTE', startMs: 0, body: `${MARK} ann` })).body.id;
  ids.relation = must('relation', await owner.post('/api/v1/workspaces/relations', { evidenceA: ev.id, evidenceB: ev2.id, relation: 'RELATED', note: `${MARK} rel` })).body.id;

  ids.share = must('share', await owner.post('/api/v1/shares', { evidenceIds: [ev.id], recipientType: 'INTERNAL_USER', recipientUserId: ids.kavya, purpose: `${MARK} share purpose`, expiresAt: new Date(Date.now() + 86_400_000).toISOString() })).body.share.id;
  ids.export = must('export', await owner.post('/api/v1/exports', { evidenceIds: [ev.id], purpose: `${MARK} export purpose`, courtName: 'City Civil Court', options: { includeOriginal: false, includeWatermarked: true } })).body.id;
  if (!(await app.db.selectFrom('ai_models').select('id').where('task', '=', 'PERSON_DETECTION').where('status', '=', 'ACTIVE').executeTakeFirst())) {
    await app.db.insertInto('ai_models').values({ code: `idor-${randomUUID().slice(0, 6)}`, name: 'Synthetic', task: 'PERSON_DETECTION', version: '1', artifact_uri: 'file:///dev/null', status: 'ACTIVE' } as never).execute();
  }
  ids.aiJob = must('ai job', await owner.post(`/api/v1/ai/evidence/${ev.id}/jobs`, { tasks: ['PERSON_DETECTION'] })).body.id;
  ids.detection = (await insertDetections(ev.id, meeraId, [{ label: 'car', reviewStatus: 'PENDING' }]))[0]!;
  ids.savedSearch = must('saved search', await owner.post('/api/v1/search/saved', { name: `${MARK} saved`, criteria: { text: MARK } })).body.id;

  ids.reportRun = must('report', await kavya.post('/api/v1/reports/runs', { reportType: 'EVIDENCE_INVENTORY', orgUnitId: cubbon })).body.id;
  ids.reportSchedule = must('report schedule', await kavya.post('/api/v1/reports/schedules', { name: `${MARK} schedule`, reportType: 'EVIDENCE_INVENTORY', frequency: 'DAILY', orgUnitId: cubbon })).body.id;
  ids.snapshotRequest = (await app.db.selectFrom('snapshot_requests').select('id').where('derivative_id', '=', ids.snapshot).executeTakeFirstOrThrow()).id;
  ids.quarantineRelease = (await app.db.insertInto('quarantine_releases').values({ evidence_id: ev.id, requested_by: meeraId, reason: `${MARK} release`, actor: JSON.stringify({ type: 'USER', id: meeraId, name: 'Meera' }), status: 'COMPLETED' }).returning('id').executeTakeFirstOrThrow()).id;
  ids.alert = (await raiseAlert(app.db, { ruleCode: 'UPLOAD_FAILED', severity: 'WARNING', title: `${MARK} alert`, message: MARK, orgUnitId: cubbon, dedupeKey: `IDOR:${MARK}` })).id!;
  await dispatchPendingAlerts(app.db);
  ids.notification = (await app.db.selectFrom('notifications').select('id').where('user_id', '=', ids.kavya).orderBy('created_at', 'desc').executeTakeFirstOrThrow()).id;
  ids.disposal = must('disposal', await latha.post(`/api/v1/evidence/${ev3.id}/disposal-requests`, { reason: `${MARK} retention period expired`, authorityRef: 'GO-IDOR-1' })).body.id;

  ids.session = (await app.db.selectFrom('sessions').select('id').where('user_id', '=', meeraId).where('revoked_at', 'is', null).orderBy('created_at', 'desc').executeTakeFirstOrThrow()).id;
  ids.roleAssignment = (await app.db.selectFrom('user_roles').select('id').where('user_id', '=', meeraId).executeTakeFirstOrThrow()).id;
  ids.auditSeq = String((await app.db.selectFrom('audit_events').select('seq').where('evidence_id', '=', ev.id).orderBy('seq').executeTakeFirstOrThrow()).seq);
  const dev = await app.db.insertInto('devices').values({ serial_number: `IDOR-${randomUUID().slice(0, 8)}`, device_type: 'BODY_WORN_CAMERA', org_unit_id: cubbon, notes: MARK } as never).returning('id').executeTakeFirstOrThrow();
  ids.device = dev.id;
  return { ids, owner, kavya, latha };
}

/** A SUPERVISOR-equivalent at ps_indiranagar: holds almost every permission, but in the WRONG jurisdiction. */
export async function eastSupervisor(): Promise<Agent> {
  const u = await userWithPerms([
    'evidence:read', 'evidence:play', 'evidence:edit_metadata', 'evidence:legal_hold', 'evidence:verify', 'evidence:dispose_approve',
    'evidence:dispose_request', 'evidence:quarantine_manage', 'evidence:download_original', 'evidence:snapshot', 'evidence:upload', 'ai:request', 'ai:review',
    'search:use', 'workspace:use', 'cases:read', 'cases:manage', 'cases:link_evidence', 'custody:read', 'export:approve', 'export:create',
    'export:download', 'share:create', 'share:manage_all', 'dashboard:view', 'reports:generate', 'alerts:read', 'alerts:manage',
    'devices:read', 'users:read', 'org:read', 'retention:manage',
  ] as never, 'ps_indiranagar');
  return login(u.username);
}

// -------------------------------------------------------------------------------------------------------------
// JSON-schema body generator
type Schema = { type?: string | string[]; enum?: unknown[]; const?: unknown; anyOf?: Schema[]; oneOf?: Schema[]; allOf?: Schema[]; properties?: Record<string, Schema>; required?: string[]; items?: Schema; minItems?: number; minLength?: number; maxLength?: number; minimum?: number; maximum?: number; exclusiveMinimum?: number | boolean; format?: string; pattern?: string; default?: unknown };

export function genValue(s: Schema | undefined, key: string, idFor: (key: string) => string | undefined): unknown {
  if (!s) return undefined;
  if (s.const !== undefined) return s.const;
  if (s.enum?.length) return s.enum[0];
  const alt = s.anyOf ?? s.oneOf;
  if (alt) return genValue(alt.find((x) => x.type && x.type !== 'null') ?? alt.find((x) => x.enum || x.anyOf) ?? alt[0], key, idFor);
  if (s.allOf?.length) return genValue(s.allOf[0], key, idFor);
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type;
  switch (type) {
    case 'string': {
      const id = idFor(key);
      if (s.format === 'uuid') return id ?? randomUUID();
      if (s.format === 'date-time') return new Date(Date.now() + 86_400_000).toISOString();
      if (s.format === 'date') return '2026-01-01';
      if (s.format === 'email') return 'probe@example.org';
      if (s.format === 'uri' || s.format === 'url') return 'https://example.org/x';
      if (s.pattern === '^\\d{6}$') return '123456';
      if (id) return id;
      const min = Math.max(s.minLength ?? 0, 12);
      let v = 'Security probe text '.repeat(Math.ceil(min / 20) + 1).slice(0, min);
      if (s.maxLength !== undefined) v = v.slice(0, s.maxLength);
      return v;
    }
    case 'integer':
    case 'number': {
      let v = typeof s.minimum === 'number' ? s.minimum : typeof s.exclusiveMinimum === 'number' ? s.exclusiveMinimum + 1 : 1;
      if (typeof s.maximum === 'number') v = Math.min(v, s.maximum);
      return v;
    }
    case 'boolean':
      return false;
    case 'array': {
      const item = genValue(s.items, key.replace(/s$/, ''), idFor);
      return Array.from({ length: Math.max(1, s.minItems ?? 1) }, () => item);
    }
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const k of s.required ?? []) out[k] = genValue(s.properties?.[k], k, idFor);
      // PATCH-style bodies (all optional, "at least one field" refinements): send the first property.
      const first = Object.keys(s.properties ?? {})[0];
      if (!Object.keys(out).length && first) out[first] = genValue(s.properties![first], first, idFor);
      return out;
    }
    default:
      return undefined;
  }
}

/** OpenAPI request-body schema for a route (registry URL form `/api/v1/x/:id`). */
export function bodySchema(app: FastifyInstance, method: string, url: string): Schema | undefined {
  const spec = app.swagger() as { paths: Record<string, Record<string, { requestBody?: { content?: Record<string, { schema?: Schema }> } }>> };
  const oa = url.replace(/:([A-Za-z0-9_]+)/g, '{$1}').replace(/\*$/, '{*}');
  const ops = spec.paths[oa] ?? spec.paths[`${oa}/`] ?? spec.paths[oa.replace(/\/$/, '')];
  return ops?.[method.toLowerCase()]?.requestBody?.content?.['application/json']?.schema;
}
