import type { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';
import type { AppConfig, Database, Storage } from '@ksp/core';
import type pg from 'pg';

export interface WorkerContext {
  boss: PgBoss;
  db: Database;
  pool: pg.Pool;
  storage: Storage;
  cfg: AppConfig;
  log: Logger;
}

/**
 * A job module (apps/worker/src/jobs/<name>/index.ts) default-exports a `register` function that calls
 * ctx.boss.work(...) for its queues and/or ctx.boss.schedule(...) for cron jobs.
 */
export type JobModule = (ctx: WorkerContext) => Promise<void>;
