/**
 * Media validation + technical metadata extraction for ingestion. Never trusts extension or declared MIME:
 * everything is decided from ffprobe output and an actual decode of the first and last seconds.
 */
import { SUPPORTED_CONTAINERS, SUPPORTED_VIDEO_CODECS, type QuarantineReason } from '@ksp/shared';
import { loadConfig } from '../config.js';
import { MEDIA_FORMAT_WHITELIST, MediaError, parseIso6709, parseRate, probe, runProcess, type ProbeResult, type ProbeStream } from '../media.js';

/** Protocols ffprobe/ffmpeg may open while inspecting untrusted uploads (no concat/data/pipe/subfile…). */
export const INSPECT_PROTOCOLS = 'file,http,https,tcp,tls';
const DECODE_WINDOW_SECONDS = 5;

export interface ExtractedMetadata {
  durationMs: number;
  containerFormat: string;
  mimeType: string;
  videoCodec: string;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  bitRate: number | null;
  creationTime: Date | null;
  gps: { lat: number; lon: number; tag: string } | null;
  deviceMetadata: Record<string, string>;
}

export type InspectOutcome =
  | { ok: true; probe: ProbeResult; meta: ExtractedMetadata }
  | { ok: false; code: QuarantineReason; message: string; probe: ProbeResult | null; meta: ExtractedMetadata | null };

const MIME_BY_FORMAT: Array<[RegExp, string]> = [
  [/^mov,mp4/, 'video/mp4'],
  [/^matroska,webm/, 'video/x-matroska'],
  [/^avi$/, 'video/x-msvideo'],
  [/^mpegts$/, 'video/mp2t'],
  [/^asf$/, 'video/x-ms-asf'],
  [/^flv$/, 'video/x-flv'],
  [/^mpeg$/, 'video/mpeg'],
];

function isAttachedPicture(s: ProbeStream): boolean {
  const d = (s as unknown as { disposition?: Record<string, number> }).disposition;
  return !!d && d.attached_pic === 1;
}

function lowerTags(...sources: Array<Record<string, string> | undefined>): Map<string, string> {
  const m = new Map<string, string>();
  for (const t of sources) for (const [k, v] of Object.entries(t ?? {})) if (!m.has(k.toLowerCase())) m.set(k.toLowerCase(), String(v));
  return m;
}

const GPS_TAGS = ['com.apple.quicktime.location.iso6709', 'location', 'location-eng', 'com.android.location', 'gps', 'geo'];
const DEVICE_TAG = /(make|model|serial|firmware|encoder|software|manufacturer|device|camera|vendor|officer|unit_id|badge)/i;

function validDate(v: string | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  // Containers commonly carry epoch/zero defaults (1904/1970) when the camera clock was unset.
  if (d.getUTCFullYear() < 1990 || d.getTime() > Date.now() + 86_400_000) return null;
  return d;
}

export function extractMetadata(p: ProbeResult): ExtractedMetadata | null {
  const video = p.streams.find((s) => s.codec_type === 'video' && !isAttachedPicture(s));
  if (!video) return null;
  const audio = p.streams.find((s) => s.codec_type === 'audio');
  const dur = Number(p.format.duration ?? video.duration ?? NaN);
  const tags = lowerTags(p.format.tags, video.tags);
  let gps: ExtractedMetadata['gps'] = null;
  for (const t of GPS_TAGS) {
    const parsed = parseIso6709(tags.get(t));
    if (parsed) {
      gps = { ...parsed, tag: t };
      break;
    }
  }
  const deviceMetadata: Record<string, string> = {};
  for (const [k, v] of tags) if (DEVICE_TAG.test(k) && !/location/i.test(k)) deviceMetadata[k] = v.slice(0, 256);
  const fmt = p.format.format_name;
  return {
    durationMs: Number.isFinite(dur) ? Math.round(dur * 1000) : 0,
    containerFormat: fmt,
    mimeType: MIME_BY_FORMAT.find(([re]) => re.test(fmt))?.[1] ?? 'application/octet-stream',
    videoCodec: video.codec_name ?? 'unknown',
    audioCodec: audio?.codec_name ?? null,
    width: video.width ?? null,
    height: video.height ?? null,
    frameRate: parseRate(video.avg_frame_rate) ?? parseRate(video.r_frame_rate),
    bitRate: p.format.bit_rate ? Number(p.format.bit_rate) || null : null,
    creationTime: validDate(tags.get('creation_time') ?? tags.get('com.apple.quicktime.creationdate') ?? tags.get('date')),
    gps,
    deviceMetadata,
  };
}

/**
 * Tool output quotes the input (an internal presigned URL). Messages end up in status_reason and audit
 * details that users see, so strip the input and any URL before storing them.
 */
export function scrubToolMessage(msg: string, input: string): string {
  return msg.split(input).join('<staged-object>').replace(/\b(?:https?|tcp|tls):\/\/\S+/gi, '<url>');
}

/** Decode a window of the input; returns error text when the decoder reports corruption, null when clean. */
async function decodeWindow(input: string, window: 'head' | 'tail' | 'all', timeoutMs: number): Promise<string | null> {
  const cfg = loadConfig();
  const pos = window === 'head' ? ['-t', String(DECODE_WINDOW_SECONDS)] : window === 'tail' ? ['-sseof', `-${DECODE_WINDOW_SECONDS}`] : [];
  const args = [
    '-hide_banner', '-nostdin', '-v', 'error', '-xerror',
    '-protocol_whitelist', INSPECT_PROTOCOLS,
    '-format_whitelist', MEDIA_FORMAT_WHITELIST,
    ...pos,
    '-i', input,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-f', 'null', '-',
  ];
  const res = await runProcess(cfg.FFMPEG_PATH, args, { timeoutMs, maxBuffer: 1024 * 1024 });
  if (res.code === -1) throw new Error(`decode check (${window}) timed out after ${timeoutMs} ms`);
  if (res.code !== 0) return res.stderr.trim().split('\n').slice(0, 6).join('\n') || `decoder exited ${res.code}`;
  return null;
}

/**
 * Validate an upload. `input` is a local path or an INTERNAL presigned URL (never client-visible).
 * Infrastructure failures (timeouts, spawn errors) throw so the job is retried; content problems
 * return `{ ok: false, code }` so the item is quarantined.
 */
export async function inspectMedia(input: string, opts: { timeoutMs?: number } = {}): Promise<InspectOutcome> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  let p: ProbeResult;
  try {
    p = await probe(input, timeoutMs);
  } catch (err) {
    if (err instanceof MediaError) return { ok: false, code: 'NOT_VIDEO', message: `ffprobe could not read the file: ${scrubToolMessage(err.message, input).slice(0, 400)}`, probe: null, meta: null };
    throw err;
  }
  const fmt = p.format.format_name ?? '';
  const meta = extractMetadata(p);
  if (!meta || /(_pipe$|^image2|^gif$|^apng$|^webp)/.test(fmt)) {
    return { ok: false, code: 'NOT_VIDEO', message: `No video stream found (container "${fmt}")`, probe: p, meta: null };
  }
  if (!(SUPPORTED_CONTAINERS as readonly string[]).includes(fmt)) {
    return { ok: false, code: 'UNSUPPORTED_FORMAT', message: `Container "${fmt}" is not supported`, probe: p, meta };
  }
  if (!(SUPPORTED_VIDEO_CODECS as readonly string[]).includes(meta.videoCodec)) {
    return { ok: false, code: 'UNSUPPORTED_CODEC', message: `Video codec "${meta.videoCodec}" is not supported`, probe: p, meta };
  }
  if (!(meta.durationMs > 0)) {
    return { ok: false, code: 'CORRUPT', message: 'Media has no measurable duration', probe: p, meta };
  }
  const windows: Array<'head' | 'tail' | 'all'> = meta.durationMs <= DECODE_WINDOW_SECONDS * 2 * 1000 ? ['all'] : ['head', 'tail'];
  for (const w of windows) {
    const err = await decodeWindow(input, w, timeoutMs);
    if (err) return { ok: false, code: 'CORRUPT', message: `Decode error in ${w === 'all' ? 'stream' : `${w} of stream`}: ${scrubToolMessage(err, input).slice(0, 600)}`, probe: p, meta };
  }
  return { ok: true, probe: p, meta };
}
