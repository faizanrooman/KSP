/**
 * SQL migration runner. Migrations are plain .sql files in db/migrations, applied in lexical order,
 * each in its own transaction, recorded in schema_migrations with a SHA-256 checksum. An applied
 * migration whose file content changed aborts the run: schema changes MUST be new migration files.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { loadConfig, repoRoot } from '../config.js';
import { sha256Hex } from '../crypto.js';
import { installQueueSchema } from '../queue.js';

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function migrate(connectionString?: string, log: (m: string) => void = console.log): Promise<MigrationResult> {
  const cfg = loadConfig();
  const url = connectionString ?? cfg.DATABASE_MIGRATION_URL ?? cfg.DATABASE_URL;
  const dir = resolve(repoRoot(), 'db/migrations');
  const files = readdirSync(dir).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const result: MigrationResult = { applied: [], skipped: [] };
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    // Only one migrator at a time.
    await client.query('SELECT pg_advisory_lock(7340033)');
    const { rows } = await client.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations');
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));
    for (const file of files) {
      const sql = readFileSync(join(dir, file), 'utf8');
      const checksum = sha256Hex(sql);
      const prior = applied.get(file);
      if (prior) {
        if (prior !== checksum) throw new Error(`Migration ${file} was modified after being applied (checksum mismatch). Create a new migration instead.`);
        result.skipped.push(file);
        continue;
      }
      log(`applying ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
      result.applied.push(file);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(7340033)').catch(() => undefined);
    await client.end();
  }
  log('installing queue schema (pg-boss)');
  await installQueueSchema(url);
  return result;
}
