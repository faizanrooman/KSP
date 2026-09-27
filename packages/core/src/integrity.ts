/**
 * Fixity coverage (FN-6). Every stored original — the current copy, superseded RETAINED copies and recorded DR copies —
 * should be re-hashed once per `integrityPolicy.fullCycleDays`. The nightly sweep verifies
 * clamp(ceil(total / fullCycleDays), minPerNight, maxPerNight) copies within `maxBytesPerNight`, choosing
 *   0. never-verified copies, 1. originals recently moved by a tier migration (verified only while copying),
 *   2. the least-recently verified copies.
 * `integrityCoverage` reports coverage (share verified within the cycle) and the projected cycle length for the
 * System health page.
 */
import { sql } from 'kysely';
import { DEFAULT_SETTINGS, type IntegrityPolicy } from '@ksp/shared';
import type { Database, Tx } from './db/index.js';

export type CopyKind = 'PRIMARY' | 'RETAINED' | 'DR';
export interface FixityCandidate { kind: CopyKind; evidenceId: string; refId: number | null; sizeBytes: number; lastVerifiedAt: Date | null; priority: 0 | 1 | 2 }

const STORED = sql.raw(`('REGISTERED','DISPOSAL_PENDING')`);

export async function loadIntegrityPolicy(db: Database | Tx): Promise<IntegrityPolicy> {
  const r = await db.selectFrom('system_settings').select('value').where('key', '=', 'integrityPolicy').executeTakeFirst();
  return { ...DEFAULT_SETTINGS.integrityPolicy, ...((r?.value as Partial<IntegrityPolicy> | undefined) ?? {}) };
}

export function nightlyBatchSize(total: number, p: IntegrityPolicy): number {
  if (total <= 0) return 0;
  return Math.min(p.maxPerNight, Math.max(p.minPerNight, Math.ceil(total / p.fullCycleDays)));
}

interface Totals { kind: CopyKind; total: number; bytes: number; never: number; in_cycle: number; oldest: Date | null }

async function totals(db: Database | Tx, cycleDays: number): Promise<Totals[]> {
  const since = sql`now() - make_interval(days => ${cycleDays})`;
  const { rows } = await sql<Totals>`
    SELECT 'PRIMARY' AS kind, count(*)::int AS total, coalesce(sum(size_bytes), 0)::float8 AS bytes,
           count(*) FILTER (WHERE last_verified_at IS NULL)::int AS never,
           count(*) FILTER (WHERE last_verified_at >= ${since})::int AS in_cycle, min(last_verified_at) AS oldest
      FROM evidence WHERE status IN ${STORED} AND storage_key IS NOT NULL AND sha256 IS NOT NULL
    UNION ALL
    SELECT 'RETAINED', count(*)::int, coalesce(sum(e.size_bytes), 0)::float8,
           count(*) FILTER (WHERE c.last_verified_at IS NULL)::int, count(*) FILTER (WHERE c.last_verified_at >= ${since})::int, min(c.last_verified_at)
      FROM evidence_storage_copies c JOIN evidence e ON e.id = c.evidence_id WHERE c.status = 'RETAINED' AND e.status IN ${STORED}
    UNION ALL
    SELECT 'DR', count(*)::int, coalesce(sum(coalesce(d.size_bytes, e.size_bytes)), 0)::float8,
           count(*) FILTER (WHERE d.last_verified_at IS NULL)::int, count(*) FILTER (WHERE d.last_verified_at >= ${since})::int, min(d.last_verified_at)
      FROM dr_object_copies d JOIN evidence e ON e.id = d.evidence_id WHERE d.kind = 'ORIGINAL' AND d.status = 'PRESENT' AND e.status IN ${STORED}`.execute(db);
  return rows;
}

export interface IntegrityCoverage {
  policy: IntegrityPolicy;
  total: number;
  verifiedInCycle: number;
  coveragePercent: number | null;
  neverVerified: number;
  oldestVerifiedAt: Date | null;
  nightlyBatch: number;
  /** Items per night after the byte budget (average object size). */
  effectiveNightly: number;
  projectedCycleDays: number | null;
  byKind: Record<CopyKind, { total: number; verifiedInCycle: number; neverVerified: number }>;
  lastSweep: { at: Date; checks: number; failed: number } | null;
}

export async function integrityCoverage(db: Database | Tx, policy?: IntegrityPolicy): Promise<IntegrityCoverage> {
  const p = policy ?? (await loadIntegrityPolicy(db));
  const t = await totals(db, p.fullCycleDays);
  const total = t.reduce((s, x) => s + x.total, 0);
  const bytes = t.reduce((s, x) => s + Number(x.bytes), 0);
  const nightly = nightlyBatchSize(total, p);
  const avg = total ? bytes / total : 0;
  const effective = p.maxBytesPerNight > 0 && avg > 0 ? Math.max(1, Math.min(nightly, Math.floor(p.maxBytesPerNight / avg))) : nightly;
  const inCycle = t.reduce((s, x) => s + x.in_cycle, 0);
  const oldest = t.map((x) => x.oldest).filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
  const { rows: last } = await sql<{ at: Date | null; checks: number; failed: number }>`
    SELECT max(checked_at) AS at, count(*)::int AS checks, count(*) FILTER (WHERE NOT ok)::int AS failed
      FROM integrity_checks WHERE trigger = 'SCHEDULED' AND checked_at > now() - interval '26 hours'`.execute(db);
  const byKind = Object.fromEntries(t.map((x) => [x.kind, { total: x.total, verifiedInCycle: x.in_cycle, neverVerified: x.never }])) as IntegrityCoverage['byKind'];
  return {
    policy: p, total, verifiedInCycle: inCycle, coveragePercent: total ? Math.round((inCycle / total) * 1000) / 10 : null,
    neverVerified: t.reduce((s, x) => s + x.never, 0), oldestVerifiedAt: oldest, nightlyBatch: nightly, effectiveNightly: effective,
    projectedCycleDays: effective ? Math.ceil(total / effective) : null, byKind,
    lastSweep: last[0]?.at ? { at: last[0].at, checks: last[0].checks, failed: last[0].failed } : null,
  };
}

/**
 * Choose tonight's fixity candidates: up to `batch` copies, in priority order, within the byte budget (at least one).
 * Copies verified within `minAgeHours` are skipped unless they are priority 0/1.
 */
export async function selectFixityCandidates(db: Database | Tx, opts: { batch: number; maxBytes: number; minAgeHours?: number }): Promise<FixityCandidate[]> {
  const limit = Math.max(0, opts.batch);
  if (!limit) return [];
  const minAge = sql`now() - make_interval(hours => ${opts.minAgeHours ?? 24})`;
  const notQueued = (kind: string) => sql`NOT EXISTS (SELECT 1 FROM processing_jobs pj WHERE pj.evidence_id = e.id AND pj.kind = ${kind} AND pj.status IN ('QUEUED','RUNNING'))`;
  const { rows: primary } = await sql<{ id: string; size: number; lv: Date | null; migrated: boolean }>`
    SELECT e.id, e.size_bytes::float8 AS size, e.last_verified_at AS lv,
           EXISTS (SELECT 1 FROM evidence_storage_copies c
                    WHERE c.evidence_id = e.id AND c.status = 'CURRENT' AND c.created_at > now() - interval '7 days'
                      AND c.created_at >= e.last_verified_at - interval '1 hour'
                      AND EXISTS (SELECT 1 FROM evidence_storage_copies o WHERE o.evidence_id = e.id AND o.id <> c.id)) AS migrated
      FROM evidence e
     WHERE e.status IN ${STORED} AND e.storage_key IS NOT NULL AND e.sha256 IS NOT NULL AND ${notQueued('FIXITY_CHECK')}
       AND (e.last_verified_at IS NULL OR e.last_verified_at < ${minAge}
            OR EXISTS (SELECT 1 FROM evidence_storage_copies c WHERE c.evidence_id = e.id AND c.status = 'CURRENT' AND c.created_at > now() - interval '7 days'
                         AND c.created_at >= e.last_verified_at - interval '1 hour' AND EXISTS (SELECT 1 FROM evidence_storage_copies o WHERE o.evidence_id = e.id AND o.id <> c.id)))
     ORDER BY e.last_verified_at ASC NULLS FIRST, e.registered_at
     LIMIT ${limit}`.execute(db);
  const { rows: retained } = await sql<{ id: number; evidence_id: string; size: number; lv: Date | null }>`
    SELECT c.id::int AS id, c.evidence_id, e.size_bytes::float8 AS size, c.last_verified_at AS lv
      FROM evidence_storage_copies c JOIN evidence e ON e.id = c.evidence_id
     WHERE c.status = 'RETAINED' AND e.status IN ${STORED} AND (c.last_verified_at IS NULL OR c.last_verified_at < ${minAge}) AND ${notQueued('FIXITY_CHECK_COPY')}
     ORDER BY c.last_verified_at ASC NULLS FIRST, c.id LIMIT ${limit}`.execute(db);
  const { rows: dr } = await sql<{ id: number; evidence_id: string; size: number; lv: Date | null }>`
    SELECT d.id::int AS id, d.evidence_id, coalesce(d.size_bytes, e.size_bytes)::float8 AS size, d.last_verified_at AS lv
      FROM dr_object_copies d JOIN evidence e ON e.id = d.evidence_id
     WHERE d.kind = 'ORIGINAL' AND d.status = 'PRESENT' AND e.status IN ${STORED} AND (d.last_verified_at IS NULL OR d.last_verified_at < ${minAge}) AND ${notQueued('FIXITY_CHECK_COPY')}
     ORDER BY d.last_verified_at ASC NULLS FIRST, d.id LIMIT ${limit}`.execute(db);
  const all: FixityCandidate[] = [
    ...primary.map((r) => ({ kind: 'PRIMARY' as const, evidenceId: r.id, refId: null, sizeBytes: Number(r.size), lastVerifiedAt: r.lv, priority: (r.lv === null ? 0 : r.migrated ? 1 : 2) as 0 | 1 | 2 })),
    ...retained.map((r) => ({ kind: 'RETAINED' as const, evidenceId: r.evidence_id, refId: r.id, sizeBytes: Number(r.size), lastVerifiedAt: r.lv, priority: (r.lv === null ? 0 : 2) as 0 | 2 })),
    ...dr.map((r) => ({ kind: 'DR' as const, evidenceId: r.evidence_id, refId: r.id, sizeBytes: Number(r.size), lastVerifiedAt: r.lv, priority: (r.lv === null ? 0 : 2) as 0 | 2 })),
  ].sort((a, b) => a.priority - b.priority || (a.lastVerifiedAt?.getTime() ?? 0) - (b.lastVerifiedAt?.getTime() ?? 0));
  const out: FixityCandidate[] = [];
  let bytes = 0;
  for (const c of all) {
    if (out.length >= limit) break;
    if (opts.maxBytes > 0 && out.length > 0 && bytes + c.sizeBytes > opts.maxBytes) continue; // skip big ones, smaller may still fit
    out.push(c);
    bytes += c.sizeBytes;
  }
  return out;
}
