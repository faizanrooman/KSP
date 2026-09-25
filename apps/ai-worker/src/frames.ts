/**
 * Frame sampling from the derived proxy: ffmpeg `fps` filter -> raw RGB24 frames on a pipe (back-pressured).
 * ffmpeg is spawned with an argument array (no shell), like @ksp/core ffmpeg(); core's helper buffers stdout as a
 * string so it cannot carry binary frames — this is the one streaming use (docs/AI-ARCHITECTURE.md).
 */
import { spawn } from 'node:child_process';
import { loadConfig, probe } from '@ksp/core';
import type { RgbImage } from './image.js';

export interface SampledFrame {
  index: number;
  timeMs: number;
  image: RgbImage;
}

export interface VideoInfo {
  width: number;
  height: number;
  durationMs: number;
  frameRate: number | null;
}

export async function videoInfo(path: string): Promise<VideoInfo> {
  const p = await probe(path);
  const v = p.streams.find((s) => s.codec_type === 'video');
  if (!v?.width || !v.height) throw new Error('proxy has no video stream');
  const rate = v.avg_frame_rate ?? v.r_frame_rate;
  let fr: number | null = null;
  if (rate) {
    const [n, d] = rate.split('/').map(Number);
    fr = n && d ? n / d : null;
  }
  // ffmpeg auto-rotates on decode: report display dimensions.
  const rot = Number((v.side_data_list ?? []).find((s) => 'rotation' in s)?.rotation ?? 0);
  const swap = Math.abs(rot) % 180 === 90;
  return { width: swap ? v.height : v.width, height: swap ? v.width : v.height, durationMs: Math.round(Number(p.format.duration ?? 0) * 1000), frameRate: fr };
}

/** Analysis resolution: long side capped at `maxSide`, even dimensions. */
export function analysisSize(w: number, h: number, maxSide = 1280): { width: number; height: number } {
  const r = Math.min(1, maxSide / Math.max(w, h));
  return { width: Math.max(2, Math.round((w * r) / 2) * 2), height: Math.max(2, Math.round((h * r) / 2) * 2) };
}

export async function* sampleFrames(path: string, opts: { fps: number; width: number; height: number; signal?: AbortSignal }): AsyncGenerator<SampledFrame> {
  const cfg = loadConfig();
  const args = [
    '-hide_banner', '-nostdin', '-v', 'error', '-i', path, '-an', '-sn', '-dn',
    '-vf', `fps=${opts.fps},scale=${opts.width}:${opts.height}:flags=bilinear`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ];
  const child = spawn(cfg.FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => {
    if (stderr.length < 8192) stderr += d.toString();
  });
  const exited = new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? -1));
  });
  const onAbort = () => child.kill('SIGKILL');
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const frameBytes = opts.width * opts.height * 3;
  let buf: Buffer = Buffer.alloc(0);
  let index = 0;
  try {
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (buf.length >= frameBytes) {
        const data = new Uint8Array(buf.subarray(0, frameBytes));
        buf = buf.subarray(frameBytes);
        yield { index, timeMs: Math.round((index * 1000) / opts.fps), image: { width: opts.width, height: opts.height, data } };
        index++;
        if (opts.signal?.aborted) return;
      }
    }
    const code = await exited;
    if (code !== 0 && !opts.signal?.aborted) throw new Error(`ffmpeg frame sampling failed (${code}): ${stderr.trim().split('\n').slice(-3).join(' ')}`);
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}
