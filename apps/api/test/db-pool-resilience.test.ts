/**
 * Regression (E2E finding): an idle pooled connection terminated by the server (DB restart / failover) must not
 * crash the process — the pool must swallow the 'error' event, discard the client and keep serving queries.
 */
import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { createPool, loadConfig } from '@ksp/core';

describe('database pool resilience', () => {
  it('survives the server terminating an idle client and keeps working', async () => {
    const pool = createPool(loadConfig().DATABASE_URL, 2);
    try {
      const c = await pool.connect();
      const pid = (await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      c.release(); // now idle in the pool
      const killer = new pg.Client({ connectionString: loadConfig().DATABASE_URL });
      await killer.connect();
      await killer.query('SELECT pg_terminate_backend($1)', [pid]);
      await killer.end();
      // Give the socket close time to surface as a pool 'error' (unhandled => process exit before the fix).
      await new Promise((r) => setTimeout(r, 300));
      expect(pool.listenerCount('error')).toBeGreaterThan(0);
      const r = await pool.query<{ ok: number }>('SELECT 1 AS ok');
      expect(r.rows[0]!.ok).toBe(1);
    } finally {
      await pool.end();
    }
  });

  it('survives the server terminating a checked-out client between queries', async () => {
    const pool = createPool(loadConfig().DATABASE_URL, 2);
    try {
      const c = await pool.connect();
      const pid = (await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      const killer = new pg.Client({ connectionString: loadConfig().DATABASE_URL });
      await killer.connect();
      await killer.query('SELECT pg_terminate_backend($1)', [pid]);
      await killer.end();
      await new Promise((r) => setTimeout(r, 300)); // unhandled Client 'error' => process exit before the fix
      await expect(c.query('SELECT 1')).rejects.toThrow();
      c.release(new Error('terminated'));
      expect((await pool.query<{ ok: number }>('SELECT 1 AS ok')).rows[0]!.ok).toBe(1);
    } finally {
      await pool.end();
    }
  });
});
