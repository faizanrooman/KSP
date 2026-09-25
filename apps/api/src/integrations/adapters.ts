/**
 * Adapter implementations and factory.
 *
 *  fixture   — backed by labelled synthetic fixtures (fixture-data.ts) passed through the SAME contract schema
 *              and mappers as http-json. For development/tests only; a fixture system can never be "verified".
 *  http-json — configurable JSON/HTTP client for the assumed contract (contract.ts). Best-guess SKELETON:
 *              UNVERIFIED until a live contract test against the real upstream passes.
 */
import type { IntegrationAdapterId, IntegrationSystemType } from '@ksp/shared';
import { z } from 'zod';
import {
  diaryListResponse, evidenceReferenceBody, firListResponse, firResponse, healthResponse, mapDiaryEntry, mapFir, mapRepoEvidence,
  parseUpstream, pushResponse, repoEvidenceResponse, upstreamFir,
} from './contract.js';
import { FIXTURE_FIRS } from './fixture-data.js';
import { requestJson, type AuthType, type HttpTarget } from './http.js';
import {
  IntegrationError, type AnyAdapter, type CaseDiaryAdapter, type CctnsAdapter, type EvidenceRepositoryAdapter, type FirSearchQuery, type HealthResult,
} from './types.js';

/** integration_systems.config (validated on write). */
export const systemConfigSchema = z
  .object({
    authType: z.enum(['none', 'bearer', 'basic', 'mtls']).default('none'),
    timeoutMs: z.number().int().min(200).max(60_000).default(10_000),
    retries: z.number().int().min(0).max(5).default(2),
    /** Upstream station code -> our org unit code (default: identical). */
    stationCodeMap: z.record(z.string().max(40), z.string().regex(/^[a-z0-9_]{2,40}$/)).default({}),
    /** Fixture adapter only: simulate failures (tests / demos). */
    fixtureMode: z.enum(['normal', 'down', 'unauthorized', 'mismatch']).default('normal'),
  })
  .strict();
export type SystemConfig = z.infer<typeof systemConfigSchema>;

export interface SystemRow {
  id: string;
  code: string;
  system_type: string;
  adapter: string;
  base_url: string | null;
  config: unknown;
  credentials_ref: string | null;
  enabled: boolean;
}

export function parseConfig(raw: unknown): SystemConfig {
  const r = systemConfigSchema.safeParse(raw ?? {});
  if (!r.success) throw new IntegrationError('NOT_CONFIGURED', 'Integration configuration is invalid');
  return r.data;
}

// ------------------------------------------------------------------------------------------------ fixture
function fixtureGuard(cfg: SystemConfig) {
  if (cfg.fixtureMode === 'down') throw new IntegrationError('UPSTREAM_ERROR', 'Fixture system simulated outage');
  if (cfg.fixtureMode === 'unauthorized') throw new IntegrationError('UNAUTHORIZED', 'Fixture system simulated credential rejection');
}
function fixtureFirs(cfg: SystemConfig): unknown[] {
  return cfg.fixtureMode === 'mismatch' ? FIXTURE_FIRS.map((f) => ({ ...f, regDateTime: undefined, firStatus: 'SOMETHING_ELSE' })) : FIXTURE_FIRS;
}
const fixtureHealth = async (cfg: SystemConfig): Promise<HealthResult> => {
  fixtureGuard(cfg);
  return { ok: true, latencyMs: 0, detail: 'FIXTURE adapter (synthetic data; not a real upstream)' };
};

function fixtureCctns(cfg: SystemConfig): CctnsAdapter {
  const all = () => fixtureFirs(cfg).map((f) => mapFir(parseUpstream(upstreamFir, f, 'FIR')));
  return {
    kind: 'CCTNS',
    async fetchFir(stationCode, year, firNumber) {
      fixtureGuard(cfg);
      const norm = (n: string) => n.replace(/^0+/, '');
      return all().find((f) => f.stationCode === stationCode && f.firYear === year && norm(f.firNumber) === norm(firNumber)) ?? null;
    },
    async searchFirs(q: FirSearchQuery) {
      fixtureGuard(cfg);
      return all()
        .filter((f) => (!q.stationCode || f.stationCode === q.stationCode) && (!q.year || f.firYear === q.year) && (!q.q || `${f.firNumber} ${f.briefFacts ?? ''}`.toLowerCase().includes(q.q.toLowerCase())))
        .slice(0, q.limit ?? 50);
    },
    async pushEvidenceReference(caseRef, ref) {
      fixtureGuard(cfg);
      return { accepted: true, externalRef: `FIXTURE-REF-${caseRef}-${ref.evidenceNumber}` };
    },
    healthCheck: () => fixtureHealth(cfg),
  };
}

function fixtureDiary(cfg: SystemConfig): CaseDiaryAdapter {
  return {
    kind: 'CASE_DIARY',
    async fetchEntries() {
      fixtureGuard(cfg);
      return [];
    },
    async pushEntry(caseRef) {
      fixtureGuard(cfg);
      return { accepted: true, externalRef: `FIXTURE-DIARY-${caseRef}` };
    },
    healthCheck: () => fixtureHealth(cfg),
  };
}

function fixtureRepo(cfg: SystemConfig): EvidenceRepositoryAdapter {
  return {
    kind: 'EVIDENCE_REPOSITORY',
    async lookup() {
      fixtureGuard(cfg);
      return null;
    },
    async pushReference(ref) {
      fixtureGuard(cfg);
      return { accepted: true, externalRef: `FIXTURE-REPO-${ref.evidenceNumber}` };
    },
    healthCheck: () => fixtureHealth(cfg),
  };
}

// ------------------------------------------------------------------------------------------------ http-json
async function httpHealth(t: HttpTarget): Promise<HealthResult> {
  const started = Date.now();
  const res = await requestJson(t, 'GET', 'health');
  if (res.status === 404) throw new IntegrationError('CONTRACT_MISMATCH', 'Upstream has no /health endpoint (contract mismatch)');
  const h = parseUpstream(healthResponse, res.json, 'health response');
  if (h.status !== 'UP') throw new IntegrationError('UPSTREAM_ERROR', 'Upstream reports status DOWN');
  return { ok: true, latencyMs: Date.now() - started, detail: h.version ? `upstream version ${h.version}` : undefined };
}
const seg = (v: string) => encodeURIComponent(v);

function httpCctns(t: HttpTarget): CctnsAdapter {
  return {
    kind: 'CCTNS',
    async fetchFir(stationCode, year, firNumber) {
      const res = await requestJson(t, 'GET', `firs/${seg(stationCode)}/${year}/${seg(firNumber)}`);
      if (res.status === 404) return null;
      return mapFir(parseUpstream(firResponse, res.json, 'FIR response').fir);
    },
    async searchFirs(q) {
      const qs = new URLSearchParams();
      if (q.stationCode) qs.set('psCode', q.stationCode);
      if (q.year) qs.set('year', String(q.year));
      if (q.q) qs.set('q', q.q);
      qs.set('limit', String(q.limit ?? 50));
      const res = await requestJson(t, 'GET', `firs?${qs}`);
      if (res.status === 404) return [];
      return parseUpstream(firListResponse, res.json, 'FIR search response').items.map(mapFir);
    },
    async pushEvidenceReference(caseRef, ref) {
      const res = await requestJson(t, 'POST', `cases/${seg(caseRef)}/evidence-references`, evidenceReferenceBody(ref));
      if (res.status === 404) throw new IntegrationError('NOT_FOUND', 'Upstream case not found');
      const r = parseUpstream(pushResponse, res.json, 'push response');
      return { accepted: r.accepted, externalRef: r.referenceId ?? null };
    },
    healthCheck: () => httpHealth(t),
  };
}

function httpDiary(t: HttpTarget): CaseDiaryAdapter {
  return {
    kind: 'CASE_DIARY',
    async fetchEntries(caseRef, since) {
      const res = await requestJson(t, 'GET', `case-diaries/${seg(caseRef)}/entries${since ? `?since=${encodeURIComponent(since.toISOString())}` : ''}`);
      if (res.status === 404) return [];
      return parseUpstream(diaryListResponse, res.json, 'case diary response').items.map(mapDiaryEntry);
    },
    async pushEntry(caseRef, entry) {
      const res = await requestJson(t, 'POST', `case-diaries/${seg(caseRef)}/entries`, { enteredAt: entry.enteredAt.toISOString(), author: entry.author, text: entry.body });
      if (res.status === 404) throw new IntegrationError('NOT_FOUND', 'Upstream case diary not found');
      const r = parseUpstream(pushResponse, res.json, 'push response');
      return { accepted: r.accepted, externalRef: r.referenceId ?? null };
    },
    healthCheck: () => httpHealth(t),
  };
}

function httpRepo(t: HttpTarget): EvidenceRepositoryAdapter {
  return {
    kind: 'EVIDENCE_REPOSITORY',
    async lookup(ref) {
      const res = await requestJson(t, 'GET', `evidence/${seg(ref)}`);
      if (res.status === 404) return null;
      return mapRepoEvidence(parseUpstream(repoEvidenceResponse, res.json, 'evidence response').evidence);
    },
    async pushReference(ref) {
      const res = await requestJson(t, 'POST', 'evidence-references', { ...evidenceReferenceBody(ref), caseRef: ref.caseRef });
      const r = parseUpstream(pushResponse, res.json, 'push response');
      return { accepted: r.accepted, externalRef: r.referenceId ?? null };
    },
    healthCheck: () => httpHealth(t),
  };
}

// ------------------------------------------------------------------------------------------------ factory
/** Adapter for a configured system. Throws NOT_CONFIGURED for unknown adapters / missing base URL. */
export function createAdapter(sys: SystemRow): AnyAdapter {
  const cfg = parseConfig(sys.config);
  const type = sys.system_type as IntegrationSystemType;
  const adapter = sys.adapter as IntegrationAdapterId;
  if (adapter === 'fixture') {
    if (type === 'CASE_DIARY') return fixtureDiary(cfg);
    if (type === 'EVIDENCE_REPOSITORY') return fixtureRepo(cfg);
    if (type === 'CCTNS' || type === 'FIR') return fixtureCctns(cfg);
    throw new IntegrationError('NOT_CONFIGURED', `No fixture adapter for system type ${type}`);
  }
  if (adapter === 'http-json') {
    if (!sys.base_url) throw new IntegrationError('NOT_CONFIGURED', 'Base URL is not configured');
    const t: HttpTarget = { baseUrl: sys.base_url, authType: cfg.authType as AuthType, credentialsRef: sys.credentials_ref, timeoutMs: cfg.timeoutMs, retries: cfg.retries };
    if (type === 'CASE_DIARY') return httpDiary(t);
    if (type === 'EVIDENCE_REPOSITORY') return httpRepo(t);
    if (type === 'CCTNS' || type === 'FIR') return httpCctns(t);
    throw new IntegrationError('NOT_CONFIGURED', `No http-json adapter for system type ${type}`);
  }
  throw new IntegrationError('NOT_CONFIGURED', `Unknown adapter ${sys.adapter}`);
}

export function cctnsAdapter(sys: SystemRow): CctnsAdapter {
  const a = createAdapter(sys);
  if (a.kind !== 'CCTNS') throw new IntegrationError('NOT_CONFIGURED', 'System is not a CCTNS/FIR system');
  return a;
}
