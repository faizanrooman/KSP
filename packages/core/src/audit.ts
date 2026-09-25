import { sql } from 'kysely';
import { AUDIT_ACTIONS, type AuditAction, type AuditActorType, type AuditOutcome } from '@ksp/shared';
import type { Database, Tx } from './db/index.js';

/** Who performed an action. Built per request by the API, or statically by workers. */
export interface AuditActor {
  type: AuditActorType;
  id: string | null;
  name?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  sessionId?: string | null;
}

export interface AuditEvent {
  action: AuditAction;
  outcome?: AuditOutcome;
  resourceType?: string;
  resourceId?: string;
  evidenceId?: string | null;
  caseId?: string | null;
  orgUnitId?: string | null;
  details?: Record<string, unknown>;
}

export const systemActor = (name: string): AuditActor => ({ type: 'SYSTEM', id: name, name });

/**
 * Append an event to the tamper-evident ledger. Pass the SAME transaction as the business change so the
 * action and its audit record commit (or roll back) together. Never swallow failures: if audit cannot be
 * written the business operation must fail.
 */
export async function appendAudit(db: Database | Tx, actor: AuditActor, ev: AuditEvent): Promise<{ seq: number; hash: string }> {
  const category = AUDIT_ACTIONS[ev.action].category;
  const ip = actor.ip && isIp(actor.ip) ? actor.ip : null;
  const { rows } = await sql<{ seq: number; hash: string }>`
    SELECT seq, hash FROM audit_append(
      ${actor.type}, ${actor.id}, ${actor.name ?? null}, ${ip}::inet, ${truncate(actor.userAgent, 512)}, ${actor.sessionId ?? null}::uuid,
      ${ev.action}, ${category}, ${ev.outcome ?? 'SUCCESS'}, ${ev.resourceType ?? null}, ${ev.resourceId ?? null},
      ${ev.evidenceId ?? null}::uuid, ${ev.caseId ?? null}::uuid, ${ev.orgUnitId ?? null}::uuid, ${JSON.stringify(ev.details ?? {})}::jsonb
    )`.execute(db);
  return rows[0]!;
}

function truncate(v: string | null | undefined, n: number): string | null {
  return v ? v.slice(0, n) : null;
}

function isIp(v: string): boolean {
  return /^[0-9.]+$/.test(v) || /^[0-9a-fA-F:.]+$/.test(v);
}
