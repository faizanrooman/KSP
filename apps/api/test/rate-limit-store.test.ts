/** SEC-R4: PostgreSQL-backed rate-limit store shared by several API instances (replicas). */
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, loadConfig, resetConfigCache } from '@ksp/core';
import type pg from 'pg';
import { cleanupRateLimitCounters, pgRateLimitStore } from '../src/lib/rate-limit-store.js';

const pools: pg.Pool[] = [];
const replicas: FastifyInstance[] = [];
const ns = `t${randomUUID().slice(0, 8)}-`;

async function replica(): Promise<FastifyInstance> {
  const { pool } = createDb(loadConfig().DATABASE_URL, 2);
  pools.push(pool);
  const app = Fastify();
  await app.register(rateLimit, { global: true, max: 1000, timeWindow: '1 minute', store: pgRateLimitStore(pool, ns) as never, keyGenerator: () => 'client-1' });
  app.get('/limited', { config: { rateLimit: { max: 3, timeWindow: 2000 } } }, async () => ({ ok: true }));
  app.get('/global', async () => ({ ok: true }));
  await app.ready();
  replicas.push(app);
  return app;
}

beforeAll(() => resetConfigCache());
afterAll(async () => {
  for (const a of replicas) await a.close();
  for (const p of pools) await p.end();
});

describe('postgres rate-limit store (SEC-R4)', () => {
  it('two app instances share one counter per route + client', async () => {
    const [a, b] = [await replica(), await replica()];
    const codes: number[] = [];
    for (const app of [a, b, a, b, a]) codes.push((await app.inject({ method: 'GET', url: '/limited' })).statusCode);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    const r = await b.inject({ method: 'GET', url: '/limited' });
    expect(r.statusCode).toBe(429);
    expect(Number(r.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    // Other routes (global limit) have their own counter.
    expect((await a.inject({ method: 'GET', url: '/global' })).statusCode).toBe(200);
    const g = await b.inject({ method: 'GET', url: '/global' });
    expect(g.headers['x-ratelimit-remaining']).toBe('998');
  });

  it('the window expires, counts restart, and cleanup removes expired rows', async () => {
    const a = replicas[0]!;
    await new Promise((r) => setTimeout(r, 2200));
    expect((await a.inject({ method: 'GET', url: '/limited' })).statusCode).toBe(200);
    const pool = pools[0]!;
    await pool.query(`UPDATE rate_limit_counters SET expires_at = now() - interval '2 minutes' WHERE key LIKE $1`, [`%client-1`]);
    expect(await cleanupRateLimitCounters(pool)).toBeGreaterThanOrEqual(1);
    const left = await pool.query(`SELECT count(*)::int AS n FROM rate_limit_counters WHERE key LIKE $1 AND expires_at < now()`, ['%client-1']);
    expect(left.rows[0].n).toBe(0);
  });

  it('buildApp uses the postgres store when RATE_LIMIT_STORE=postgres', async () => {
    process.env.RATE_LIMIT_STORE = 'postgres';
    resetConfigCache();
    const { buildApp } = await import('../src/app.js');
    const app = await buildApp({ logger: false });
    try {
      const before = await app.pool.query(`SELECT count(*)::int AS n FROM rate_limit_counters WHERE key LIKE 'g-%'`);
      await app.inject({ method: 'GET', url: '/health/live', remoteAddress: '10.77.0.1' });
      const after = await app.pool.query<{ count: number }>(`SELECT count FROM rate_limit_counters WHERE key LIKE '%10.77.0.1'`);
      expect(after.rows.length).toBeGreaterThanOrEqual(1);
      expect(Number(before.rows[0].n)).toBeGreaterThanOrEqual(0);
    } finally {
      await app.close();
      delete process.env.RATE_LIMIT_STORE;
      resetConfigCache();
    }
  });
});
