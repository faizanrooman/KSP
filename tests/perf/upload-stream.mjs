// End-to-end ingest throughput + media streaming concurrency against a running API AND worker.
//   node tests/perf/upload-stream.mjs upload --files a.mp4,b.mp4,... --concurrency 4 [--parallel-parts 4]
//   node tests/perf/upload-stream.mjs stream --evidence <id> --user perf.u00001 --levels 10,50,100
//   node tests/perf/upload-stream.mjs process --file clip.mp4 --user perf.u00001      (upload one file, time the pipeline)
// Upload = chunked PUTs with per-chunk SHA-256 (the real protocol), finalize = worker hash/probe/register;
// "registered" = evidence REGISTERED; "media ready" = proxy/HLS derivatives built (media_status READY).
import { createHash } from 'node:crypto';
import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { BASE, getJson, login, nextIp, run } from './lib.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const mode = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chunk(path, size, n) {
  const st = statSync(path).size;
  const start = (n - 1) * size;
  const len = Math.min(size, st - start);
  const buf = Buffer.alloc(len);
  const fd = openSync(path, 'r');
  try { readSync(fd, buf, 0, len, start); } finally { closeSync(fd); }
  return buf;
}

async function api(token, method, path, body, headers = {}) {
  const r = await fetch(`${BASE}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': nextIp(), ...(body && !Buffer.isBuffer(body) ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

let hashRetries = 0;
async function uploadOne(username, path, parallelParts) {
  hashRetries = 0;
  const token = await login(username);
  const me = await getJson('/api/v1/auth/me', token);
  const size = statSync(path).size;
  const t0 = Date.now();
  const init = await api(token, 'POST', '/api/v1/uploads', { orgUnitId: me.user.homeOrgUnit.id, filename: basename(path), size, metadata: { title: `perf upload ${basename(path)}` } });
  const queue = Array.from({ length: init.totalChunks }, (_, i) => i + 1);
  await Promise.all(Array.from({ length: parallelParts }, async () => {
    for (let n = queue.shift(); n !== undefined; n = queue.shift()) {
      const buf = chunk(path, init.chunkSize, n);
      // Retry like the real clients do when the server reports a corrupted chunk (counted: see hashRetries).
      for (let attempt = 0; ; attempt++) {
        try {
          await api(token, 'PUT', `/api/v1/uploads/${init.id}/parts/${n}`, buf, { 'content-type': 'application/octet-stream', 'x-chunk-sha256': createHash('sha256').update(buf).digest('hex') });
          break;
        } catch (e) {
          if (attempt >= 5 || !String(e.message).includes('CHUNK_HASH_MISMATCH')) throw e;
          hashRetries++;
        }
      }
    }
  }));
  const tUp = Date.now();
  await api(token, 'POST', `/api/v1/uploads/${init.id}/complete`);
  const tComplete = Date.now();
  let view;
  for (;;) {
    view = await api(token, 'GET', `/api/v1/uploads/${init.id}`);
    if (view.evidence && ['REGISTERED', 'QUARANTINED', 'REJECTED'].includes(view.evidence.status)) break;
    await sleep(250);
  }
  const tReg = Date.now();
  let media = null;
  if (view.evidence.status === 'REGISTERED') {
    for (let i = 0; i < 7200; i++) {
      const pb = await api(token, 'GET', `/api/v1/media/evidence/${view.evidence.id}/playback`);
      if (pb.mediaStatus === 'READY' || pb.mediaStatus === 'FAILED' || pb.mediaStatus === 'UNSUPPORTED') { media = pb.mediaStatus; break; }
      await sleep(500);
    }
  }
  const tMedia = Date.now();
  return { username, file: basename(path), sizeMB: +(size / 1048576).toFixed(1), chunks: init.totalChunks, uploadS: (tUp - t0) / 1000, completeS: (tComplete - tUp) / 1000,
    finalizeS: (tReg - tComplete) / 1000, mediaS: (tMedia - tReg) / 1000, status: view.evidence.status, media, hashRetries, evidenceId: view.evidence.id, uploadMBps: +(size / 1048576 / ((tUp - t0) / 1000)).toFixed(1), ingestMBps: +(size / 1048576 / ((tReg - t0) / 1000)).toFixed(1) };
}

if (mode === 'upload' || mode === 'process') {
  const files = (arg('files') ?? arg('file')).split(',');
  const conc = Number(arg('concurrency', '1'));
  const pp = Number(arg('parallel-parts', '4'));
  const user0 = Number(arg('user-offset', '1'));
  const t0 = Date.now();
  const results = [];
  const q = files.map((f, i) => ({ f, u: `perf.u${String(user0 + i).padStart(5, '0')}` }));
  await Promise.all(Array.from({ length: conc }, async () => {
    for (let it = q.shift(); it; it = q.shift()) { const r = await uploadOne(arg('user') ?? it.u, it.f, pp); console.log(JSON.stringify(r)); results.push(r); }
  }));
  const wall = (Date.now() - t0) / 1000;
  const mb = results.reduce((s, r) => s + r.sizeMB, 0);
  const lastReg = Math.max(...results.map((r) => r.uploadS + r.completeS + r.finalizeS));
  console.log(JSON.stringify({ summary: true, files: results.length, concurrency: conc, parallelParts: pp, totalMB: +mb.toFixed(1), wallS: wall, aggregateUploadMBps: +(mb / Math.max(...results.map((r) => r.uploadS))).toFixed(1), aggregateIngestMBps: +(mb / lastReg).toFixed(1) }));
} else if (mode === 'stream') {
  const token = await login(arg('user'));
  const pb = await getJson(`/api/v1/media/evidence/${arg('evidence')}/playback`, token);
  if (!pb.mp4Url) throw new Error(`not playable: ${pb.mediaStatus}`);
  const master = await (await fetch(`${BASE}${pb.hlsUrl}`)).text();
  const variant = master.split('\n').find((l) => l && !l.startsWith('#'));
  const base = pb.hlsUrl.split('?')[0].replace(/[^/]+$/, '');
  const index = await (await fetch(`${BASE}${base}${variant}`)).text();
  const seg = index.split('\n').find((l) => l && !l.startsWith('#'));
  const segUrl = `${base}${variant.replace(/[^/]+\?.*$/, '')}${seg}`;
  const probe = await fetch(`${BASE}${pb.mp4Url}`, { headers: { range: 'bytes=0-0' } });
  const total = Number(probe.headers.get('content-range')?.split('/')[1] ?? 0);
  await probe.arrayBuffer();
  const span = Math.max(1, total - 262144);
  console.log(`proxy ${total} bytes; segment ${segUrl.split('?')[0]}`);
  const levels = arg('levels', '10,50,100').split(',').map(Number);
  for (const c of levels) {
    await run('stream:hls-segment', { connections: c, requests: [{ method: 'GET', path: segUrl }] });
    await run('stream:proxy-range-1MiB', { connections: c, requests: [{ method: 'GET', path: pb.mp4Url, headers: { range: 'bytes=0-1048575' } }] });
    await run('stream:proxy-range-random', { connections: c, requests: [{ method: 'GET', path: pb.mp4Url, setup: (req, n) => ({ ...req, headers: { ...req.headers, range: `bytes=${(n * 7919 * 4096) % span}-${((n * 7919 * 4096) % span) + 262143}` } }) }] });
  }
} else {
  console.error('usage: upload|process|stream');
  process.exit(2);
}
