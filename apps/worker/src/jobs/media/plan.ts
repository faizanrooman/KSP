/**
 * Pure planning helpers for the media pipeline (no I/O): output geometry, frame rate / GOP, HLS ladder,
 * sprite layout and WebVTT generation. Kept separate so they are unit-testable without FFmpeg.
 */
import type { ProbeResult, ProbeStream } from '@ksp/core';

export const PROXY_MAX_LONG_SIDE = 1280;
export const HLS_SEGMENT_SECONDS = 4;
export const THUMB_WIDTH = 320;
export const SPRITE_TILE_WIDTH = 160;
export const SPRITE_COLUMNS = 10;
export const SPRITE_ROWS = 10;
/** Upper bound on sprite tiles per evidence item (sets the sampling interval for long recordings). */
export const SPRITE_MAX_TILES = 1000;

export interface SourceInfo {
  video: ProbeStream;
  audio: ProbeStream | null;
  /** Display dimensions after rotation and sample-aspect-ratio correction. */
  displayWidth: number;
  displayHeight: number;
  rotation: number;
  durationMs: number;
  /** Nominal rate (r_frame_rate) and average rate (avg_frame_rate). */
  rFps: number | null;
  avgFps: number | null;
  vfr: boolean;
}

export function parseRational(v?: string): number | null {
  if (!v) return null;
  const [n, d] = v.split('/').map(Number);
  if (!Number.isFinite(n) || !n) return null;
  const den = d === undefined ? 1 : d;
  if (!den) return null;
  return n / den;
}

function rotationOf(s: ProbeStream): number {
  const tag = s.tags?.rotate ? Number(s.tags.rotate) : NaN;
  if (Number.isFinite(tag)) return ((tag % 360) + 360) % 360;
  for (const sd of s.side_data_list ?? []) {
    const r = Number((sd as { rotation?: unknown }).rotation);
    if (Number.isFinite(r)) return ((Math.round(r) % 360) + 360) % 360;
  }
  return 0;
}

/** Streams that are really cover art / thumbnails, not video. */
function isAttachedPic(s: ProbeStream): boolean {
  const d = (s as { disposition?: { attached_pic?: number } }).disposition;
  return d?.attached_pic === 1 || (['png', 'mjpeg', 'bmp'].includes(s.codec_name ?? '') && s.nb_frames === '1');
}

/** Interpret a probe result. Returns null when there is no decodable video stream (audio-only, data). */
export function analyseSource(p: ProbeResult, fallbackDurationMs?: number | null): SourceInfo | null {
  const video = p.streams.find((s) => s.codec_type === 'video' && !isAttachedPic(s) && (s.width ?? 0) > 0 && (s.height ?? 0) > 0);
  if (!video) return null;
  const audio = p.streams.find((s) => s.codec_type === 'audio') ?? null;
  const rotation = rotationOf(video);
  let w = video.width!;
  let h = video.height!;
  const sar = parseRational((video as { sample_aspect_ratio?: string }).sample_aspect_ratio?.replace(':', '/'));
  if (sar && sar > 0 && Math.abs(sar - 1) > 0.01) w = Math.round(w * sar);
  if (rotation === 90 || rotation === 270) [w, h] = [h, w];
  const durSec = Number(p.format.duration ?? video.duration ?? NaN);
  const durationMs = Number.isFinite(durSec) && durSec > 0 ? Math.round(durSec * 1000) : (fallbackDurationMs ?? 0);
  const rFps = parseRational(video.r_frame_rate);
  const avgFps = parseRational(video.avg_frame_rate);
  const vfr = !!(rFps && avgFps && Math.abs(rFps - avgFps) / rFps > 0.02);
  return { video, audio, displayWidth: w, displayHeight: h, rotation, durationMs, rFps, avgFps, vfr };
}

export interface RatePlan {
  /** Output frame rate for the CFR proxy / HLS, as an FFmpeg rate string. */
  rate: string;
  fps: number;
  /** Keyframe interval in frames: floor(fps) so that the interval is always <= 1 s. */
  gop: number;
}

const sane = (v: number | null): v is number => v !== null && Number.isFinite(v) && v >= 1 && v <= 240;

/**
 * CFR output rate. For constant-rate sources the nominal rate is kept exactly (e.g. 30000/1001). For
 * variable-frame-rate sources (common on phones/body cameras) the proxy is resampled to CFR at the average
 * rate, rounded to 3 decimals, so that frame numbers are well defined; timestamps (not frame numbers) are
 * the canonical link back to the original. Capped at 60 fps.
 */
export function planRate(src: SourceInfo): RatePlan {
  let fps: number;
  let rate: string;
  if (!src.vfr && sane(src.rFps)) {
    fps = src.rFps;
    rate = src.video.r_frame_rate!;
  } else if (sane(src.avgFps)) {
    fps = Math.round(src.avgFps * 1000) / 1000;
    rate = String(fps);
  } else if (sane(src.rFps)) {
    fps = src.rFps;
    rate = src.video.r_frame_rate!;
  } else {
    fps = 25;
    rate = '25';
  }
  if (fps > 60) {
    fps = 60;
    rate = '60';
  }
  return { rate, fps, gop: Math.max(1, Math.floor(fps + 1e-6)) };
}

const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

/** Fit display dims so the LONG side is at most `maxLong` (landscape: max width; portrait: max height). Never upscales. */
export function fitLongSide(w: number, h: number, maxLong: number): { width: number; height: number } {
  const long = Math.max(w, h);
  const k = long > maxLong ? maxLong / long : 1;
  return { width: even(w * k), height: even(h * k) };
}

/** Fit to a given short-side size (HLS rung), never upscaling. */
export function fitShortSide(w: number, h: number, short: number): { width: number; height: number } {
  const s = Math.min(w, h);
  const k = s > short ? short / s : 1;
  return { width: even(w * k), height: even(h * k) };
}

export function fitWidth(w: number, h: number, width: number): { width: number; height: number } {
  return { width: even(width), height: even((h * width) / w) };
}

export interface Rendition {
  name: string;
  width: number;
  height: number;
  maxrateKbps: number;
}

/**
 * HLS ladder by short side: 360p and 720p, plus 1080p when the source is >= 1080. Rungs above the source
 * resolution are dropped (no upscaling); tiny sources get a single native-size rung.
 */
export function planLadder(src: SourceInfo): Rendition[] {
  const short = Math.min(src.displayWidth, src.displayHeight);
  const rungs: Array<[string, number, number]> = [
    ['360p', 360, 900],
    ['720p', 720, 3000],
    ['1080p', 1080, 6000],
  ];
  const out: Rendition[] = [];
  for (const [name, s, kbps] of rungs) {
    if (s !== 360 && short < s) continue;
    const dim = fitShortSide(src.displayWidth, src.displayHeight, s);
    // Named by the rendition's actual short side (a 320x240 source yields a single "240p" rung).
    out.push({ name: short >= s ? name : `${Math.min(dim.width, dim.height)}p`, ...dim, maxrateKbps: kbps });
  }
  return out;
}

export interface SpritePlan {
  intervalSec: number;
  tileWidth: number;
  tileHeight: number;
  columns: number;
  rows: number;
  tiles: number;
  sheets: number;
}

export function planSprite(durationMs: number, w: number, h: number): SpritePlan {
  const durSec = Math.max(0.001, durationMs / 1000);
  const intervalSec = Math.max(1, Math.ceil(durSec / SPRITE_MAX_TILES));
  const tiles = Math.max(1, Math.ceil(durSec / intervalSec));
  const { width, height } = fitWidth(w, h, SPRITE_TILE_WIDTH);
  return { intervalSec, tileWidth: width, tileHeight: height, columns: SPRITE_COLUMNS, rows: SPRITE_ROWS, tiles, sheets: Math.ceil(tiles / (SPRITE_COLUMNS * SPRITE_ROWS)) };
}

export function vttTime(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3_600_000);
  const m = Math.floor((t % 3_600_000) / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  const milli = t % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(milli).padStart(3, '0')}`;
}

export const spriteSheetName = (i: number) => `sprite_${String(i).padStart(3, '0')}.jpg`;

/** WebVTT thumbnail track: one cue per tile, `sprite_NNN.jpg#xywh=x,y,w,h` (relative to the VTT URL). */
export function buildSpriteVtt(plan: SpritePlan, durationMs: number, sheetsProduced: number): string {
  const per = plan.columns * plan.rows;
  const lines = ['WEBVTT', ''];
  const tiles = Math.min(plan.tiles, sheetsProduced * per);
  for (let k = 0; k < tiles; k++) {
    const start = k * plan.intervalSec * 1000;
    if (start >= durationMs && k > 0) break;
    const end = Math.min(durationMs, (k + 1) * plan.intervalSec * 1000);
    const sheet = Math.floor(k / per);
    const idx = k % per;
    const x = (idx % plan.columns) * plan.tileWidth;
    const y = Math.floor(idx / plan.columns) * plan.tileHeight;
    lines.push(`${vttTime(start)} --> ${vttTime(Math.max(end, start + 1))}`, `${spriteSheetName(sheet)}#xywh=${x},${y},${plan.tileWidth},${plan.tileHeight}`, '');
  }
  return lines.join('\n');
}

/**
 * Processing timeout proportional to the media duration: a fixed allowance plus `factor` x real time.
 * (veryfast x264 runs many times faster than real time on a server core; the factor is a safety margin
 * for slow decoders such as HEVC/MJPEG at high resolution.)
 */
export function timeoutFor(durationMs: number, factor: number, baseMs = 120_000): number {
  return Math.round(baseMs + Math.max(0, durationMs) * factor);
}

/** stderr fragments that mean the input itself cannot be decoded (retrying will not help). */
const UNDECODABLE = [
  /Invalid data found when processing input/i,
  /moov atom not found/i,
  /could not find codec parameters/i,
  /Decoder \(codec [^)]*\) not found/i,
  /Unsupported codec/i,
  /Output file (?:#\d+ )?does not contain any stream/i,
  /Output file is empty, nothing was encoded/i,
  /does not contain any stream/i,
  /Invalid argument/i,
  /no frame!/i,
  /Error while decoding stream/i,
];
export function looksUndecodable(stderr: string): boolean {
  if (/Connection (refused|reset|timed out)|Server returned 5\d\d|HTTP error 5\d\d|I\/O error|Input\/output error|No space left/i.test(stderr)) return false;
  return UNDECODABLE.some((r) => r.test(stderr));
}
