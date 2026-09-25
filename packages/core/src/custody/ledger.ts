/**
 * Chain-of-custody view over the audit ledger: every audit_events row with evidence_id = X, each re-verified
 * in SQL (hash recomputed with audit_canonical() and linkage to the preceding ledger row checked).
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

/** Custody events of one evidence item (chronological), each re-verified against the ledger. */
export async function loadCustodyEvents(db: Database | Tx, evidenceId: string, limit = 20_000): Promise<CustodyEvent[]> {
  const { rows } = await sql<RawRow>`
    SELECT e.seq, e.event_id, e.occurred_at, e.actor_type, e.actor_id, e.actor_name, u.full_name AS actor_full_name,
           host(e.actor_ip) AS actor_ip, e.action, e.category, e.outcome, e.resource_type, e.resource_id, e.case_id,
           e.org_unit_id, e.details, e.prev_hash, e.hash,
           (e.hash = encode(digest(e.prev_hash || '|' || audit_canonical(e), 'sha256'), 'hex')) AS hash_ok,
           (e.prev_hash = CASE WHEN e.seq = 1 THEN repeat('0', 64)
                               ELSE (SELECT p.hash FROM audit_events p WHERE p.seq = e.seq - 1) END) IS TRUE AS link_ok
      FROM audit_events e
      LEFT JOIN users u ON e.actor_type = 'USER' AND u.id::text = e.actor_id
     WHERE e.evidence_id = ${evidenceId}::uuid
     ORDER BY e.seq
     LIMIT ${limit}`.execute(db);
  return rows.map((r) => ({
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
  }));
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
