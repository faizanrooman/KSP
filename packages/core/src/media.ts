/** FFmpeg / ffprobe process wrappers (no shell; arguments passed as arrays to prevent injection). */
import { spawn } from 'node:child_process';
import { loadConfig } from './config.js';

export interface ProbeStream {
  index: number;
  codec_type: 'video' | 'audio' | 'subtitle' | 'data' | string;
  codec_name?: string;
  codec_long_name?: string;
  profile?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  nb_frames?: string;
  duration?: string;
  bit_rate?: string;
  pix_fmt?: string;
  sample_rate?: string;
  channels?: number;
  tags?: Record<string, string>;
  side_data_list?: Array<Record<string, unknown>>;
}
export interface ProbeResult {
  format: {
    format_name: string;
    format_long_name?: string;
    duration?: string;
    size?: string;
    bit_rate?: string;
    nb_streams?: number;
    tags?: Record<string, string>;
  };
  streams: ProbeStream[];
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runProcess(
  bin: string,
  args: string[],
  opts: { timeoutMs?: number; onStderr?: (line: string) => void; signal?: AbortSignal; maxBuffer?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], signal: opts.signal });
    const max = opts.maxBuffer ?? 64 * 1024 * 1024;
    let stdout = '';
    let stderr = '';
    const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs) : undefined;
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < max) stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      const s = d.toString();
      if (stderr.length < 1024 * 1024) stderr += s;
      if (opts.onStderr) for (const line of s.split(/\r|\n/)) if (line) opts.onStderr(line);
    });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * Demuxers allowed to open evidence media (short names of the containers in SUPPORTED_CONTAINERS). Passed as
 * `-format_whitelist` so reference-following demuxers (hls, concat, image2 sequences, …) are never selected for
 * an uploaded file, whatever its extension or HTTP content type (SSRF / local file read via crafted playlists).
 */
export const MEDIA_FORMAT_WHITELIST = 'mov,matroska,avi,mpegts,asf,flv,mpeg';

/** ffprobe a local path or an internal (presigned, never client-visible) URL. */
export async function probe(input: string, timeoutMs = 120_000): Promise<ProbeResult> {
  const cfg = loadConfig();
  const res = await runProcess(
    cfg.FFPROBE_PATH,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-protocol_whitelist', 'file,http,https,tcp,tls', '-format_whitelist', MEDIA_FORMAT_WHITELIST, input],
    { timeoutMs },
  );
  if (res.code !== 0) throw new MediaError('PROBE_FAILED', res.stderr.trim().slice(0, 2000) || `ffprobe exited ${res.code}`);
  const parsed = JSON.parse(res.stdout) as ProbeResult;
  if (!parsed.format) throw new MediaError('PROBE_FAILED', 'no container format detected');
  return parsed;
}

export async function ffmpeg(
  args: string[],
  opts: { timeoutMs?: number; durationMs?: number; onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<RunResult> {
  const cfg = loadConfig();
  const res = await runProcess(cfg.FFMPEG_PATH, ['-hide_banner', '-nostdin', '-y', ...args], {
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    onStderr: (line) => {
      if (!opts.onProgress || !opts.durationMs) return;
      const m = /time=(\d+):(\d+):(\d+\.\d+)/.exec(line);
      if (m) {
        const ms = (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000;
        opts.onProgress(Math.min(1, ms / opts.durationMs));
      }
    },
  });
  if (res.code !== 0) throw new MediaError('FFMPEG_FAILED', res.stderr.trim().split('\n').slice(-8).join('\n'));
  return res;
}

export class MediaError extends Error {
  constructor(
    readonly code: 'PROBE_FAILED' | 'FFMPEG_FAILED' | 'UNSUPPORTED' | 'CORRUPT' | 'NO_VIDEO',
    message: string,
  ) {
    super(message);
    this.name = 'MediaError';
  }
}

/** "30000/1001" -> 29.97 */
export function parseRate(rate?: string): number | null {
  if (!rate) return null;
  const [n, d] = rate.split('/').map(Number);
  if (!n || !d) return null;
  return Math.round((n / d) * 10000) / 10000;
}

/**
 * Parse ISO-6709 location strings found in MP4/MOV tags, e.g. "+12.9716+077.5946+920.000/".
 */
export function parseIso6709(v?: string): { lat: number; lon: number } | null {
  if (!v) return null;
  const m = /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/.exec(v.trim());
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}
