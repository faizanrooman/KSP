/**
 * Visible watermark burn-in for court-export copies and external-share playback.
 *
 * Implemented with an ASS subtitle script rendered by libass (`ass` filter) rather than `drawtext`: the
 * FFmpeg builds we ship/test with include libass + fontconfig but not always `drawtext`. The script burns:
 *   - an info box (bottom-left): the caller's lines (export/share id, recipient, date);
 *   - a large diagonal "COPY - NOT ORIGINAL" mark (semi-transparent, centre);
 *   - a running timecode (top-right), one event per second: media time T+hh:mm:ss and, when the recording
 *     start is known, the wall-clock recording time.
 * The output is a new H.264/AAC MP4 (faststart). The ORIGINAL is never modified.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpeg } from '../media.js';

export const COPY_MARK = 'COPY - NOT ORIGINAL';

export interface WatermarkOptions {
  input: string; // local path or internal (never client-visible) URL
  output: string; // local path (.mp4)
  lines: string[];
  width: number;
  height: number;
  durationMs: number;
  recordedAt?: Date | null;
  label?: string; // short label prefixed to the timecode (e.g. export number)
  timeoutMs?: number;
  onProgress?: (fraction: number) => void;
}

/** Strip characters with meaning in ASS override blocks. */
export function assText(s: string): string {
  return s.replace(/[{}\\]/g, '').replace(/[\r\n]+/g, ' ').replace(/[^\x20-\x7e\xa0-ɏ]/g, '?').slice(0, 200);
}

function assTime(ms: number): string {
  const cs = Math.max(0, Math.round(ms / 10));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

const hms = (sec: number) => `${String(Math.floor(sec / 3600)).padStart(2, '0')}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;

export function buildAssScript(o: Pick<WatermarkOptions, 'lines' | 'width' | 'height' | 'durationMs' | 'recordedAt' | 'label'>): string {
  const w = Math.max(160, o.width || 1280);
  const h = Math.max(90, o.height || 720);
  const small = Math.max(10, Math.round(h / 26));
  const big = Math.max(18, Math.round(Math.min(w, h) / 7));
  const end = assTime(Math.max(1000, o.durationMs) + 1000);
  const margin = Math.max(4, Math.round(h / 60));
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${w}`,
    `PlayResY: ${h}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Info,DejaVu Sans,${small},&H00FFFFFF,&H000000FF,&H00000000,&H60000000,-1,0,0,0,100,100,0,0,3,${Math.max(1, Math.round(small / 6))},0,1,${margin},${margin},${margin},1`,
    `Style: Mark,DejaVu Sans,${big},&H90FFFFFF,&H000000FF,&H90000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,0,5,0,0,0,1`,
    `Style: TC,DejaVu Sans Mono,${small},&H0000FFFF,&H000000FF,&H00000000,&H60000000,-1,0,0,0,100,100,0,0,3,${Math.max(1, Math.round(small / 6))},0,9,${margin},${margin},${margin},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const events = [
    `Dialogue: 0,0:00:00.00,${end},Info,,0,0,0,,${o.lines.map(assText).join('\\N')}`,
    `Dialogue: 0,0:00:00.00,${end},Mark,,0,0,0,,{\\frz28}${COPY_MARK}`,
  ];
  const seconds = Math.ceil(Math.max(1000, o.durationMs) / 1000);
  const label = o.label ? `${assText(o.label)}  ` : '';
  for (let s = 0; s < seconds; s++) {
    const wall = o.recordedAt ? `  REC ${new Date(o.recordedAt.getTime() + s * 1000).toISOString().slice(0, 19).replace('T', ' ')}Z` : '';
    events.push(`Dialogue: 1,${assTime(s * 1000)},${assTime((s + 1) * 1000)},TC,,0,0,0,,${label}T+${hms(s)}${wall}`);
  }
  return [...header, ...events, ''].join('\n');
}

/** Burn the watermark into a new MP4. Requires an FFmpeg build with libass (+ fontconfig fonts installed). */
export async function burnWatermark(o: WatermarkOptions): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ksp-wm-'));
  try {
    const assPath = join(dir, 'watermark.ass');
    if (!/^[A-Za-z0-9_/.-]+$/.test(assPath)) throw new Error('temporary directory path contains characters unsafe for the FFmpeg filter graph');
    await writeFile(assPath, buildAssScript(o), 'utf8');
    await ffmpeg(
      ['-i', o.input, '-map', '0:v:0', '-map', '0:a?', '-vf', `ass=${assPath}`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', '-f', 'mp4', o.output],
      { timeoutMs: o.timeoutMs ?? 6 * 3600_000, durationMs: o.durationMs, onProgress: o.onProgress },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
