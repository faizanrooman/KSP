import { PgBoss } from 'pg-boss';
import { QUEUES, type QueueName } from '@ksp/shared';
import { loadConfig } from './config.js';

/**
 * pg-boss (Postgres-backed durable job queue — no extra broker to operate). Jobs are retried with
 * exponential backoff; exhausted jobs move to the `<name>.dead` dead-letter queue and raise alerts.
 */
let boss: PgBoss | undefined;
let starting: Promise<PgBoss> | undefined;

export const QUEUE_DEFAULTS: Record<QueueName, { retryLimit: number; expireInSeconds: number }> = {
  [QUEUES.INGEST_FINALIZE]: { retryLimit: 5, expireInSeconds: 6 * 3600 },
  [QUEUES.MEDIA_PROCESS]: { retryLimit: 3, expireInSeconds: 12 * 3600 },
  [QUEUES.EXPORT_BUILD]: { retryLimit: 3, expireInSeconds: 12 * 3600 },
  [QUEUES.REPORT_BUILD]: { retryLimit: 2, expireInSeconds: 3600 },
  [QUEUES.FIXITY_CHECK]: { retryLimit: 3, expireInSeconds: 12 * 3600 },
  [QUEUES.DISPOSAL_EXECUTE]: { retryLimit: 5, expireInSeconds: 3600 },
  [QUEUES.TIER_MIGRATE]: { retryLimit: 5, expireInSeconds: 12 * 3600 },
  [QUEUES.AI_TRAINING_EXPORT]: { retryLimit: 2, expireInSeconds: 3600 },
};

export async function getQueue(connectionString?: string): Promise<PgBoss> {
  if (boss) return boss;
  if (starting) return starting;
  starting = (async () => {
    const b = new PgBoss({ connectionString: connectionString ?? loadConfig().DATABASE_URL, schema: 'pgboss', application_name: 'ksp-queue' });
    b.on('error', (err: Error) => console.error('[queue] error', err.message));
    await b.start();
    for (const [name, opts] of Object.entries(QUEUE_DEFAULTS)) {
      const dead = `${name}.dead`;
      if (!(await b.getQueue(dead))) await b.createQueue(dead);
      if (!(await b.getQueue(name))) {
        await b.createQueue(name, { retryLimit: opts.retryLimit, retryBackoff: true, retryDelay: 10, expireInSeconds: opts.expireInSeconds, deadLetter: dead });
      }
    }
    boss = b;
    return b;
  })();
  return starting;
}

export async function enqueue<T extends object>(name: QueueName, data: T, opts: { singletonKey?: string; startAfter?: number } = {}): Promise<string | null> {
  const b = await getQueue();
  return b.send(name, data, { singletonKey: opts.singletonKey, startAfter: opts.startAfter });
}

export async function stopQueue(): Promise<void> {
  if (boss) await boss.stop({ graceful: true, wait: true } as never);
  boss = undefined;
  starting = undefined;
}
