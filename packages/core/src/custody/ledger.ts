/**
 * Chain-of-custody view over the audit ledger: every audit_events row with evidence_id = X, each re-verified
 * in SQL (hash recomputed with audit_row_hash() — v1/v2 canonical form per row and linkage to the preceding ledger row checked).
 */
import { sql } from 'kysely';
import type { Database, Tx } from '../db/index.js';

export interface CustodyEvent {
  seq: number;
  eventId: string;
  occurredAt: string;
  actorType: string;
  actorId: string | null;
  actorName: string | null;
  actorFullName: string | null;
  actorIp: string | null;
  action: string;
  category: string;
  outcome: string;
  resourceType: string | null;
  resourceId: string | null;
  caseId: string | null;
  orgUnitId: string | null;
  details: Record<string, unknown>;
  prevHash: string;
  hash: string;
  /** Stored hash equals sha256(prev_hash || canonical(row)). */
  hashOk: boolean;
  /** prev_hash equals the hash of ledger row seq-1 (genesis zeros for seq 1). */
  linkOk: boolean;
}

export interface LedgerHead {
  seq: number;
  hash: string;
}

export interface CustodyVerification {
  chainIntact: boolean;
  eventsChecked: number;
  brokenSeqs: number[];
  ledgerHead: LedgerHead | null;
  verifiedAt: string;
}

const SECRET_KEY = /(token|secret|password|passcode|access_?code|otp|cookie|authorization|credential)/i;

/** Remove anything secret-looking from audit details before showing/exporting them (defence in depth). */
export function sanitizeDetails(v: unknown, depth = 0): unknown {
  if (depth > 6) return '[…]';
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => sanitizeDetails(x, depth + 1));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (SECRET_KEY.test(k) && !/hash|sha/i.test(k)) out[k] = '[redacted]';
      else out[k] = sanitizeDetails(val, depth + 1);
    }
    return out;
  }
  if (typeof v === 'string' && v.length > 2000) return `${v.slice(0, 2000)}…`;
  return v;
}

interface RawRow {
  seq: string | number;
  event_id: string;
  occurred_at: Date;
  actor_type: string;
  actor_id: string | null;
  actor_name: string | null;
  actor_full_name: string | null;
  actor_ip: string | null;
  action: string;
  category: string;
  outcome: string;
  resource_type: string | null;
  resource_id: string | null;
  case_id: string | null;
  org_unit_id: string | null;
  details: Record<string, unknown>;
  prev_hash: string;
  hash: string;
  hash_ok: boolean;
  link_ok: boolean;
}

const mapRow = (r: RawRow): CustodyEvent => ({
  seq: Number(r.seq),
  eventId: r.event_id,
  occurredAt: r.occurred_at.toISOString(),
  actorType: r.actor_type,
  actorId: r.actor_id,
  actorName: r.actor_name,
  actorFullName: r.actor_full_name,
  actorIp: r.actor_ip,
  action: r.action,
  category: r.category,
  outcome: r.outcome,
  resourceType: r.resource_type,
  resourceId: r.resource_id,
  caseId: r.case_id,
  orgUnitId: r.org_unit_id,
  details: sanitizeDetails(r.details) as Record<string, unknown>,
  prevHash: r.prev_hash,
  hash: r.hash,
  hashOk: r.hash_ok,
  linkOk: r.link_ok,
});

/** Stored hash recomputed (audit_row_hash: v1/v2 canonical form per row) and linked to ledger row seq-1. */
const HASH_OK = sql<boolean>`(e.hash = audit_row_hash(e))`;
const LINK_OK = sql<boolean>`((e.prev_hash = CASE WHEN e.seq = 1 THEN repeat('0', 64)
                              ELSE (SELECT p.hash FROM audit_events p WHERE p.seq = e.seq - 1) END) IS TRUE)`;

export interface CustodyPageQuery {
  /** Events with seq > after (ascending). */
  after?: number;
  /** Events with seq < before (the page just before it; still returned ascending). */
  before?: number;
  limit?: number;
  /** Only actions flagged `custody` (their codes). */
  actions?: string[];
}

export interface CustodyPage {
  events: CustodyEvent[];
  /** More events after the last one returned. */
  hasMore: boolean;
  /** More events before the first one returned. */
  hasEarlier: boolean;
}

/** One keyset page of an item's custody events (chronological), each re-verified against the ledger. */
export async function loadCustodyPage(db: Database | Tx, evidenceId: string, q: CustodyPageQuery = {}): Promise<CustodyPage> {
  const limit = Math.max(1, Math.min(q.limit ?? 200, 5_000));
  const back = q.before !== undefined && q.after === undefined;
  const cursor = back ? sql`AND e.seq < ${q.before}::bigint` : q.after !== undefined ? sql`AND e.seq > ${q.after}::bigint` : sql``;
  const actions = q.actions ? sql`AND e.action = ANY(${q.actions}::text[])` : sql``;
  const { rows } = await sql<RawRow>`
    SELECT e.seq, e.event_id, e.occurred_at, e.actor_type, e.actor_id, e.actor_name, u.full_name AS actor_full_name,
           host(e.actor_ip) AS actor_ip, e.action, e.category, e.outcome, e.resource_type, e.resource_id, e.case_id,
           e.org_unit_id, e.details, e.prev_hash, e.hash, ${HASH_OK} AS hash_ok, ${LINK_OK} AS link_ok
      FROM audit_events e
      LEFT JOIN users u ON e.actor_type = 'USER' AND u.id::text = e.actor_id
     WHERE e.evidence_id = ${evidenceId}::uuid ${cursor} ${actions}
     ORDER BY e.seq ${back ? sql`DESC` : sql`ASC`}
     LIMIT ${limit + 1}`.execute(db);
  const more = rows.length > limit;
  const page = rows.slice(0, limit).map(mapRow);
  if (back) page.reverse();
  // The opposite direction: is there anything beyond the cursor we started from?
  const edge = back ? q.before! - 1 : q.after;
  let beyond = false;
  if (edge !== undefined) {
    const { rows: r } = await sql<{ x: number }>`SELECT 1 AS x FROM audit_events e WHERE e.evidence_id = ${evidenceId}::uuid
      AND e.seq ${back ? sql`>` : sql`<=`} ${edge}::bigint ${actions} LIMIT 1`.execute(db);
    beyond = r.length > 0;
  }
  return back ? { events: page, hasMore: beyond, hasEarlier: more } : { events: page, hasMore: more, hasEarlier: beyond };
}

/** All custody events of one evidence item (chronological), fetched in keyset batches — no cap. */
export async function* iterateCustodyEvents(db: Database | Tx, evidenceId: string, batch = 2_000): AsyncGenerator<CustodyEvent> {
  let after = 0;
  for (;;) {
    const p = await loadCustodyPage(db, evidenceId, { after, limit: batch });
    for (const e of p.events) yield e;
    if (!p.hasMore || !p.events.length) return;
    after = p.events[p.events.length - 1]!.seq;
  }
}

/** Custody events of one evidence item (chronological), each re-verified against the ledger. */
export async function loadCustodyEvents(db: Database | Tx, evidenceId: string, limit = Number.MAX_SAFE_INTEGER): Promise<CustodyEvent[]> {
  const out: CustodyEvent[] = [];
  for await (const e of iterateCustodyEvents(db, evidenceId)) {
    if (out.length >= limit) break;
    out.push(e);
  }
  return out;
}

/**
 * Whole-chain verification of an item without shipping its rows: every custody row is re-hashed and its link
 * checked inside PostgreSQL; only counts, the first 100 broken seqs and the ledger head come back.
 */
export async function verifyCustodyChain(db: Database | Tx, evidenceId: string, actions?: string[]): Promise<CustodyVerification & { firstSeq: number | null; lastSeq: number | null; matching: number }> {
  const match = actions ? sql`e.action = ANY(${actions}::text[])` : sql`TRUE`;
  const { rows } = await sql<{ n: number; matching: number; first_seq: string | null; last_seq: string | null; broken: string[] | null }>`
    SELECT count(*)::int AS n, (count(*) FILTER (WHERE ${match}))::int AS matching, min(e.seq) AS first_seq, max(e.seq) AS last_seq,
           (array_agg(e.seq ORDER BY e.seq) FILTER (WHERE NOT (${HASH_OK} AND ${LINK_OK})))[1:100] AS broken
      FROM audit_events e
     WHERE e.evidence_id = ${evidenceId}::uuid`.execute(db);
  const r = rows[0]!;
  const broken = (r.broken ?? []).map(Number);
  return {
    chainIntact: broken.length === 0,
    eventsChecked: r.n,
    brokenSeqs: broken,
    ledgerHead: await ledgerHead(db),
    verifiedAt: new Date().toISOString(),
    firstSeq: r.first_seq === null ? null : Number(r.first_seq),
    lastSeq: r.last_seq === null ? null : Number(r.last_seq),
    matching: r.matching,
  };
}

export async function ledgerHead(db: Database | Tx): Promise<LedgerHead | null> {
  const r = await db.selectFrom('audit_events').select(['seq', 'hash']).orderBy('seq', 'desc').limit(1).executeTakeFirst();
  return r ? { seq: Number(r.seq), hash: r.hash } : null;
}

export async function verifyCustody(db: Database | Tx, events: CustodyEvent[]): Promise<CustodyVerification> {
  const broken = events.filter((e) => !e.hashOk || !e.linkOk).map((e) => e.seq);
  return { chainIntact: broken.length === 0, eventsChecked: events.length, brokenSeqs: broken, ledgerHead: await ledgerHead(db), verifiedAt: new Date().toISOString() };
}

export interface LedgerVerifyResult {
  checked: number;
  firstBadSeq: number | null;
  headSeq: number | null;
  headHash: string | null;
  ok: boolean;
}

/** Full recomputation of the chain between two sequence numbers (audit_verify()). */
export async function verifyLedger(db: Database | Tx, from = 1, to: number | null = null): Promise<LedgerVerifyResult> {
  const { rows } = await sql<{ checked: string; first_bad_seq: string | null; head_seq: string | null; head_hash: string | null }>`
    SELECT * FROM audit_verify(${from}::bigint, ${to}::bigint)`.execute(db);
  const r = rows[0]!;
  const firstBad = r.first_bad_seq === null ? null : Number(r.first_bad_seq);
  return { checked: Number(r.checked), firstBadSeq: firstBad, headSeq: r.head_seq === null ? null : Number(r.head_seq), headHash: r.head_hash, ok: firstBad === null };
}

/** Deterministic JSON (object keys sorted recursively) — the exact bytes that get signed. */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const val = (v as Record<string, unknown>)[k];
      if (val !== undefined) out[k] = sortKeys(val);
    }
    return out;
  }
  return v;
}
