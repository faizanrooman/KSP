import { PgBoss } from 'pg-boss';
import { QUEUES, SCHEDULES, type QueueName } from '@ksp/shared';
import pg from 'pg';
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
  [QUEUES.SHARE_WATERMARK]: { retryLimit: 3, expireInSeconds: 6 * 3600 },
  // Delivery retries are scheduled explicitly (one job per attempt); the queue retry only covers crashes.
  [QUEUES.ALERT_DELIVER]: { retryLimit: 1, expireInSeconds: 600 },
  [QUEUES.QUARANTINE_RELEASE]: { retryLimit: 3, expireInSeconds: 6 * 3600 },
  [QUEUES.SNAPSHOT_EXTRACT]: { retryLimit: 1, expireInSeconds: 600 },
};

export async function getQueue(connectionString?: string): Promise<PgBoss> {
  if (boss) return boss;
  if (starting) return starting;
  starting = (async () => {
    // Runtime connections use the least-privilege app role: no schema migration / DDL. The schema and all
    // queues are installed by `installQueueSchema` during `npm run db:migrate` (schema owner).
    const b = new PgBoss({ connectionString: connectionString ?? loadConfig().DATABASE_URL, schema: 'pgboss', application_name: 'ksp-queue', migrate: false, createSchema: false });
    b.on('error', (err: Error) => console.error('[queue] error', err.message));
    await b.start();
    boss = b;
    return b;
  })();
  return starting;
}

/** Every queue the system uses: work queues, their dead-letter queues, and cron (schedule) queues. */
export function allQueueNames(): string[] {
  return [...Object.keys(QUEUE_DEFAULTS), ...Object.keys(QUEUE_DEFAULTS).map((n) => `${n}.dead`), ...Object.keys(SCHEDULES)];
}

/**
 * Install/upgrade the pg-boss schema and create all queues as the SCHEMA OWNER (called from migrate()),
 * then grant the app role DML-only access. New queue names must be added to @ksp/shared QUEUES/SCHEDULES.
 */
export async function installQueueSchema(ownerUrl: string, appRole = 'ksp_app'): Promise<void> {
  const b = new PgBoss({ connectionString: ownerUrl, schema: 'pgboss', application_name: 'ksp-queue-install', supervise: false, schedule: false });
  b.on('error', (err: Error) => console.error('[queue-install] error', err.message));
  await b.start();
  try {
    for (const [name, opts] of Object.entries(QUEUE_DEFAULTS)) {
      const dead = `${name}.dead`;
      if (!(await b.getQueue(dead))) await b.createQueue(dead);
      if (!(await b.getQueue(name))) {
        await b.createQueue(name, { retryLimit: opts.retryLimit, retryBackoff: true, retryDelay: 10, expireInSeconds: opts.expireInSeconds, deadLetter: dead });
      }
    }
    for (const name of Object.keys(SCHEDULES)) if (!(await b.getQueue(name))) await b.createQueue(name, { retryLimit: 1, expireInSeconds: 3600 });
  } finally {
    await b.stop({ graceful: false, wait: true } as never);
  }
  const c = new pg.Client({ connectionString: ownerUrl });
  await c.connect();
  try {
    await c.query(`GRANT USAGE ON SCHEMA pgboss TO ${appRole};
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO ${appRole};
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO ${appRole};
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO ${appRole};
      ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${appRole};
      ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT USAGE, SELECT ON SEQUENCES TO ${appRole};`);
  } finally {
    await c.end();
  }
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
