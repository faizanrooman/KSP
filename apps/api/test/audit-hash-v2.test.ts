/**
 * SEC-R1: versioned audit hash canonical form. A scratch database is built with the migrations BEFORE 1000
 * (so real v1 rows exist, written by the old audit_append()), then migration 1000 is applied and more rows are
 * appended (v2). The mixed chain must verify; tampering user_agent on a v2 row must be detected; a v2 row must
 * not be downgradable to v1.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, resetConfigCache } from '@ksp/core';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const dbName = `ksp_scratch_audv2_${process.pid}`;
let admin: pg.Client;
let c: pg.Client;

const append = (ua: string) => c.query(`SELECT seq FROM audit_append('USER', 'u1', 'tester', '10.0.0.1'::inet, $1, NULL, 'EVIDENCE_VIEWED', 'CUSTODY', 'SUCCESS', 'evidence', 'x', NULL, NULL, NULL, '{"a":1}'::jsonb)`, [ua]);
const verify = async () => (await c.query<{ checked: string; first_bad_seq: string | null; head_seq: string }>('SELECT * FROM audit_verify()')).rows[0]!;
const superUpdate = async (setSql: string, seq: number) => {
  await c.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update');
  await c.query(`UPDATE audit_events SET ${setSql} WHERE seq = $1`, [seq]);
  await c.query('ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update');
};

beforeAll(async () => {
  resetConfigCache();
  const url = new URL(loadConfig().DATABASE_MIGRATION_URL);
  admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  url.pathname = `/${dbName}`;
  c = new pg.Client({ connectionString: url.toString() });
  await c.connect();
  const files = readdirSync(MIGRATIONS).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  for (const f of files.filter((x) => x < '1000')) await c.query(readFileSync(join(MIGRATIONS, f), 'utf8'));
  for (let i = 0; i < 3; i++) await append(`legacy-agent-${i}`);
  await c.query(readFileSync(join(MIGRATIONS, '1000_audit_hash_v2.sql'), 'utf8'));
  for (let i = 0; i < 3; i++) await append(`new-agent-${i}`);
}, 120_000);

afterAll(async () => {
  await c?.end();
  await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin?.end();
});

describe('audit hash v1 + v2 chain (SEC-R1)', () => {
  it('keeps old rows at v1, writes v2 after the migration, and the mixed chain verifies', async () => {
    const { rows } = await c.query<{ seq: string; hash_version: number }>('SELECT seq, hash_version FROM audit_events ORDER BY seq');
    expect(rows.map((r) => r.hash_version)).toEqual([1, 1, 1, 2, 2, 2]);
    const v = await verify();
    expect(v.first_bad_seq).toBeNull();
    expect(Number(v.checked)).toBe(6);
    const ok = await c.query<{ ok: boolean }>('SELECT bool_and(hash = audit_row_hash(e)) AS ok FROM audit_events e');
    expect(ok.rows[0]!.ok).toBe(true);
  });

  it('detects a superuser change of user_agent on a v2 row (and restores)', async () => {
    const orig = (await c.query<{ user_agent: string }>('SELECT user_agent FROM audit_events WHERE seq = 5')).rows[0]!.user_agent;
    await superUpdate(`user_agent = 'forged-agent'`, 5);
    expect(Number((await verify()).first_bad_seq)).toBe(5);
    await superUpdate(`user_agent = '${orig}'`, 5);
    expect((await verify()).first_bad_seq).toBeNull();
  });

  it('detects re-labelling a v2 row as v1 (version downgrade)', async () => {
    await superUpdate('hash_version = 1', 6);
    expect(Number((await verify()).first_bad_seq)).toBe(6);
    await superUpdate('hash_version = 2', 6);
    expect((await verify()).first_bad_seq).toBeNull();
  });

  it('v1 rows remain verified with the v1 form (user_agent was not covered then — documented limitation)', async () => {
    await superUpdate(`details = details || '{"t":1}'::jsonb`, 2);
    expect(Number((await verify()).first_bad_seq)).toBe(2);
    await superUpdate(`details = '{"a":1}'::jsonb`, 2);
    expect((await verify()).first_bad_seq).toBeNull();
  });
});
