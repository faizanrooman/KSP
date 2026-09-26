import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';
import { loadConfig } from '../config.js';
import type { DB } from './types.js';

export type { DB } from './types.js';
export type Database = Kysely<DB>;
export type Tx = Transaction<DB>;
export { sql };

// Return bigint/numeric as JS numbers where safe; timestamps stay Date.
pg.types.setTypeParser(20, (v) => Number(v)); // int8
pg.types.setTypeParser(1700, (v) => Number(v)); // numeric
// cidr[] / inet[] (e.g. api_clients.allowed_ips) as string[] (pg has no default array parser for these OIDs).
pg.types.setTypeParser(651 as never, pg.types.getTypeParser(1009 as never));
pg.types.setTypeParser(1041 as never, pg.types.getTypeParser(1009 as never));

export function createPool(connectionString: string, max?: number): pg.Pool {
  const cfg = loadConfig();
  const pool = new pg.Pool({ connectionString, max: max ?? cfg.DATABASE_POOL_MAX, idleTimeoutMillis: 30_000, application_name: process.env.KSP_SERVICE ?? 'ksp' });
  // A backend terminated under a checked-out client (DB restart, crash recovery, failover, admin kill) emits 'error'
  // on that Client; without a listener Node treats it as fatal and the whole API/worker process exits (observed
  // during load testing, SEC-16). The in-flight query is still rejected, so requests fail cleanly and the pool reconnects.
  const onError = (err: Error) => console.error(`[db] connection error: ${err.message}`);
  pool.on('error', onError);
  pool.on('connect', (client) => client.on('error', onError));
  return pool;
}

export function createDb(connectionString?: string, max?: number): { db: Database; pool: pg.Pool } {
  const pool = createPool(connectionString ?? loadConfig().DATABASE_URL, max);
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  return { db, pool };
}

/** True when the error is a Postgres unique violation (optionally on a given constraint). */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505' && (!constraint || e.constraint === constraint);
}

export function isForeignKeyViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === '23503';
}
