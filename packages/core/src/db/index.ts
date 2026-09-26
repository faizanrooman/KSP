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
  // An idle client dropped by the server (DB restart/failover, pg_terminate_backend) is emitted as a pool 'error'.
  // Without a listener Node treats it as an unhandled 'error' event and the whole process exits (E2E finding: the
  // worker died after a Postgres restart and approved exports never built). pg-pool discards the broken client.
  pool.on('error', (err) => console.error(`[db] idle client error (discarded): ${err.message}`));
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
