/** Worker: audit.checkpoint — incremental verification + signed head; cron queue consumer wiring. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, evidenceSigner, getQueue, loadConfig, stopQueue, type Database } from '@ksp/core';
import { checkpointPayload, verifyCheckpoint } from '@ksp/core/custody';
import { runAuditCheckpoint } from '../src/jobs/audit/index.js';

let db: Database;

beforeAll(async () => {
  db = createDb(loadConfig().DATABASE_URL, 4).db;
  await getQueue();
}, 120_000);

afterAll(async () => {
  await stopQueue();
  await db.destroy();
});

describe('audit.checkpoint', () => {
  it('signs the verified head; the next checkpoint verifies incrementally from the previous head', async () => {
    const a = await runAuditCheckpoint({ db });
    expect(a.created).toBe(true);
    const cpA = a.checkpoint!;
    const head = await db.selectFrom('audit_events').select(['seq', 'hash']).where('seq', '=', cpA.headSeq).executeTakeFirstOrThrow();
    expect(cpA.headHash).toBe(head.hash);
    expect(cpA.chainOk).toBe(true);
    const payload = checkpointPayload({ headSeq: cpA.headSeq, headHash: cpA.headHash, createdAt: new Date(cpA.createdAt), keyId: cpA.keyId });
    expect(evidenceSigner().verify(Buffer.from(payload), cpA.signature)).toBe(true);
    expect(evidenceSigner().verify(Buffer.from(payload.replace(cpA.headHash, '0'.repeat(64))), cpA.signature)).toBe(false);
    const created = await db.selectFrom('audit_events').select(['action', 'actor_id', 'resource_id']).where('action', '=', 'AUDIT_CHECKPOINT_CREATED').where('resource_id', '=', String(cpA.id)).executeTakeFirstOrThrow();
    expect(created.actor_id).toBe('audit-worker');

    const b = await runAuditCheckpoint({ db });
    expect(b.created).toBe(true);
    expect(b.checkpoint!.verifiedFromSeq).toBe(cpA.headSeq + 1);
    expect(b.checkpoint!.headSeq).toBeGreaterThan(cpA.headSeq); // at least A's own AUDIT_CHECKPOINT_CREATED event
    const v = await verifyCheckpoint(db, b.checkpoint!.id);
    expect(v?.ok).toBe(true);
  });

  it('the cron queue consumer is registered and produces checkpoints', async () => {
    const { startWorker } = await import('../src/main.js');
    const ctx = await startWorker(['audit']);
    const before = await db.selectFrom('audit_checkpoints').select((eb) => eb.fn.max('id').as('m')).executeTakeFirstOrThrow();
    await ctx.boss.send('audit.checkpoint', {});
    const until = Date.now() + 60_000;
    let after = before.m;
    while (Date.now() < until) {
      after = (await db.selectFrom('audit_checkpoints').select((eb) => eb.fn.max('id').as('m')).executeTakeFirstOrThrow()).m;
      if (Number(after) > Number(before.m)) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(Number(after)).toBeGreaterThan(Number(before.m));
    await ctx.db.destroy();
  });
});
