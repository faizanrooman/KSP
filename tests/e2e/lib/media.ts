/**
 * Test media generated with FFmpeg (no binary fixtures in git). Files are cached in tests/e2e/.media and
 * regenerated when missing. Every run can add a unique marker so the station's dedupe (SHA-256) never
 * collapses two runs' uploads into one.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ENV, FFMPEG, MEDIA_DIR } from './env';

function ff(args: string[]): void {
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
}

/** A short H.264/AAC clip carrying a unique metadata marker (so every run produces distinct evidence). */
export function makeClip(name: string, opts: { seconds?: number; pattern?: 'testsrc2' | 'smptebars' | 'rgbtestsrc'; freq?: number; label?: string; size?: string } = {}): string {
  mkdirSync(MEDIA_DIR, { recursive: true });
  const out = resolve(MEDIA_DIR, `${name}.mp4`);
  const secs = opts.seconds ?? 6;
  const label = (opts.label ?? name).replace(/[^A-Za-z0-9 _.-]/g, '');
  ff([
    '-f', 'lavfi', '-i', `${opts.pattern ?? 'testsrc2'}=size=${opts.size ?? '640x360'}:rate=25:duration=${secs}`,
    '-f', 'lavfi', '-i', `sine=frequency=${opts.freq ?? 440}:duration=${secs}`,
    '-metadata', `comment=KSP E2E ${label}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '25',
    '-c:a', 'aac', '-b:a', '64k', '-shortest', '-movflags', '+faststart', out,
  ]);
  return out;
}

/** A file with a video extension whose content is not a video (the ingest pipeline must quarantine it). */
export function makeFakeVideo(name: string, marker: string): string {
  mkdirSync(MEDIA_DIR, { recursive: true });
  const out = resolve(MEDIA_DIR, `${name}.mp4`);
  writeFileSync(out, `This is not a video file. E2E marker ${marker}\n`.repeat(200));
  return out;
}

const AI_IMAGES = [
  { file: 'street_dhaka.jpg', sha256: 'dd352bcdc4250f1bf5e525b4036ce6bb5bf287cc1f0940f6952c1aac270147c4' },
  { file: 'portrait_obama.jpg', sha256: '744dd848fbb0584229169e01c4944664957c62495fb9e8af514a088ebca43e19' },
];

/**
 * A clip with real people/faces for AI analysis, built from the public-domain images the ai-worker test-suite
 * caches next to the models (<AI_MODELS_DIR>/../ai-test-media). Returns null (with reason) when unavailable.
 */
export function makeAiClip(name: string, label: string): { path: string | null; reason: string | null } {
  const dir = resolve(ENV.AI_MODELS_DIR ?? '', '..', 'ai-test-media');
  const imgs: string[] = [];
  for (const img of AI_IMAGES) {
    const p = resolve(dir, img.file);
    if (!existsSync(p)) return { path: null, reason: `${p} missing (run the ai-worker tests once to download it)` };
    if (createHash('sha256').update(readFileSync(p)).digest('hex') !== img.sha256) return { path: null, reason: `${p} checksum mismatch` };
    imgs.push(p);
  }
  mkdirSync(MEDIA_DIR, { recursive: true });
  const out = resolve(MEDIA_DIR, `${name}.mp4`);
  const scale = 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=25,format=yuv420p';
  ff([
    '-loop', '1', '-t', '3', '-i', imgs[0]!,
    '-loop', '1', '-t', '3', '-i', imgs[1]!,
    '-f', 'lavfi', '-i', 'sine=frequency=300:duration=6',
    '-filter_complex', `[0:v]${scale}[a];[1:v]${scale}[b];[a][b]concat=n=2:v=1:a=0[v]`,
    '-map', '[v]', '-map', '2:a', '-metadata', `comment=KSP E2E ${label.replace(/[^A-Za-z0-9 _.-]/g, '')}`, '-c:v', 'libx264', '-preset', 'veryfast', '-g', '25', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', out,
  ]);
  return { path: out, reason: null };
}
