import type { AppConfig, Database, Storage } from '@ksp/core';
import type { Logger } from 'pino';

/** Everything the isolated AI worker may touch: ksp_ai DB connection + derived-bucket-only storage client. */
export interface AiContext {
  db: Database;
  storage: Storage;
  cfg: AppConfig;
  log: Logger;
  workerName: string;
}
