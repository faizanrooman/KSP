import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { HeadBucketCommand } from '@aws-sdk/client-s3';

/** Liveness (process up) and readiness (dependencies reachable) probes for orchestrators/load balancers. */
export default async function health(app: FastifyInstance) {
  app.get('/health/live', { config: { public: true }, schema: { hide: true } }, async () => ({ status: 'ok' }));
  app.get('/health/ready', { config: { public: true }, schema: { hide: true } }, async (_req, reply) => {
    const checks: Record<string, { ok: boolean; ms: number; error?: string }> = {};
    const time = async (name: string, fn: () => Promise<unknown>) => {
      const t = Date.now();
      try {
        await fn();
        checks[name] = { ok: true, ms: Date.now() - t };
      } catch (e) {
        checks[name] = { ok: false, ms: Date.now() - t, error: (e as Error).message.slice(0, 200) };
      }
    };
    await Promise.all([
      time('database', () => sql`SELECT 1`.execute(app.db)),
      time('objectStorage', () => app.storage.s3.send(new HeadBucketCommand({ Bucket: app.storage.bucket('evidence') }))),
    ]);
    const ok = Object.values(checks).every((c) => c.ok);
    return reply.status(ok ? 200 : 503).send({ status: ok ? 'ready' : 'degraded', checks });
  });
}
