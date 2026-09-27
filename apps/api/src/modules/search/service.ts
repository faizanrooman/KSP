/** Search execution: page of ids (ranked), hydration via the evidence list mapper, match explanations, facets. */
import { sql } from 'kysely';
import type { Database } from '@ksp/core';
import type { Principal } from '../../lib/principal.js';
import { loadListItems } from '../evidence/queries.js';
import { aiDetectionConds, buildConditions, effLabel, tsQuery, whereSql, type AiCriteria, type SearchCriteria } from './criteria.js';

export const SEARCH_SORTS = ['relevance', '-recorded_at', 'recorded_at', '-created_at', 'created_at'] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];

/** Facets are computed over at most this many matching rows (flagged `facetsTruncated`). */
export const FACET_ROW_CAP = 10_000;
/**
 * Totals are exact up to this many matches; beyond it the response says `total: TOTAL_CAP, totalApprox: true`
 * ("10 000+"). Counting stops at the cap, so a broad state-wide query no longer counts every matching row.
 */
export const TOTAL_CAP = 10_000;
/** Buckets per facet. */
export const FACET_BUCKETS = 20;
/** AI moments returned per result. */
const AI_MATCHES_PER_ITEM = 5;

const HL_START = '\u0002';
const HL_STOP = '\u0003';

export interface SnippetPart {
  text: string;
  hit: boolean;
}

export interface AiMatch {
  detectionId: string;
  task: string;
  label: string;
  confidence: number;
  frameTimeMs: number;
  reviewStatus: string;
  /** true when the detection has NOT been approved by a human reviewer (only returned when opted in). */
  unreviewed: boolean;
  colorName: string | null;
  plateText: string | null;
  watchlistEntryId: string | null;
}

export interface FacetBucket {
  key: string;
  label: string;
  count: number;
}

export function rankSql(c: SearchCriteria) {
  if (!c.text) return sql<number>`0::float8`;
  return sql<number>`(ts_rank_cd(coalesce(e.search_text, ''::tsvector), ${tsQuery(c.text)}, 32)
    + 0.5 * greatest(similarity(coalesce(e.title, ''), ${c.text}), similarity(coalesce(e.evidence_number, ''), ${c.text}))
    + CASE WHEN upper(e.evidence_number) = upper(${c.text}) THEN 10 ELSE 0 END)::float8`;
}

function orderSql(sort: SearchSort) {
  switch (sort) {
    case 'relevance':
      return sql`rank DESC, e.recorded_at DESC NULLS LAST, e.id`;
    case 'recorded_at':
      return sql`e.recorded_at ASC NULLS LAST, e.id`;
    case '-recorded_at':
      return sql`e.recorded_at DESC NULLS LAST, e.id`;
    case 'created_at':
      return sql`e.created_at ASC, e.id`;
    case '-created_at':
      return sql`e.created_at DESC, e.id`;
  }
}

/**
 * The main page query (exported for the EXPLAIN check in tests). No window count: with a date sort PostgreSQL can
 * stop after the page; the total comes from `countQuery`.
 */
export function pageQuery(p: Principal, c: SearchCriteria, sort: SearchSort, page: number, pageSize: number) {
  const where = whereSql(buildConditions(p, c));
  return sql<{ id: string; rank: number }>`SELECT e.id, ${rankSql(c)} AS rank
    FROM evidence e WHERE ${where}
    ORDER BY ${orderSql(sort)} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;
}

/** Matching rows counted up to cap + 1 (so "more than cap" is detectable without counting everything). */
export function countQuery(p: Principal, c: SearchCriteria, cap = TOTAL_CAP) {
  const where = whereSql(buildConditions(p, c));
  return sql<{ n: number }>`SELECT count(*)::int AS n FROM (SELECT 1 FROM evidence e WHERE ${where} LIMIT ${cap + 1}) x`;
}

function splitSnippet(s: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let rest = s;
  while (rest.length) {
    const a = rest.indexOf(HL_START);
    if (a < 0) {
      parts.push({ text: rest, hit: false });
      break;
    }
    if (a > 0) parts.push({ text: rest.slice(0, a), hit: false });
    const b = rest.indexOf(HL_STOP, a + 1);
    const end = b < 0 ? rest.length : b;
    parts.push({ text: rest.slice(a + 1, end), hit: true });
    rest = b < 0 ? '' : rest.slice(b + 1);
  }
  return parts.filter((x) => x.text.length);
}

async function snippets(db: Database, ids: string[], text: string): Promise<Map<string, SnippetPart[]>> {
  const rows = await sql<{ id: string; hl: string | null }>`SELECT e.id,
      CASE WHEN e.search_text @@ ${tsQuery(text)} THEN ts_headline('english',
        concat_ws(' — ', nullif(e.title, ''), nullif(e.description, ''), nullif(e.location_text, ''), e.evidence_number, e.original_filename),
        ${tsQuery(text)}, ${`StartSel=${HL_START}, StopSel=${HL_STOP}, MaxFragments=2, MaxWords=25, MinWords=6, FragmentDelimiter=" … "`}) END AS hl
    FROM evidence e WHERE e.id = ANY(${ids}::uuid[])`.execute(db);
  const out = new Map<string, SnippetPart[]>();
  for (const r of rows.rows) if (r.hl && r.hl.includes(HL_START)) out.set(r.id, splitSnippet(r.hl));
  return out;
}

export async function aiMatches(db: Database, ids: string[], ai: AiCriteria): Promise<Map<string, { total: number; items: AiMatch[] }>> {
  const rows = await sql<{
    id: string; evidence_id: string; task: string; label: string; confidence: number; frame_time_ms: string; review_status: string;
    color_name: string | null; plate_text: string | null; watchlist_entry_id: string | null; n: string; rn: string;
  }>`SELECT * FROM (
      SELECT d.id, d.evidence_id, d.task, coalesce(d.corrected_label, d.label) AS label, d.confidence, d.frame_time_ms, d.review_status,
        d.attributes->>'colorName' AS color_name, d.attributes->>'plateText' AS plate_text, d.attributes->>'watchlistEntryId' AS watchlist_entry_id,
        count(*) OVER (PARTITION BY d.evidence_id) AS n,
        row_number() OVER (PARTITION BY d.evidence_id ORDER BY (d.review_status = 'APPROVED') DESC, d.confidence DESC, d.frame_time_ms) AS rn
      FROM ai_detections d WHERE d.evidence_id = ANY(${ids}::uuid[]) AND ${whereSql(aiDetectionConds(ai))}) x
    WHERE x.rn <= ${AI_MATCHES_PER_ITEM} ORDER BY x.evidence_id, x.frame_time_ms`.execute(db);
  const out = new Map<string, { total: number; items: AiMatch[] }>();
  for (const r of rows.rows) {
    const m = out.get(r.evidence_id) ?? { total: Number(r.n), items: [] };
    m.items.push({
      detectionId: r.id, task: r.task, label: r.label, confidence: Number(r.confidence), frameTimeMs: Number(r.frame_time_ms), reviewStatus: r.review_status,
      unreviewed: r.review_status !== 'APPROVED', colorName: r.color_name, plateText: r.plate_text, watchlistEntryId: r.watchlist_entry_id,
    });
    out.set(r.evidence_id, m);
  }
  return out;
}

/**
 * Facets over at most FACET_ROW_CAP matching rows. Tag and AI-label buckets use per-item LATERAL index lookups, so
 * their cost is bounded by that sample — not by the size of evidence_tags / ai_detections (a hash join over the
 * whole detections table grows with state-wide data; FN-13).
 */
export async function facets(db: Database, p: Principal, c: SearchCriteria) {
  const where = whereSql(buildConditions(p, c));
  const aiReview = (c.ai?.reviewStatus ?? 'APPROVED') === 'APPROVED' ? sql`d.review_status = 'APPROVED'` : sql`d.review_status <> 'REJECTED'`;
  const rows = await sql<{ facet: string; key: string; label: string; count: string }>`
    WITH m AS MATERIALIZED (SELECT e.id, e.org_unit_id, e.status, e.storage_tier FROM evidence e WHERE ${where} LIMIT ${FACET_ROW_CAP})
    (SELECT 'station' AS facet, o.id::text AS key, o.name AS label, count(*) AS count FROM m JOIN org_units o ON o.id = m.org_unit_id
      GROUP BY o.id, o.name ORDER BY count(*) DESC, o.name LIMIT ${FACET_BUCKETS})
    UNION ALL
    (SELECT 'status', m.status, m.status, count(*) FROM m GROUP BY m.status ORDER BY count(*) DESC LIMIT ${FACET_BUCKETS})
    UNION ALL
    (SELECT 'storageTier', m.storage_tier, m.storage_tier, count(*) FROM m GROUP BY m.storage_tier ORDER BY count(*) DESC LIMIT ${FACET_BUCKETS})
    UNION ALL
    (SELECT 'tag', t.tag, t.tag, count(*) FROM m CROSS JOIN LATERAL (SELECT t.tag FROM evidence_tags t WHERE t.evidence_id = m.id) t
      GROUP BY t.tag ORDER BY count(*) DESC, t.tag LIMIT ${FACET_BUCKETS})
    UNION ALL
    (SELECT 'aiLabel', x.label, x.label, count(*) FROM m
      CROSS JOIN LATERAL (SELECT DISTINCT ${effLabel('d')} AS label FROM ai_detections d WHERE d.evidence_id = m.id AND ${aiReview}) x
      GROUP BY x.label ORDER BY count(*) DESC, x.label LIMIT ${FACET_BUCKETS})`.execute(db);
  const out: Record<'station' | 'status' | 'storageTier' | 'tag' | 'aiLabel', FacetBucket[]> = { station: [], status: [], storageTier: [], tag: [], aiLabel: [] };
  for (const r of rows.rows) out[r.facet as keyof typeof out].push({ key: r.key, label: r.label, count: Number(r.count) });
  return out;
}

export async function runSearch(db: Database, p: Principal, c: SearchCriteria, opts: { sort?: SearchSort; page: number; pageSize: number; includeFacets: boolean; totalCap?: number }) {
  const cap = opts.totalCap ?? TOTAL_CAP;
  const sort: SearchSort = opts.sort ?? (c.text ? 'relevance' : '-recorded_at');
  const t0 = performance.now();
  const [res, cnt] = await Promise.all([pageQuery(p, c, sort, opts.page, opts.pageSize).execute(db), countQuery(p, c, cap).execute(db)]);
  const counted = Number(cnt.rows[0]?.n ?? 0);
  const totalApprox = counted > cap;
  const total = totalApprox ? cap : counted;
  const ids = res.rows.map((r) => r.id);
  const rank = new Map(res.rows.map((r) => [r.id, Number(r.rank)]));
  const [items, snips, ai, facetData] = await Promise.all([
    loadListItems(db, p, ids),
    c.text && ids.length ? snippets(db, ids, c.text) : Promise.resolve(new Map<string, SnippetPart[]>()),
    c.ai && ids.length ? aiMatches(db, ids, c.ai) : Promise.resolve(new Map<string, { total: number; items: AiMatch[] }>()),
    opts.includeFacets ? facets(db, p, c) : Promise.resolve(null),
  ]);
  return {
    items: items.map((it) => ({
      ...it,
      matches: {
        score: c.text ? Math.round((rank.get(it.id) ?? 0) * 1000) / 1000 : null,
        snippet: snips.get(it.id) ?? null,
        ai: ai.get(it.id)?.items ?? [],
        aiTotal: ai.get(it.id)?.total ?? 0,
      },
    })),
    total,
    /** true when there are more than `total` matches (the count stopped at TOTAL_CAP). */
    totalApprox,
    page: opts.page,
    pageSize: opts.pageSize,
    sort,
    facets: facetData,
    facetsTruncated: facetData ? totalApprox || total > FACET_ROW_CAP : false,
    /** true when the results may include AI output that no human has approved (explicit opt-in). */
    includesUnreviewedAi: c.ai?.reviewStatus === 'ANY_NON_REJECTED',
    tookMs: Math.round(performance.now() - t0),
  };
}
