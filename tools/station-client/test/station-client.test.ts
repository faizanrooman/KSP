/**
 * Station client integration test: real API listening on an ephemeral port, real ingest worker consuming
 * the real queue, real Postgres/S3/FFmpeg. Drives the CLI entry point and the upload engine.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { loadConfig, runProcess, stopQueue } from '@ksp/core';
import { buildApp } from '../../../apps/api/src/app.js';
import { startWorker } from '../../../apps/worker/src/main.js';
import type { WorkerContext } from '../../../apps/worker/src/lib/context.js';
import { main, type CliIO } from '../src/cli.js';
import { KspClient } from '../src/client.js';
import { collectFiles, uploadFiles } from '../src/uploader.js';

const PASSWORD = 'Ksp@Dev-Passw0rd!';
const dir = join(process.env.KSP_TEST_TMP ?? tmpdir(), `ksp-station-client-${process.pid}`);
let app: FastifyInstance;
let worker: WorkerContext;
let server: string;

async function video(name: string, seconds: number, extra: string[] = []): Promise<string> {
  const out = join(dir, name);
  const res = await runProcess(loadConfig().FFMPEG_PATH, [
    '-hide_banner', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-t', String(seconds), ...extra,
    '-c:v', 'libx264', '-preset', 'ultrafast', out,
  ]);
  if (res.code !== 0) throw new Error(res.stderr);
  return out;
}

function io(lines: string[]): CliIO {
  return { out: (s) => lines.push(s), err: (s) => lines.push(`ERR ${s}`), prompt: async () => { throw new Error('no prompt expected'); }, env: { KSP_PASSWORD: PASSWORD } };
}

beforeAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'batch', 'cam2'), { recursive: true });
  app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  server = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  worker = await startWorker(['ingest']);
});

afterAll(async () => {
  await worker?.boss.offWork('ingest.finalize').catch(() => undefined);
  await app?.close();
  await stopQueue();
  await worker?.db.destroy();
});

describe('ksp-upload', () => {
  it('uploads a folder (recursive, sidecar metadata), waits for registration and prints a summary', async () => {
    const a = await video('batch/clip-a.mp4', 2);
    await video('batch/cam2/clip-b.mov', 3, ['-vf', 'hflip']);
    writeFileSync(`${a}.json`, JSON.stringify({ title: 'Sidecar title A', category: 'TRAFFIC', officerBadge: 'KSP-FO-1001', ignored: 'x' }));
    writeFileSync(join(dir, 'batch', 'notes.txt'), 'not a video');
    const lines: string[] = [];
    const statePath = join(dir, 'state.json');
    const { code, results } = await main(['--server', server, '--username', 'op.cubbon', '--station', 'ps_cubbonpark', '--label', 'CLI test', '--state', statePath, '--poll-interval', '300', join(dir, 'batch')], io(lines));
    const output = lines.join('\n');
    expect(code, output).toBe(0);
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.status, output).toBe('REGISTERED');
      expect(r.evidenceNumber).toMatch(/^KSP-PSCUBBONPARK-\d{4}-\d{6}$/);
    }
    expect(output).toMatch(/Evidence #/);
    expect(output).toMatch(/2 registered, 0 quarantined/);
    const ev = await app.db.selectFrom('evidence').select(['title', 'category', 'officer_id']).where('id', '=', results.find((r) => r.path.endsWith('clip-a.mp4'))!.evidenceId!).executeTakeFirstOrThrow();
    expect(ev.title).toBe('Sidecar title A');
    expect(ev.category).toBe('TRAFFIC');
    expect(ev.officer_id).toBeTruthy();
    const batch = await app.db.selectFrom('upload_batches').select(['label', 'client_info']).where('label', '=', 'CLI test').executeTakeFirstOrThrow();
    expect((batch.client_info as { client: string }).client).toBe('ksp-station-client');

    // Re-running with the same state file does not upload anything again.
    const again: string[] = [];
    const second = await main(['--server', server, '--username', 'op.cubbon', '--station', 'ps_cubbonpark', '--state', statePath, '--no-wait', join(dir, 'batch')], io(again));
    expect(second.results.every((r) => r.partsSent === 0 && r.status === 'REGISTERED')).toBe(true);
    expect(again.join('\n')).toMatch(/already uploaded/);
  });

  it('resumes an interrupted multi-chunk upload from the server part list', async () => {
    const big = await video('big.mp4', 6, ['-vf', 'noise=alls=40:allf=t', '-crf', '16']);
    const client = new KspClient(server);
    await client.login({ username: 'op.cubbon', password: PASSWORD, totp: async () => '000000' });
    const org = await app.db.selectFrom('org_units').select('id').where('code', '=', 'ps_cubbonpark').executeTakeFirstOrThrow();
    const statePath = join(dir, 'resume-state.json');
    const { files } = await collectFiles([big]);
    let sent = 0;
    const opts = { orgUnitId: org.id, statePath, chunkSize: 5 * 1024 * 1024, partConcurrency: 1, baseDelayMs: 10 };
    const first = await uploadFiles(client, files, {
      ...opts,
      onPart: () => {
        if (++sent === 2) throw new Error('simulated network outage');
      },
    });
    expect(first[0]!.status).toBe('FAILED');
    const view = await client.get<{ receivedParts: number[]; totalChunks: number }>(`/uploads/${first[0]!.sessionId}`);
    expect(view.receivedParts).toEqual([1, 2]);
    expect(view.totalChunks).toBeGreaterThan(3);

    // Token refresh: force the access token to look expired; the client must rotate transparently.
    (client as unknown as { tokens: { accessExpiresAt: number } }).tokens.accessExpiresAt = Date.now();
    const second = await uploadFiles(client, files, { ...opts, waitMs: 60_000, pollIntervalMs: 300 });
    expect(second[0]!.resumed).toBe(true);
    expect(second[0]!.sessionId).toBe(first[0]!.sessionId);
    expect(second[0]!.partsSent).toBe(view.totalChunks - 2);
    expect(second[0]!.status).toBe('REGISTERED');
  });

  it('reports usage and login errors with exit code 2', async () => {
    const lines: string[] = [];
    expect((await main(['--server', server], io(lines))).code).toBe(2);
    const bad: CliIO = { ...io(lines), env: { KSP_PASSWORD: 'wrong-password' } };
    const a = await video('x.mp4', 1);
    expect((await main(['--server', server, '--username', 'op.cubbon', '--station', 'ps_cubbonpark', a], bad)).code).toBe(2);
    expect(lines.join('\n')).toMatch(/Login failed/);
  });
});
