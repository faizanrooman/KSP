/**
 * Database-level least privilege (defence in depth beyond the API): the application role ksp_app and the
 * isolated AI role ksp_ai must be refused by PostgreSQL itself for writes to append-only / immutable data and
 * for reads outside the AI role's explicit grants. Each statement runs in a rolled-back transaction.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { loadConfig } from '@ksp/core';

let appPool: pg.Pool;
let aiPool: pg.Pool;

beforeAll(() => {
  const cfg = loadConfig();
  appPool = new pg.Pool({ connectionString: cfg.DATABASE_URL, max: 2 });
  aiPool = new pg.Pool({ connectionString: cfg.DATABASE_AI_URL, max: 2 });
});
afterAll(async () => {
  await appPool.end();
  await aiPool.end();
});

/** Run `stmt` in a transaction that is always rolled back; resolve to the SQLSTATE of the failure (or null). */
async function sqlstate(pool: pg.Pool, stmt: string): Promise<string | null> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(stmt);
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? 'ERR';
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}

const DENIED = ['42501', 'P0001', '23514']; // insufficient_privilege, raised by guard trigger, check violation

describe('ksp_app cannot rewrite history', () => {
  it.each([
    'UPDATE audit_events SET action = action',
    'DELETE FROM audit_events',
    "INSERT INTO audit_events (action) VALUES ('X')",
    'TRUNCATE audit_events',
    'UPDATE audit_checkpoints SET head_hash = head_hash',
    'DELETE FROM evidence',
    'TRUNCATE evidence',
    'UPDATE integrity_checks SET id = id',
    'DELETE FROM integrity_checks',
    'UPDATE case_notes SET id = id',
    'DELETE FROM case_notes',
    'UPDATE share_access_log SET id = id',
    'DELETE FROM share_access_log',
    'UPDATE ai_review_events SET id = id',
    'DELETE FROM ai_review_events',
    'DELETE FROM ai_detections',
    'UPDATE evidence_legal_hold_events SET id = id',
  ])('%s', async (stmt) => {
    expect(DENIED).toContain(await sqlstate(appPool, stmt));
  });

  it('registered evidence immutable columns are guarded by trigger', async () => {
    const c = await appPool.connect();
    try {
      const r = await c.query("SELECT id FROM evidence WHERE status = 'REGISTERED' LIMIT 1");
      if (!r.rowCount) return; // no registered evidence in this DB yet; covered by evidence.test.ts
      const id = r.rows[0].id as string;
      for (const col of ['sha256', 'storage_key', 'uploaded_by', 'org_path']) {
        const code = await sqlstate(appPool, `UPDATE evidence SET ${col} = ${col === 'org_path' ? "'ksp'::ltree" : "'tampered'"} WHERE id = '${id}'`);
        expect(code, col).not.toBeNull();
      }
    } finally {
      c.release();
    }
  });
});

describe('ksp_ai is confined to its explicit grants', () => {
  it.each([
    'SELECT * FROM evidence LIMIT 1',
    'SELECT * FROM users LIMIT 1',
    'SELECT * FROM sessions LIMIT 1',
    'SELECT * FROM refresh_tokens LIMIT 1',
    'SELECT * FROM audit_events LIMIT 1',
    'SELECT * FROM api_clients LIMIT 1',
    'SELECT * FROM shares LIMIT 1',
    'SELECT * FROM cases LIMIT 1',
    'UPDATE ai_detections SET review_status = review_status',
    'DELETE FROM ai_detections',
    'DELETE FROM ai_jobs',
    'UPDATE ai_jobs SET evidence_id = evidence_id',
    'UPDATE ai_models SET id = id',
  ])('%s', async (stmt) => {
    expect(DENIED).toContain(await sqlstate(aiPool, stmt));
  });

  it('cannot insert detections for a job that is not RUNNING', async () => {
    const code = await sqlstate(aiPool, "INSERT INTO ai_detections (job_id, evidence_id) VALUES (gen_random_uuid(), gen_random_uuid())");
    expect(code).not.toBeNull();
  });
});
