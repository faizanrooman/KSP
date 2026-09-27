/**
 * npm run media:benchmark -w @ksp/worker -- --file <clip> [--encoder libx264|h264_nvenc|h264_qsv|h264_vaapi] [--vcpus 4] [--runs 1]
 *
 * Measures the CPU cost of each media-pipeline phase on a local clip with the SAME FFmpeg argument builders the worker
 * uses (proxy MP4, HLS ladder, poster + thumbnail, sprite sheets), via `ffmpeg -benchmark` (user + sys CPU seconds
 * of the encoder process), and derives the worker count per 1,000 footage-hours/day for each MEDIA_PROFILE
 * (docs/INFRASTRUCTURE.md#transcoding-capacity). Nothing is uploaded; no database access.
 */
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { cpus } from 'node:os';
import { ffmpeg, loadConfig, probe } from '@ksp/core';
import { hlsArgs, proxyArgs } from '../jobs/media/process.js';
import { resolveEncoder } from '../jobs/media/encoder.js';
import { analyseSource, fitLongSide, fitWidth, planLadder, planRate, planSprite, PROXY_MAX_LONG_SIDE, THUMB_WIDTH } from '../jobs/media/plan.js';

const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const file = arg('file');
if (!file) {
  console.error('usage: media-benchmark --file <clip> [--encoder libx264] [--vcpus 4] [--runs 1]');
  process.exit(2);
}
const vcpus = Number(arg('vcpus', '4'));
const runs = Math.max(1, Number(arg('runs', '1')));
const cfg = loadConfig();
if (arg('encoder')) cfg.MEDIA_ENCODER = arg('encoder') as typeof cfg.MEDIA_ENCODER;

interface Phase { cpu: number; wall: number }
async function bench(args: string[]): Promise<Phase> {
  const t0 = Date.now();
  const r = await ffmpeg(['-benchmark', ...args], { timeoutMs: 6 * 3600_000 });
  const m = /bench: utime=([\d.]+)s stime=([\d.]+)s rtime=([\d.]+)s/.exec(r.stderr);
  if (!m) throw new Error('ffmpeg -benchmark output not found');
  return { cpu: Number(m[1]) + Number(m[2]), wall: (Date.now() - t0) / 1000 };
}

const work = join(cfg.WORK_DIR, `bench-${process.pid}`);
await mkdir(work, { recursive: true });
try {
  const src = analyseSource(await probe(file))!;
  const rate = planRate(src);
  const enc = await resolveEncoder(cfg, { warn: (o, m) => console.warn(m, o), info: () => undefined });
  const pdim = fitLongSide(src.displayWidth, src.displayHeight, PROXY_MAX_LONG_SIDE);
  const ladder = planLadder(src);
  const totals: Record<string, Phase> = { proxy: { cpu: 0, wall: 0 }, hls: { cpu: 0, wall: 0 }, stills: { cpu: 0, wall: 0 }, sprite: { cpu: 0, wall: 0 } };
  const add = (k: string, p: Phase) => { totals[k]!.cpu += p.cpu / runs; totals[k]!.wall += p.wall / runs; };
  for (let run = 0; run < runs; run++) {
    const proxy = join(work, 'proxy.mp4');
    add('proxy', await bench(proxyArgs(file, src, rate, pdim, proxy, enc)));
    const hlsDir = join(work, 'hls');
    await rm(hlsDir, { recursive: true, force: true });
    for (const r of ladder) await mkdir(join(hlsDir, r.name), { recursive: true });
    add('hls', await bench(hlsArgs(file, src, rate, ladder, hlsDir, enc)));
    const at = (src.durationMs * 0.1) / 1000;
    const tdim = fitWidth(pdim.width, pdim.height, THUMB_WIDTH);
    const s1 = await bench(['-ss', at.toFixed(3), '-i', proxy, '-frames:v', '1', '-q:v', '2', join(work, 'poster.jpg')]);
    const s2 = await bench(['-ss', at.toFixed(3), '-i', proxy, '-frames:v', '1', '-vf', `scale=${tdim.width}:${tdim.height}`, '-q:v', '3', join(work, 'thumb.jpg')]);
    add('stills', { cpu: s1.cpu + s2.cpu, wall: s1.wall + s2.wall });
    const sp = planSprite(src.durationMs, pdim.width, pdim.height);
    const spDir = join(work, 'sprite');
    await rm(spDir, { recursive: true, force: true });
    await mkdir(spDir, { recursive: true });
    add('sprite', await bench(['-skip_frame', 'nokey', '-i', proxy, '-an', '-vf', `fps=1/${sp.intervalSec}:round=near,scale=${sp.tileWidth}:${sp.tileHeight},tile=${sp.columns}x${sp.rows}`, '-fps_mode', 'passthrough', '-q:v', '5', '-start_number', '0', join(spDir, 'sprite_%03d.jpg')]));
    void (await readdir(spDir));
  }
  const durSec = src.durationMs / 1000;
  const perFootageSec = (k: string[]) => k.reduce((n, x) => n + totals[x]!.cpu, 0) / durSec;
  const profiles: Record<string, string[]> = { full: ['proxy', 'hls', 'stills', 'sprite'], 'proxy-only': ['proxy', 'stills', 'sprite'], 'hls-on-play': ['hls'] };
  // Workers of `vcpus` vCPUs at 70 % sustained utilisation per 1,000 footage-hours/day.
  const workersPer1000 = (cpuPerSec: number) => (cpuPerSec * 1000 * 3600) / 86_400 / (vcpus * 0.7);
  const result = {
    clip: { file, durationSec: durSec, width: src.displayWidth, height: src.displayHeight, fps: rate.fps, ladder: ladder.map((r) => r.name) },
    host: { cpus: cpus().length, model: cpus()[0]?.model ?? 'unknown' },
    encoder: enc,
    runs,
    phases: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, { cpuSeconds: +v.cpu.toFixed(1), wallSeconds: +v.wall.toFixed(1), cpuSecondsPerFootageSecond: +(v.cpu / durSec).toFixed(3) }])),
    profiles: Object.fromEntries(Object.entries(profiles).map(([p, ks]) => [p, { cpuSecondsPerFootageSecond: +perFootageSec(ks).toFixed(3), workersPer1000FootageHoursPerDay: +workersPer1000(perFootageSec(ks)).toFixed(1), vcpusPerWorker: vcpus }])),
  };
  console.log(JSON.stringify(result, null, 2));
} finally {
  await rm(work, { recursive: true, force: true });
}
