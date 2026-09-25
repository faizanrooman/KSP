/** Large-file ingestion (>= 200 MB): default 16 MiB chunks, concurrent parts, multi-part WORM copy, full re-hash. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { statSync } from 'node:fs';
import { stopQueue } from '@ksp/core';
import type { FastifyInstance } from 'fastify';
import { closeApp, getApp, login, type Agent } from './helpers.js';
import { ffmpegFixture, orgId, runFinalize, sha256File, sha512File, uploadAll } from './uploads-support.js';

let app: FastifyInstance;
let op: Agent;

beforeAll(async () => {
  app = await getApp();
  op = await login('op.cubbon');
});

afterAll(async () => {
  await closeApp();
  await stopQueue();
});

describe('large upload', () => {
  it('ingests a >= 200 MB video end-to-end', async () => {
    const path = await ffmpegFixture('large.mp4', [
      '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=300', '-t', '16',
      '-vf', 'noise=alls=30:allf=t', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-c:a', 'aac',
    ]);
    const size = statSync(path).size;
    expect(size).toBeGreaterThanOrEqual(200 * 1024 * 1024);
    const t0 = Date.now();
    const { init, complete } = await uploadAll(op, path, { orgUnitId: await orgId(app, 'ps_cubbonpark'), chunkSize: undefined }, { order: 'shuffle' });
    expect(init.body.chunkSize).toBe(16 * 1024 * 1024);
    expect(init.body.totalChunks).toBe(Math.ceil(size / (16 * 1024 * 1024)));
    expect(complete.status).toBe(200);
    const uploadMs = Date.now() - t0;
    const out = await runFinalize(app, init.body.id, { copyPartSize: 64 * 1024 * 1024 });
    expect(out?.outcome).toBe('REGISTERED');
    const ev = await app.db.selectFrom('evidence').selectAll().where('id', '=', complete.body.evidence.id).executeTakeFirstOrThrow();
    expect(Number(ev.size_bytes)).toBe(size);
    expect(ev.sha256).toBe(sha256File(path));
    expect(ev.sha512).toBe(sha512File(path));
    expect(Number(ev.duration_ms)).toBeGreaterThan(15_500);
    expect([ev.width, ev.height]).toEqual([1280, 720]);
    const stored = await app.storage.hashObject(ev.storage_bucket!, ev.storage_key!);
    expect(stored.size).toBe(size);
    expect(stored.sha256).toBe(ev.sha256);
    console.log(`large upload: ${(size / 1024 / 1024).toFixed(1)} MiB, ${init.body.totalChunks} chunks, upload ${uploadMs} ms, finalize ${Date.now() - t0 - uploadMs} ms`);
  }, 600_000);
});
