/**
 * alerts.evaluate (every minute): evaluate enabled alert_rules against the database and raise, bump or
 * auto-resolve alerts. See docs/DASHBOARDS-REPORTS-ALERTS.md §Alert rules for the semantics of each rule.
 *
 * Idempotency: each rule keeps a cursor (alert_cursors.watermark = upper bound of its last evaluated window).
 *  - Event rules (one alert per failed upload/job/check) re-scan (watermark − OVERLAP, now] so rows committed
 *    late by long transactions are not missed; repeats are harmless because they use `onlyIfNew` keys.
 *  - Rate rules (downloads/hour, login failures/15 min, denials/15 min) evaluate a sliding window ending now
 *    but only raise/bump when the actor had activity after the watermark, so an unchanged situation does not
 *    inflate `occurrences`.
 *  - State rules (storage, queue backlog) raise while the condition holds and auto-resolve when it clears.
 *  - AUDIT_CHAIN_BROKEN verifies the ledger incrementally from last_seq+1, plus a full pass periodically.
 * Each rule runs in its own transaction with its cursor row locked (FOR UPDATE), so concurrent evaluators
 * serialise per rule and a crash rolls back both the alerts and the cursor advance.
 */
import { sql } from 'kysely';
import { ALERT_RULE_CODES, type AlertRuleCode } from '@ksp/shared';
import { autoResolveAlerts, queueStats, raiseAlert, type AlertSeverity, type Database, type Tx } from '@ksp/core';
import { loadSettings } from './settings.js';

export const OVERLAP_MINUTES = 10;
export const INITIAL_LOOKBACK_MINUTES = 60;

export interface RuleRow {
  code: string;
  enabled: boolean;
  severity: AlertSeverity;
  config: Record<string, unknown>;
}

export interface RuleContext {
  tx: Tx;
  rule: RuleRow;
  from: Date; // watermark (exclusive)
  to: Date; // evaluation time (inclusive)
  cursor: { last_seq: number | null; state: Record<string, unknown> };
}

export interface RuleOutcome {
  raised: number;
  resolved: number;
  lastSeq?: number | null;
  state?: Record<string, unknown>;
}

export interface EvaluationSummary {
  rule: string;
  enabled: boolean;
  raised: number;
  resolved: number;
  ms: number;
  error?: string;
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
const overlapFrom = (from: Date) => new Date(from.getTime() - OVERLAP_MINUTES * 60_000);

type Evaluator = (c: RuleContext) => Promise<RuleOutcome>;

async function raiseCounted(tx: Tx, a: Parameters<typeof raiseAlert>[1]): Promise<number> {
  const r = await raiseAlert(tx, a);
  return r.id && (r.created || !a.onlyIfNew) && !r.suppressed ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------------
const uploadFailed: Evaluator = async ({ tx, from, to }) => {
  let raised = 0;
  const failed = await tx
    .selectFrom('upload_sessions')
    .select(['id', 'org_unit_id', 'original_filename', 'error'])
    .where('status', '=', 'FAILED')
    .where('updated_at', '>', overlapFrom(from))
    .where('updated_at', '<=', to)
    .orderBy('updated_at')
    .limit(500)
    .execute();
  for (const s of failed) {
    raised += await raiseCounted(tx, {
      ruleCode: 'UPLOAD_FAILED', title: `Upload failed: ${s.original_filename}`,
      message: `Upload session ${s.id} failed: ${(s.error ?? 'unknown error').slice(0, 500)}`,
      resourceType: 'upload_session', resourceId: s.id, orgUnitId: s.org_unit_id, dedupeKey: `UPLOAD_FAILED:${s.id}`, onlyIfNew: true,
    });
  }
  const quarantined = await tx
    .selectFrom('evidence')
    .select(['id', 'org_unit_id', 'original_filename', 'status_reason'])
    .where('status', '=', 'QUARANTINED')
    .where('updated_at', '>', overlapFrom(from))
    .where('updated_at', '<=', to)
    .orderBy('updated_at')
    .limit(500)
    .execute();
  for (const e of quarantined) {
    raised += await raiseCounted(tx, {
      ruleCode: 'UPLOAD_FAILED', title: `Upload quarantined: ${e.original_filename}`,
      message: `Evidence ${e.id} was quarantined during ingestion: ${(e.status_reason ?? 'no reason recorded').slice(0, 500)}`,
      resourceType: 'evidence', resourceId: e.id, orgUnitId: e.org_unit_id, dedupeKey: `UPLOAD_QUARANTINED:${e.id}`, onlyIfNew: true,
    });
  }
  return { raised, resolved: 0 };
};

const processingFailed: Evaluator = async ({ tx, from, to }) => {
  let raised = 0;
  const rows = await tx
    .selectFrom('processing_jobs as pj')
    .leftJoin('evidence as e', 'e.id', 'pj.evidence_id')
    .leftJoin('upload_sessions as us', 'us.id', 'pj.upload_session_id')
    .select(['pj.id', 'pj.kind', 'pj.error', 'pj.evidence_id', 'pj.upload_session_id', 'e.evidence_number', 'e.org_unit_id as ev_org', 'us.org_unit_id as us_org'])
    .where('pj.status', '=', 'FAILED')
    .where('pj.finished_at', '>', overlapFrom(from))
    .where('pj.finished_at', '<=', to)
    .orderBy('pj.finished_at')
    .limit(500)
    .execute();
  for (const r of rows) {
    const subject = r.evidence_number ?? r.evidence_id ?? r.upload_session_id ?? r.id;
    raised += await raiseCounted(tx, {
      ruleCode: 'PROCESSING_FAILED', title: `${r.kind} failed for ${subject}`,
      message: (r.error ?? 'processing failed').slice(0, 1000),
      resourceType: r.evidence_id ? 'evidence' : 'processing_job', resourceId: r.evidence_id ?? r.id,
      orgUnitId: r.ev_org ?? r.us_org ?? null, dedupeKey: `PROCESSING_FAILED:${r.id}`, onlyIfNew: true,
    });
  }
  // Auto-resolve: the same processing job later completed (pg-boss retry succeeded).
  const { rows: cleared } = await sql<{ dedupe_key: string }>`
    SELECT a.dedupe_key FROM alerts a JOIN processing_jobs pj ON a.dedupe_key = 'PROCESSING_FAILED:' || pj.id::text
     WHERE a.rule_code = 'PROCESSING_FAILED' AND a.status <> 'RESOLVED' AND pj.status = 'COMPLETED'`.execute(tx);
  let resolved = 0;
  for (const c of cleared) resolved += await autoResolveAlerts(tx, { dedupeKey: c.dedupe_key, note: 'Auto-resolved: the processing job completed successfully on retry.' });
  return { raised, resolved };
};

const aiFailure: Evaluator = async ({ tx, from, to }) => {
  let raised = 0;
  const rows = await tx
    .selectFrom('ai_jobs as j')
    .innerJoin('evidence as e', 'e.id', 'j.evidence_id')
    .select(['j.id', 'j.tasks', 'j.error', 'j.evidence_id', 'e.evidence_number', 'e.org_unit_id'])
    .where('j.status', '=', 'FAILED')
    .where('j.finished_at', '>', overlapFrom(from))
    .where('j.finished_at', '<=', to)
    .orderBy('j.finished_at')
    .limit(500)
    .execute();
  for (const r of rows) {
    raised += await raiseCounted(tx, {
      ruleCode: 'AI_FAILURE', title: `AI analysis failed for ${r.evidence_number ?? r.evidence_id}`,
      message: `AI job ${r.id} (${(r.tasks ?? []).join(', ')}) failed: ${(r.error ?? 'unknown error').slice(0, 800)}`,
      resourceType: 'ai_job', resourceId: r.id, orgUnitId: r.org_unit_id, dedupeKey: `AI_FAILURE:${r.id}`, onlyIfNew: true,
    });
  }
  return { raised, resolved: 0 };
};

const integrityFailure: Evaluator = async ({ tx, from, to }) => {
  let raised = 0;
  const rows = await tx
    .selectFrom('integrity_checks as ic')
    .innerJoin('evidence as e', 'e.id', 'ic.evidence_id')
    .select(['ic.id', 'ic.trigger', 'ic.error', 'ic.evidence_id', 'e.evidence_number', 'e.org_unit_id'])
    .where('ic.ok', '=', false)
    .where('ic.checked_at', '>', overlapFrom(from))
    .where('ic.checked_at', '<=', to)
    .orderBy('ic.checked_at')
    .limit(500)
    .execute();
  for (const r of rows) {
    // The fixity/tier workers raise their own alert for the item; do not double-report an open one.
    const open = await tx.selectFrom('alerts').select('id').where('rule_code', '=', 'INTEGRITY_FAILURE').where('resource_id', '=', r.evidence_id).where('status', '<>', 'RESOLVED').executeTakeFirst();
    if (open) continue;
    raised += await raiseCounted(tx, {
      ruleCode: 'INTEGRITY_FAILURE', title: `Integrity check failed for ${r.evidence_number ?? r.evidence_id}`,
      message: `${r.trigger} fixity check #${r.id} did not match the registered hash${r.error ? `: ${r.error.slice(0, 500)}` : ''}`,
      resourceType: 'evidence', resourceId: r.evidence_id, orgUnitId: r.org_unit_id, dedupeKey: `INTEGRITY_CHECK:${r.id}`, onlyIfNew: true,
    });
  }
  return { raised, resolved: 0 };
};

const storageThreshold: Evaluator = async ({ tx, rule, from }) => {
  const settings = await loadSettings(tx);
  const warn = num(rule.config.warnPercent, settings.storagePolicy.warnThresholdPercent);
  const crit = num(rule.config.criticalPercent, settings.storagePolicy.criticalThresholdPercent);
  const capacity = num(rule.config.capacityBytes, settings.storagePolicy.capacityBytes);
  const { rows } = await sql<{ bucket: string; total_bytes: string; capacity_bytes: string | null; captured_at: Date }>`
    SELECT DISTINCT ON (bucket) bucket, total_bytes, capacity_bytes, captured_at FROM storage_snapshots
     WHERE captured_at > now() - interval '1 day' ORDER BY bucket, captured_at DESC`.execute(tx);
  let raised = 0;
  let resolved = 0;
  const fresh = rows.some((r) => new Date(r.captured_at) > from);
  const check = async (key: string, label: string, used: number, cap: number) => {
    const pct = (used / cap) * 100;
    if (pct >= warn) {
      if (!fresh) return; // same snapshot already evaluated — don't inflate occurrences
      const severity: AlertSeverity = pct >= crit ? 'CRITICAL' : 'WARNING';
      raised += await raiseCounted(tx, {
        ruleCode: 'STORAGE_THRESHOLD', severity, title: `Storage ${label} at ${pct.toFixed(1)}% of capacity`,
        message: `${label}: ${used} of ${cap} bytes used (${pct.toFixed(1)}%). Thresholds: warning ${warn}%, critical ${crit}%.`,
        resourceType: 'storage', resourceId: key, dedupeKey: `STORAGE_THRESHOLD:${key}`,
      });
    } else {
      resolved += await autoResolveAlerts(tx, { dedupeKey: `STORAGE_THRESHOLD:${key}`, note: `Auto-resolved: ${label} utilisation fell to ${pct.toFixed(1)}% (below ${warn}%).` });
    }
  };
  if (capacity > 0 && rows.length) await check('TOTAL', 'total', rows.reduce((s, r) => s + Number(r.total_bytes), 0), capacity);
  for (const r of rows) if (r.capacity_bytes && Number(r.capacity_bytes) > 0) await check(r.bucket, `bucket ${r.bucket}`, Number(r.total_bytes), Number(r.capacity_bytes));
  return { raised, resolved };
};

const queueBacklog: Evaluator = async ({ tx, rule }) => {
  const maxQueued = num(rule.config.maxQueued, 500);
  const maxAge = num(rule.config.maxAgeMinutes, 60) * 60;
  let raised = 0;
  let resolved = 0;
  for (const q of await queueStats(tx)) {
    if (q.deadLetter) continue;
    const key = `QUEUE_BACKLOG:${q.queue}`;
    const age = q.oldestQueuedSeconds ?? 0;
    if (q.queued > maxQueued || age > maxAge) {
      raised += await raiseCounted(tx, {
        ruleCode: 'QUEUE_BACKLOG', title: `Queue ${q.queue} backlog`,
        message: `${q.queued} jobs waiting (limit ${maxQueued}); oldest waiting ${Math.round(age / 60)} min (limit ${maxAge / 60} min). Check worker health.`,
        resourceType: 'queue', resourceId: q.queue, dedupeKey: key,
      });
    } else {
      resolved += await autoResolveAlerts(tx, { dedupeKey: key, note: `Auto-resolved: queue ${q.queue} drained (${q.queued} waiting, oldest ${Math.round(age / 60)} min).` });
    }
  }
  return { raised, resolved };
};

const excessiveDownloads: Evaluator = async ({ tx, rule, from, to }) => {
  const settings = await loadSettings(tx);
  const limit = num(rule.config.perHour, settings.shareExportPolicy.excessiveDownloadsPerHour);
  const { rows } = await sql<{ actor_type: string; actor_id: string; actor_name: string | null; n: number; org: string | null }>`
    SELECT a.actor_type, a.actor_id, max(a.actor_name) AS actor_name, count(*)::int AS n,
           coalesce(max(u.home_org_unit_id::text), max(a.org_unit_id::text)) AS org
      FROM audit_events a
      LEFT JOIN users u ON a.actor_type = 'USER' AND u.id::text = a.actor_id
     WHERE a.action IN ('EVIDENCE_DOWNLOADED','EXPORT_DOWNLOADED','SHARE_DOWNLOADED')
       AND a.occurred_at > ${to}::timestamptz - interval '1 hour' AND a.occurred_at <= ${to}
       AND a.actor_id IS NOT NULL
     GROUP BY a.actor_type, a.actor_id
    HAVING count(*) > ${limit} AND max(a.occurred_at) > ${from}`.execute(tx);
  let raised = 0;
  for (const r of rows) {
    raised += await raiseCounted(tx, {
      ruleCode: 'EXCESSIVE_DOWNLOADS', title: `Excessive downloads by ${r.actor_name ?? r.actor_id}`,
      message: `${r.n} downloads in the last hour by ${r.actor_type.toLowerCase()} ${r.actor_name ?? r.actor_id} (threshold ${limit}/hour).`,
      resourceType: r.actor_type === 'USER' ? 'user' : r.actor_type.toLowerCase(), resourceId: r.actor_id, orgUnitId: r.org,
      dedupeKey: `EXCESSIVE_DOWNLOADS:${r.actor_type}:${r.actor_id}`,
    });
  }
  return { raised, resolved: 0 };
};

const authBruteForce: Evaluator = async ({ tx, rule, from, to }) => {
  const limit = num(rule.config.failuresPer15Min, 20);
  let raised = 0;
  const { rows: byIp } = await sql<{ ip: string; n: number; users: number }>`
    SELECT host(ip) AS ip, count(*)::int AS n, count(DISTINCT username)::int AS users FROM login_attempts
     WHERE NOT success AND ip IS NOT NULL AND created_at > ${to}::timestamptz - interval '15 minutes' AND created_at <= ${to}
     GROUP BY ip HAVING count(*) > ${limit} AND max(created_at) > ${from}`.execute(tx);
  for (const r of byIp) {
    raised += await raiseCounted(tx, {
      ruleCode: 'AUTH_BRUTE_FORCE', title: `Brute-force login attempts from ${r.ip}`,
      message: `${r.n} failed logins in 15 minutes from ${r.ip} against ${r.users} account name(s) (threshold ${limit}).`,
      resourceType: 'ip', resourceId: r.ip, dedupeKey: `AUTH_BRUTE_FORCE:ip:${r.ip}`,
    });
  }
  const { rows: byUser } = await sql<{ username: string; n: number; org: string | null; user_id: string | null }>`
    SELECT lower(la.username::text) AS username, count(*)::int AS n, max(u.home_org_unit_id::text) AS org, max(u.id::text) AS user_id
      FROM login_attempts la LEFT JOIN users u ON u.username = la.username
     WHERE NOT la.success AND la.created_at > ${to}::timestamptz - interval '15 minutes' AND la.created_at <= ${to}
     GROUP BY lower(la.username::text) HAVING count(*) > ${limit} AND max(la.created_at) > ${from}`.execute(tx);
  for (const r of byUser) {
    raised += await raiseCounted(tx, {
      ruleCode: 'AUTH_BRUTE_FORCE', title: `Brute-force login attempts against account ${r.username}`,
      message: `${r.n} failed logins in 15 minutes for account name "${r.username}" (threshold ${limit}).`,
      resourceType: r.user_id ? 'user' : 'username', resourceId: r.user_id ?? r.username, orgUnitId: r.org, dedupeKey: `AUTH_BRUTE_FORCE:user:${r.username}`,
    });
  }
  return { raised, resolved: 0 };
};

const policyViolation: Evaluator = async ({ tx, rule, from, to }) => {
  const limit = num(rule.config.deniedPer15Min, 10);
  const { rows } = await sql<{ actor_id: string; actor_name: string | null; n: number; org: string | null }>`
    SELECT a.actor_id, max(a.actor_name) AS actor_name, count(*)::int AS n, coalesce(max(u.home_org_unit_id::text), max(a.org_unit_id::text)) AS org
      FROM audit_events a LEFT JOIN users u ON a.actor_type = 'USER' AND u.id::text = a.actor_id
     WHERE a.action IN ('EVIDENCE_ACCESS_DENIED','ACCESS_DENIED') AND a.actor_id IS NOT NULL
       AND a.occurred_at > ${to}::timestamptz - interval '15 minutes' AND a.occurred_at <= ${to}
     GROUP BY a.actor_id HAVING count(*) > ${limit} AND max(a.occurred_at) > ${from}`.execute(tx);
  let raised = 0;
  for (const r of rows) {
    raised += await raiseCounted(tx, {
      ruleCode: 'POLICY_VIOLATION', title: `Repeated access denials for ${r.actor_name ?? r.actor_id}`,
      message: `${r.n} denied access attempts in 15 minutes by ${r.actor_name ?? r.actor_id} (threshold ${limit}). Review for probing or misconfigured roles.`,
      resourceType: 'user', resourceId: r.actor_id, orgUnitId: r.org, dedupeKey: `POLICY_VIOLATION:${r.actor_id}`,
    });
  }
  return { raised, resolved: 0 };
};

const auditChainBroken: Evaluator = async ({ tx, rule, cursor }) => {
  const fullEveryH = num(rule.config.fullVerifyEveryHours, 24);
  const lastFull = typeof cursor.state.lastFullAt === 'string' ? Date.parse(cursor.state.lastFullAt) : 0;
  const full = Date.now() - lastFull > fullEveryH * 3600_000;
  const fromSeq = full ? 1 : (cursor.last_seq ?? 0) + 1;
  const { rows } = await sql<{ checked: string; first_bad_seq: string | null; head_seq: string | null }>`SELECT * FROM audit_verify(${fromSeq}::bigint)`.execute(tx);
  const v = rows[0]!;
  const state = { ...cursor.state, ...(full ? { lastFullAt: new Date().toISOString() } : {}), lastChecked: Number(v.checked), lastMode: full ? 'FULL' : 'INCREMENTAL' };
  if (v.first_bad_seq !== null) {
    const raised = await raiseCounted(tx, {
      ruleCode: 'AUDIT_CHAIN_BROKEN', title: 'Audit ledger hash chain verification failed',
      message: `audit_verify(${fromSeq}) reported the first inconsistent record at seq ${v.first_bad_seq}. The audit trail may have been tampered with; preserve the database and investigate.`,
      resourceType: 'audit_ledger', resourceId: String(v.first_bad_seq), dedupeKey: 'AUDIT_CHAIN_BROKEN',
    });
    // Keep the cursor before the bad record so it is re-detected until investigated.
    return { raised, resolved: 0, lastSeq: Math.max(0, Number(v.first_bad_seq) - 1), state: { ...state, firstBadSeq: Number(v.first_bad_seq) } };
  }
  return { raised: 0, resolved: 0, lastSeq: v.head_seq !== null ? Number(v.head_seq) : cursor.last_seq, state: { ...state, firstBadSeq: null } };
};

export const EVALUATORS: Record<AlertRuleCode, Evaluator> = {
  UPLOAD_FAILED: uploadFailed,
  PROCESSING_FAILED: processingFailed,
  AI_FAILURE: aiFailure,
  INTEGRITY_FAILURE: integrityFailure,
  STORAGE_THRESHOLD: storageThreshold,
  QUEUE_BACKLOG: queueBacklog,
  EXCESSIVE_DOWNLOADS: excessiveDownloads,
  AUTH_BRUTE_FORCE: authBruteForce,
  POLICY_VIOLATION: policyViolation,
  AUDIT_CHAIN_BROKEN: auditChainBroken,
};

/** Evaluate one rule inside a transaction with its cursor locked. Disabled rules only advance the cursor. */
export async function evaluateRule(db: Database, code: AlertRuleCode): Promise<EvaluationSummary> {
  const t0 = performance.now();
  return db.transaction().execute(async (tx) => {
    const r = await tx.selectFrom('alert_rules').select(['code', 'enabled', 'severity', 'config']).where('code', '=', code).executeTakeFirst();
    const rule: RuleRow = r
      ? { code: r.code, enabled: r.enabled, severity: r.severity as AlertSeverity, config: (r.config ?? {}) as Record<string, unknown> }
      : { code, enabled: true, severity: 'WARNING', config: {} };
    await sql`INSERT INTO alert_cursors (rule_code, watermark) VALUES (${code}, now() - make_interval(mins => ${INITIAL_LOOKBACK_MINUTES})) ON CONFLICT (rule_code) DO NOTHING`.execute(tx);
    const cur = await tx.selectFrom('alert_cursors').select(['watermark', 'last_seq', 'state']).where('rule_code', '=', code).forUpdate().executeTakeFirstOrThrow();
    const { rows } = await sql<{ now: Date }>`SELECT now() AS now`.execute(tx);
    const to = new Date(rows[0]!.now);
    let out: RuleOutcome = { raised: 0, resolved: 0 };
    if (rule.enabled) {
      out = await EVALUATORS[code]({ tx, rule, from: new Date(cur.watermark), to, cursor: { last_seq: cur.last_seq === null ? null : Number(cur.last_seq), state: (cur.state ?? {}) as Record<string, unknown> } });
    }
    await tx
      .updateTable('alert_cursors')
      .set({
        watermark: to,
        updated_at: new Date(),
        ...(out.lastSeq !== undefined ? { last_seq: out.lastSeq } : {}),
        ...(out.state ? { state: JSON.stringify(out.state) } : {}),
      })
      .where('rule_code', '=', code)
      .execute();
    return { rule: code, enabled: rule.enabled, raised: out.raised, resolved: out.resolved, ms: Math.round(performance.now() - t0) };
  });
}

/** Evaluate every rule; a failing rule is reported but does not stop the others. */
export async function evaluateAlerts(db: Database, only?: AlertRuleCode[]): Promise<EvaluationSummary[]> {
  const out: EvaluationSummary[] = [];
  for (const code of only ?? ALERT_RULE_CODES) {
    try {
      out.push(await evaluateRule(db, code));
    } catch (e) {
      out.push({ rule: code, enabled: true, raised: 0, resolved: 0, ms: 0, error: (e as Error).message.slice(0, 500) });
    }
  }
  return out;
}
