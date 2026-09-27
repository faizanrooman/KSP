import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { HeadBucketCommand } from '@aws-sdk/client-s3';

/**
 * Liveness (process up) and readiness (dependencies reachable) probes for orchestrators/load balancers.
 * Public, so the readiness answer is generic (`ok` / `fail` per check, SEC-R7): backend error text is only
 * logged; details are available to `system:monitor` holders at GET /api/v1/system/health.
 */
export default async function health(app: FastifyInstance) {
  app.get('/health/live', { config: { public: true }, schema: { hide: true } }, async () => ({ status: 'ok' }));
  app.get('/health/ready', { config: { public: true }, schema: { hide: true } }, async (req, reply) => {
    const checks: Record<string, 'ok' | 'fail'> = {};
    const time = async (name: string, fn: () => Promise<unknown>) => {
      const t = Date.now();
      try {
        await fn();
        checks[name] = 'ok';
      } catch (e) {
        checks[name] = 'fail';
        req.log.warn({ check: name, ms: Date.now() - t, err: (e as Error).message.slice(0, 500) }, 'readiness check failed');
      }
    };
    await Promise.all([
      time('database', () => sql`SELECT 1`.execute(app.db)),
      time('objectStorage', () => app.storage.s3.send(new HeadBucketCommand({ Bucket: app.storage.bucket('evidence') }))),
    ]);
    const ok = Object.values(checks).every((c) => c === 'ok');
    return reply.status(ok ? 200 : 503).send({ status: ok ? 'ready' : 'degraded', checks });
  });
}
