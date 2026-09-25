/**
 * External integration systems admin (integrations:manage): CCTNS, FIR systems, case diaries, evidence repositories.
 *
 * The specification does not define these systems' API contracts. A system is shown as VERIFIED only after a
 * live contract test (POST /systems/:id/test with a probe) passed against it with the `http-json` adapter;
 * any change to adapter / base URL / config / credentials resets verification. `fixture` systems are never verified.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';
import { appendAudit } from '@ksp/core';
import { INTEGRATION_ADAPTERS, INTEGRATION_SYSTEM_TYPES } from '@ksp/shared';
import { conflict, notFound, validationFailed } from '../../lib/errors.js';
import { createAdapter, parseConfig, systemConfigSchema } from '../../integrations/adapters.js';
import { validateBaseUrl } from '../../integrations/egress.js';
import { credentialsPresent, type AuthType } from '../../integrations/http.js';
import { integrationApiError, loadSystem, recordSync } from '../../integrations/sync.js';
import { IntegrationError, toIntegrationError } from '../../integrations/types.js';

export const prefix = '/integrations';

const idParams = z.object({ id: z.string().uuid() });
const credRef = z.string().trim().regex(/^[A-Z0-9_]{2,64}$/, 'secret reference name: A-Z, 0-9, _');

const createBody = z.object({
  code: z.string().trim().regex(/^[a-z0-9_-]{2,40}$/),
  name: z.string().trim().min(2).max(200),
  systemType: z.enum(INTEGRATION_SYSTEM_TYPES),
  adapter: z.enum(INTEGRATION_ADAPTERS),
  baseUrl: z.string().trim().max(500).nullable().optional(),
  config: systemConfigSchema.partial().optional(),
  credentialsRef: credRef.nullable().optional(),
}).strict();
const patchBody = createBody.omit({ code: true, systemType: true }).partial().strict();

type Row = {
  id: string; code: string; name: string; system_type: string; adapter: string; base_url: string | null; config: unknown; credentials_ref: string | null;
  enabled: boolean; verified: boolean; verified_at: Date | null; last_sync_at: Date | null; last_status: string | null; created_at: Date; updated_at: Date;
};

function dto(r: Row) {
  const cfg = (() => {
    try {
      return parseConfig(r.config);
    } catch {
      return null;
    }
  })();
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    systemType: r.system_type,
    adapter: r.adapter,
    baseUrl: r.base_url,
    config: cfg,
    credentialsRef: r.credentials_ref,
    credentialsPresent: cfg ? credentialsPresent(cfg.authType as AuthType, r.credentials_ref) : false,
    enabled: r.enabled,
    verified: r.verified,
    verifiedAt: r.verified_at,
    verificationStatus: r.adapter === 'fixture' ? 'FIXTURE' : r.verified ? 'VERIFIED' : 'UNVERIFIED',
    lastSyncAt: r.last_sync_at,
    lastStatus: r.last_status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const COLS = ['id', 'code', 'name', 'system_type', 'adapter', 'base_url', 'config', 'credentials_ref', 'enabled', 'verified', 'verified_at', 'last_sync_at', 'last_status', 'created_at', 'updated_at'] as const;

function checkUrl(adapter: string, baseUrl: string | null | undefined) {
  if (adapter === 'http-json') {
    if (!baseUrl) throw validationFailed('baseUrl is required for the http-json adapter');
    try {
      validateBaseUrl(baseUrl);
    } catch (e) {
      throw validationFailed((e as Error).message, { integrationCode: (e as IntegrationError).code });
    }
  }
}

export default async function integrations(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const guard = app.authorize('integrations:manage');
  const load = async (id: string) => {
    const r = await app.db.selectFrom('integration_systems').select(COLS).where('id', '=', id).executeTakeFirst();
    if (!r) throw notFound('Integration system');
    return r;
  };

  app.get('/systems', { preHandler: guard, schema: { tags: ['integrations'], summary: 'List configured integration systems' } }, async () => {
    const rows = await app.db.selectFrom('integration_systems').select(COLS).orderBy('name').execute();
    return { items: rows.map(dto) };
  });

  // Enabled CCTNS/FIR systems for the FIR import dialog (case managers, not only admins).
  app.get('/systems/fir-sources', { preHandler: app.authorize('cases:manage'), schema: { tags: ['integrations'], summary: 'Enabled CCTNS/FIR systems usable for FIR import' } }, async () => {
    const rows = await app.db.selectFrom('integration_systems').select(COLS).where('enabled', '=', true).where('system_type', 'in', ['CCTNS', 'FIR']).orderBy('name').execute();
    return { items: rows.map((r) => { const d = dto(r); return { id: d.id, code: d.code, name: d.name, systemType: d.systemType, adapter: d.adapter, verified: d.verified, verificationStatus: d.verificationStatus }; }) };
  });

  app.get('/systems/:id', { preHandler: guard, schema: { tags: ['integrations'], summary: 'Integration system detail', params: idParams } }, async (req) => dto(await load(req.params.id)));

  app.post('/systems', { preHandler: guard, schema: { tags: ['integrations'], summary: 'Configure an integration system (created disabled and UNVERIFIED)', body: createBody } }, async (req, reply) => {
    const b = req.body;
    checkUrl(b.adapter, b.baseUrl);
    const config = systemConfigSchema.parse(b.config ?? {});
    const exists = await app.db.selectFrom('integration_systems').select('id').where('code', '=', b.code).executeTakeFirst();
    if (exists) throw conflict(`Integration system code ${b.code} already exists`);
    const p = req.requirePrincipal();
    const id = await app.db.transaction().execute(async (tx) => {
      const r = await tx
        .insertInto('integration_systems')
        .values({ code: b.code, name: b.name, system_type: b.systemType, adapter: b.adapter, base_url: b.baseUrl ?? null, config: JSON.stringify(config), credentials_ref: b.credentialsRef ?? null, enabled: false, verified: false, created_by: p.userId })
        .returning('id')
        .executeTakeFirstOrThrow();
      await appendAudit(tx, req.actor(), { action: 'INTEGRATION_CONFIGURED', resourceType: 'integration_system', resourceId: r.id, details: { change: 'CREATED', code: b.code, systemType: b.systemType, adapter: b.adapter, baseUrl: b.baseUrl ?? null, credentialsRef: b.credentialsRef ?? null } });
      return r.id;
    });
    reply.status(201);
    return dto(await load(id));
  });

  app.patch('/systems/:id', { preHandler: guard, schema: { tags: ['integrations'], summary: 'Update an integration system (connection changes reset verification)', params: idParams, body: patchBody } }, async (req) => {
    const cur = await load(req.params.id);
    const b = req.body;
    if (!Object.keys(b).length) throw validationFailed('No changes supplied');
    const adapter = b.adapter ?? cur.adapter;
    const baseUrl = 'baseUrl' in b ? b.baseUrl : cur.base_url;
    checkUrl(adapter, baseUrl);
    const set: Record<string, unknown> = {};
    if (b.name) set.name = b.name;
    if (b.adapter) set.adapter = b.adapter;
    if ('baseUrl' in b) set.base_url = b.baseUrl ?? null;
    if ('credentialsRef' in b) set.credentials_ref = b.credentialsRef ?? null;
    if (b.config) set.config = JSON.stringify(systemConfigSchema.parse({ ...(cur.config as object), ...b.config }));
    const connectionChanged = ['adapter', 'base_url', 'credentials_ref', 'config'].some((k) => k in set);
    if (connectionChanged) Object.assign(set, { verified: false, verified_at: null, verified_by: null });
    await app.db.transaction().execute(async (tx) => {
      await tx.updateTable('integration_systems').set(set).where('id', '=', cur.id).execute();
      await appendAudit(tx, req.actor(), { action: 'INTEGRATION_CONFIGURED', resourceType: 'integration_system', resourceId: cur.id, details: { change: 'UPDATED', fields: Object.keys(b), verificationReset: connectionChanged && cur.verified } });
    });
    return dto(await load(cur.id));
  });

  for (const [path, enabled] of [['enable', true], ['disable', false]] as const) {
    app.post(`/systems/:id/${path}`, { preHandler: guard, schema: { tags: ['integrations'], summary: `${enabled ? 'Enable' : 'Disable'} an integration system`, params: idParams } }, async (req) => {
      const cur = await load(req.params.id);
      if (enabled) {
        try {
          if (cur.adapter === 'http-json') checkUrl(cur.adapter, cur.base_url);
          createAdapter(cur);
        } catch (e) {
          throw integrationApiError(e);
        }
      }
      await app.db.transaction().execute(async (tx) => {
        await tx.updateTable('integration_systems').set({ enabled }).where('id', '=', cur.id).execute();
        await appendAudit(tx, req.actor(), { action: 'INTEGRATION_CONFIGURED', resourceType: 'integration_system', resourceId: cur.id, details: { change: enabled ? 'ENABLED' : 'DISABLED', verified: cur.verified } });
      });
      return dto(await load(cur.id));
    });
  }

  app.post('/systems/:id/test', {
    preHandler: guard,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      tags: ['integrations'],
      summary: 'Test connection (health check). With a probe, runs a live contract test; http-json systems passing it are marked VERIFIED.',
      params: idParams,
      body: z.object({
        probe: z.union([
          z.object({ stationCode: z.string().trim().min(1).max(40), year: z.number().int().min(1950).max(2200), firNumber: z.string().trim().min(1).max(40) }).strict(),
          z.object({ caseRef: z.string().trim().min(1).max(200) }).strict(),
          z.object({ evidenceRef: z.string().trim().min(1).max(200) }).strict(),
        ]).optional(),
      }).strict().optional(),
    },
  }, async (req) => {
    const p = req.requirePrincipal();
    const sys = await loadSystem(app.db, req.params.id);
    const probe = req.body?.probe;
    const started = Date.now();
    const steps: Array<{ step: string; ok: boolean; detail?: string }> = [];
    let errorCode: string | null = null;
    let errorMessage: string | null = null;
    try {
      const adapter = createAdapter(sys);
      const h = await adapter.healthCheck();
      steps.push({ step: 'health', ok: h.ok, detail: h.detail });
      if (probe) {
        if ('stationCode' in probe) {
          if (adapter.kind !== 'CCTNS') throw new IntegrationError('NOT_CONFIGURED', 'FIR probe requires a CCTNS/FIR system');
          const f = await adapter.fetchFir(probe.stationCode, probe.year, probe.firNumber);
          if (!f) throw new IntegrationError('NOT_FOUND', 'Probe FIR not found upstream; contract not demonstrated');
          steps.push({ step: 'contract:fetchFir', ok: true, detail: `parsed FIR ${f.firNumber}/${f.firYear}` });
        } else if ('caseRef' in probe) {
          if (adapter.kind !== 'CASE_DIARY') throw new IntegrationError('NOT_CONFIGURED', 'caseRef probe requires a CASE_DIARY system');
          const entries = await adapter.fetchEntries(probe.caseRef);
          steps.push({ step: 'contract:fetchEntries', ok: true, detail: `parsed ${entries.length} entries` });
        } else {
          if (adapter.kind !== 'EVIDENCE_REPOSITORY') throw new IntegrationError('NOT_CONFIGURED', 'evidenceRef probe requires an EVIDENCE_REPOSITORY system');
          const r = await adapter.lookup(probe.evidenceRef);
          if (!r) throw new IntegrationError('NOT_FOUND', 'Probe evidence not found upstream; contract not demonstrated');
          steps.push({ step: 'contract:lookup', ok: true, detail: `parsed ${r.externalRef}` });
        }
      }
    } catch (e) {
      const ie = toIntegrationError(e);
      errorCode = ie.code;
      errorMessage = ie.message;
      steps.push({ step: probe ? 'contract' : 'health', ok: false, detail: ie.message });
    }
    const ok = !errorCode;
    const verifiedNow = ok && !!probe && sys.adapter === 'http-json';
    await recordSync(app.db, {
      systemId: sys.id, direction: 'OUTBOUND', operation: probe ? 'CONTRACT_TEST' : 'HEALTH_CHECK', status: ok ? 'SUCCESS' : 'FAILURE',
      summary: { steps, latencyMs: Date.now() - started, verifiedNow, errorCode }, error: errorMessage, userId: p.userId,
    });
    await app.db.transaction().execute(async (tx) => {
      if (verifiedNow) {
        await tx.updateTable('integration_systems').set({ verified: true, verified_at: new Date(), verified_by: p.userId }).where('id', '=', sys.id).execute();
        await appendAudit(tx, req.actor(), { action: 'INTEGRATION_VERIFIED', resourceType: 'integration_system', resourceId: sys.id, details: { steps: steps.map((s) => s.step) } });
      }
      await appendAudit(tx, req.actor(), { action: 'INTEGRATION_TESTED', outcome: ok ? 'SUCCESS' : 'FAILURE', resourceType: 'integration_system', resourceId: sys.id, details: { probe: !!probe, errorCode } });
    });
    const after = await load(sys.id);
    return {
      ok,
      errorCode,
      error: errorMessage,
      steps,
      latencyMs: Date.now() - started,
      verified: after.verified,
      verificationStatus: dto(after).verificationStatus,
      note: sys.adapter === 'fixture'
        ? 'FIXTURE adapter: synthetic data only. This proves nothing about the real external system.'
        : after.verified ? 'Live contract test passed against the configured endpoint.' : 'UNVERIFIED: run a live contract test with a probe against the real system to verify.',
    };
  });

  app.get('/systems/:id/log', {
    preHandler: guard,
    schema: { tags: ['integrations'], summary: 'Integration sync log (newest first)', params: idParams, querystring: z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(25) }) },
  }, async (req) => {
    await load(req.params.id);
    const { page, pageSize } = req.query;
    const rows = await app.db
      .selectFrom('integration_sync_log as l')
      .leftJoin('users as u', 'u.id', 'l.created_by')
      .select(['l.id', 'l.direction', 'l.operation', 'l.status', 'l.request_ref', 'l.summary', 'l.error', 'l.created_at', 'u.full_name', sql<number>`count(*) OVER ()`.as('total')])
      .where('l.system_id', '=', req.params.id)
      .orderBy('l.id', 'desc')
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .execute();
    return {
      items: rows.map((r) => ({ id: Number(r.id), direction: r.direction, operation: r.operation, status: r.status, requestRef: r.request_ref, summary: r.summary, error: r.error, createdAt: r.created_at, createdByName: r.full_name })),
      total: Number(rows[0]?.total ?? 0),
      page,
      pageSize,
    };
  });
}
