/** Shared helpers for uploads*.test.ts: FFmpeg-generated fixtures, chunked upload driver, in-process finalize. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, openSync, readSync, closeSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pino from 'pino';
import { CHUNK_SHA256_HEADER } from '@ksp/shared';
import { loadConfig, runProcess, type IngestDeps } from '@ksp/core';
import type { FastifyInstance } from 'fastify';
import { handleFinalize } from '../../worker/src/jobs/ingest/handlers.js';
import type { Agent, Res } from './helpers.js';

export const FIXTURES = join(tmpdir(), `ksp-upload-fixtures-${process.pid}`);
mkdirSync(FIXTURES, { recursive: true });

export async function ffmpegFixture(name: string, args: string[]): Promise<string> {
  const out = join(FIXTURES, name);
  const res = await runProcess(loadConfig().FFMPEG_PATH, ['-hide_banner', '-nostdin', '-v', 'error', '-y', ...args, out], { timeoutMs: 300_000 });
  if (res.code !== 0) throw new Error(`ffmpeg fixture ${name} failed: ${res.stderr}`);
  return out;
}

/** ~26 MB H.264/AAC MP4 with creation_time + ISO-6709 location tags (multi-chunk at 5 MiB). */
export function validVideo(name = 'valid.mp4', extra: string[] = []): Promise<string> {
  return ffmpegFixture(name, [
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '6',
    '-vf', 'noise=alls=40:allf=t', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '16', '-c:a', 'aac',
    '-metadata', 'creation_time=2026-09-01T10:00:00Z', '-metadata', 'location=+12.9716+077.5946/', ...extra,
  ]);
}

/** Small clean clip (single chunk). `seed` changes the content so hashes differ. */
export function smallVideo(name: string, seed = 1, extra: string[] = []): Promise<string> {
  return ffmpegFixture(name, ['-f', 'lavfi', '-i', `testsrc2=size=320x240:rate=25`, '-t', String(2 + (seed % 5) * 0.2), '-c:v', 'libx264', '-preset', 'ultrafast', '-movflags', '+faststart', ...extra]);
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
export function sha512File(path: string): string {
  return createHash('sha512').update(readFileSync(path)).digest('hex');
}

export function readChunk(path: string, chunkSize: number, n: number): Buffer {
  const size = statSync(path).size;
  const start = (n - 1) * chunkSize;
  const len = Math.min(chunkSize, size - start);
  const buf = Buffer.alloc(len);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, len, start);
  } finally {
    closeSync(fd);
  }
  return buf;
}

export function putPart(agent: Agent, id: string, n: number, buf: Buffer, sha?: string): Promise<Res> {
  return agent.request('PUT', `/api/v1/uploads/${id}/parts/${n}`, {
    payload: buf,
    headers: { 'content-type': 'application/octet-stream', [CHUNK_SHA256_HEADER]: sha ?? createHash('sha256').update(buf).digest('hex') },
  });
}

export async function initUpload(agent: Agent, path: string, body: Record<string, unknown>): Promise<Res> {
  const size = statSync(path).size;
  return agent.post('/api/v1/uploads', { filename: path.split('/').pop(), size, chunkSize: 5 * 1024 * 1024, ...body });
}

/** Upload every part (optionally in a custom order), then complete. Returns the complete response. */
export async function uploadAll(agent: Agent, path: string, body: Record<string, unknown>, opts: { order?: 'reverse' | 'shuffle'; declareHash?: boolean } = {}): Promise<{ init: Res; complete: Res }> {
  const init = await initUpload(agent, path, { ...(opts.declareHash === false ? {} : { sha256: sha256File(path) }), ...body });
  if (init.status !== 201) throw new Error(`init failed ${init.status} ${init.raw}`);
  const { id, chunkSize, totalChunks } = init.body as { id: string; chunkSize: number; totalChunks: number };
  let order = Array.from({ length: totalChunks }, (_, i) => i + 1);
  if (opts.order === 'reverse') order = order.reverse();
  if (opts.order === 'shuffle') order = order.sort(() => Math.random() - 0.5);
  // 3 concurrent part uploads.
  const queue = [...order];
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      for (let n = queue.shift(); n !== undefined; n = queue.shift()) {
        const r = await putPart(agent, id, n, readChunk(path, chunkSize, n));
        if (r.status !== 200) throw new Error(`part ${n} failed ${r.status} ${r.raw}`);
      }
    }),
  );
  const complete = await agent.post(`/api/v1/uploads/${id}/complete`);
  return { init, complete };
}

const silent = pino({ level: 'silent' });

/** Run the real worker finalize handler in-process (same code the pg-boss consumer runs). */
export async function runFinalize(app: FastifyInstance, uploadSessionId: string, extra: Partial<IngestDeps> = {}) {
  return handleFinalize({ db: app.db, storage: app.storage, cfg: app.cfg, log: silent }, { id: `test-${uploadSessionId}-${Date.now()}`, data: { uploadSessionId }, retryCount: 0, retryLimit: 5 }, extra);
}

export async function orgId(app: FastifyInstance, code: string): Promise<string> {
  return (await app.db.selectFrom('org_units').select('id').where('code', '=', code).executeTakeFirstOrThrow()).id;
}

/** Ad-hoc role (not MFA-mandatory) for tests that need specific permissions. */
export async function ensureRole(app: FastifyInstance, code: string, permissions: string[]): Promise<void> {
  const existing = await app.db.selectFrom('roles').select('id').where('code', '=', code).executeTakeFirst();
  if (!existing) await app.db.insertInto('roles').values({ code, name: code, description: 'test role', permissions: permissions as never, is_system: false }).execute();
}

export function writeFixture(name: string, data: Buffer | string): string {
  const p = join(FIXTURES, name);
  writeFileSync(p, data);
  return p;
}
