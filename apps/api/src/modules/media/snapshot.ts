/**
 * Exact-frame snapshot extraction.
 *
 * Frame model: for a CFR stream at `fps`, frame n is presented during [n/fps, (n+1)/fps). The frame shown at
 * time t is n = floor(t * fps + 1e-6). To decode EXACTLY that frame we use FFmpeg input seeking with
 * accurate_seek (the default): FFmpeg seeks to the preceding keyframe, decodes, and discards every frame whose
 * timestamp is below the seek point. Seeking to the MIDDLE of the previous frame, (n - 0.5)/fps, makes the
 * first surviving frame frame n regardless of timestamp rounding. The PNG is lossless (no re-encode of the
 * pixels beyond YUV->RGB conversion).
 *
 * The proxy is CFR by construction. For `source: 'original'` the evidence's nominal frame rate is used; for
 * variable-frame-rate originals the frame number is therefore nominal (documented in docs/VIDEO-PIPELINE.md).
 */
import { mkdir, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ffmpeg } from '@ksp/core';

export function frameAt(timeMs: number, fps: number): number {
  return Math.max(0, Math.floor((timeMs / 1000) * fps + 1e-6));
}

export async function extractFrame(opts: { input: string; frame: number; fps: number; workDir: string; timeoutMs?: number }): Promise<{ png: Buffer; width: number; height: number }> {
  const dir = join(opts.workDir, `snap-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const out = join(dir, 'frame.png');
  try {
    const seek = opts.frame > 0 ? ['-ss', ((opts.frame - 0.5) / opts.fps).toFixed(6)] : [];
    const http = /^https?:/.test(opts.input) ? ['-reconnect', '1', '-reconnect_on_network_error', '1'] : [];
    await ffmpeg([...seek, ...http, '-i', opts.input, '-map', '0:v:0', '-an', '-sn', '-frames:v', '1', '-c:v', 'png', '-f', 'image2', out], { timeoutMs: opts.timeoutMs ?? 90_000 });
    const png = await readFile(out);
    if (png.length < 24 || png.toString('latin1', 12, 16) !== 'IHDR') throw new Error('snapshot produced no image');
    return { png, width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
