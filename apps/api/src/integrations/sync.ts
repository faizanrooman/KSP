/** Integration bookkeeping: system lookup, append-only sync log, error mapping to API errors. */
import type { Database, Tx } from '@ksp/core';
import { AppError, notFound } from '../lib/errors.js';
import type { SystemRow } from './adapters.js';
import { IntegrationError, integrationHttpStatus, toIntegrationError } from './types.js';

export async function loadSystem(db: Database | Tx, id: string): Promise<SystemRow & { name: string; verified: boolean }> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Integration system');
  const s = await db
    .selectFrom('integration_systems')
    .select(['id', 'code', 'name', 'system_type', 'adapter', 'base_url', 'config', 'credentials_ref', 'enabled', 'verified'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!s) throw notFound('Integration system');
  return s;
}

export interface SyncEntry {
  systemId: string;
  direction: 'INBOUND' | 'OUTBOUND';
  operation: string;
  status: 'SUCCESS' | 'FAILURE';
  requestRef?: string | null;
  summary?: Record<string, unknown>;
  error?: string | null;
  userId?: string | null;
}

export async function recordSync(db: Database | Tx, e: SyncEntry): Promise<void> {
  await db
    .insertInto('integration_sync_log')
    .values({
      system_id: e.systemId,
      direction: e.direction,
      operation: e.operation,
      status: e.status,
      request_ref: e.requestRef ?? null,
      summary: JSON.stringify(e.summary ?? {}),
      error: e.error ? e.error.slice(0, 2000) : null,
      created_by: e.userId ?? null,
    })
    .execute();
  await db
    .updateTable('integration_systems')
    .set({ last_sync_at: new Date(), last_status: e.status === 'SUCCESS' ? `OK ${e.operation}` : `FAILED ${e.operation}: ${(e.error ?? '').slice(0, 200)}` })
    .where('id', '=', e.systemId)
    .execute();
}

/** Adapter error -> API error `{ code: INTEGRATION_<CODE>, details: { integrationCode } }`. */
export function integrationApiError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  const ie: IntegrationError = toIntegrationError(e);
  return new AppError(integrationHttpStatus(ie.code), `INTEGRATION_${ie.code}`, ie.message, { integrationCode: ie.code, upstreamStatus: ie.upstreamStatus ?? null });
}
