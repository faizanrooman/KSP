/**
 * PostgreSQL-backed store for @fastify/rate-limit (SEC-R4): counters live in `rate_limit_counters`
 * (migration 1001), so every API replica shares them. One atomic UPSERT per request (fixed window, same
 * semantics as the built-in LocalStore); expired rows are removed by a periodic cleanup.
 */
import type pg from 'pg';

type Cb = (err: Error | null, res?: { current: number; ttl: number }) => void;

const INCR = `
  INSERT INTO rate_limit_counters AS c (key, window_ms, count, expires_at)
  VALUES ($1, $2::int, 1, clock_timestamp() + $2::int * interval '1 millisecond')
  ON CONFLICT (key) DO UPDATE SET
    count      = CASE WHEN c.expires_at <= clock_timestamp() THEN 1 ELSE c.count + 1 END,
    window_ms  = EXCLUDED.window_ms,
    expires_at = CASE WHEN c.expires_at <= clock_timestamp() THEN EXCLUDED.expires_at ELSE c.expires_at END
  RETURNING count, greatest(0, ceil(extract(epoch FROM (expires_at - clock_timestamp())) * 1000))::bigint AS ttl`;

const READ = `
  SELECT count, greatest(0, ceil(extract(epoch FROM (expires_at - clock_timestamp())) * 1000))::bigint AS ttl
    FROM rate_limit_counters WHERE key = $1 AND expires_at > clock_timestamp()`;

export interface PgRateLimitStoreCtor {
  new (opts?: unknown): PgRateLimitStoreInstance;
}
export interface PgRateLimitStoreInstance {
  incr(key: string, cb: Cb, timeWindow: number, max: number): void;
  read(key: string, cb: Cb): void;
  child(routeOptions: { routeInfo?: { method?: string | string[]; url?: string } }): PgRateLimitStoreInstance;
}

/** Returns a Store class (the plugin instantiates it with `new Store(globalParams)`), bound to `pool`. */
export function pgRateLimitStore(pool: pg.Pool, namespace = 'g-'): PgRateLimitStoreCtor {
  class PgStore implements PgRateLimitStoreInstance {
    constructor(_opts?: unknown, private readonly prefix = namespace) {}
    incr(key: string, cb: Cb, timeWindow: number): void {
      pool.query<{ count: number; ttl: string }>(INCR, [this.prefix + key, Math.max(1, Math.trunc(timeWindow))]).then(
        (r) => cb(null, { current: Number(r.rows[0]!.count), ttl: Number(r.rows[0]!.ttl) }),
        (e: Error) => cb(e),
      );
    }
    read(key: string, cb: Cb): void {
      pool.query<{ count: number; ttl: string }>(READ, [this.prefix + key]).then(
        (r) => cb(null, r.rows[0] ? { current: Number(r.rows[0].count), ttl: Number(r.rows[0].ttl) } : { current: 0, ttl: 0 }),
        (e: Error) => cb(e),
      );
    }
    child(routeOptions: { routeInfo?: { method?: string | string[]; url?: string } }): PgRateLimitStoreInstance {
      const ri = routeOptions.routeInfo ?? {};
      return new PgStore(undefined, `${[ri.method ?? ''].flat().join(',')}${ri.url ?? ''}-`);
    }
  }
  return PgStore;
}

/** Delete expired counters (every replica runs it; the DELETE is cheap and idempotent). */
export async function cleanupRateLimitCounters(pool: pg.Pool): Promise<number> {
  const r = await pool.query(`DELETE FROM rate_limit_counters WHERE expires_at < clock_timestamp() - interval '1 minute'`);
  return r.rowCount ?? 0;
}
