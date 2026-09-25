/**
 * Malicious media inputs: the ingest/media pipeline must never let a reference-following demuxer (HLS playlist,
 * concat script) open other files or URLs named inside an uploaded file. Uses a harmless canary path that does
 * not exist — before the fix, ffprobe tried to open it ("Error when loading first segment 'file:///…'").
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ffmpeg, inspectMedia, loadConfig, MediaError, probe } from '@ksp/core';

const CANARY = 'nonexistent-ksp-canary';
let dir: string;

beforeAll(() => {
  const cfg = loadConfig();
  dir = mkdtempSync(join(cfg.WORK_DIR, 'sec-media-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const playlist = `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nfile:///${CANARY}/seg.ts\n#EXT-X-ENDLIST\n`;
const concat = `ffconcat version 1.0\nfile '/${CANARY}/a.mp4'\n`;

describe('media pipeline: reference-following demuxers are never used', () => {
  it.each(['upload.m3u8', 'upload.mp4', 'upload'])('HLS playlist named %s is rejected without opening referenced files', async (name) => {
    const f = join(dir, name);
    writeFileSync(f, playlist);
    const err = await probe(f).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(MediaError);
    expect((err as MediaError).message).not.toContain(CANARY);
    const outcome = await inspectMedia(f);
    expect(outcome.ok).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain(CANARY);
  });

  it('ffconcat script is rejected without opening referenced files', async () => {
    const f = join(dir, 'concat.mp4');
    writeFileSync(f, concat);
    const err = await probe(f).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(MediaError);
    expect((err as MediaError).message).not.toContain(CANARY);
  });

  it('non-video payloads (text, zero bytes, PNG) are rejected by inspection', async () => {
    const txt = join(dir, 'x.mp4');
    writeFileSync(txt, 'MZ\x90\x00 not a video <script>alert(1)</script>');
    expect((await inspectMedia(txt)).ok).toBe(false);
    const empty = join(dir, 'empty.mp4');
    writeFileSync(empty, '');
    expect((await inspectMedia(empty)).ok).toBe(false);
    const png = join(dir, 'img.mp4');
    await ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=32x32', '-frames:v', '1', '-f', 'image2', '-c:v', 'png', png]);
    expect((await inspectMedia(png)).ok).toBe(false);
  });

  it('legitimate containers still probe with the format whitelist', async () => {
    for (const ext of ['mp4', 'mkv', 'avi']) {
      const f = join(dir, `ok.${ext}`);
      await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=5', '-t', '1', f]);
      const p = await probe(f);
      expect(p.streams.some((s) => s.codec_type === 'video'), ext).toBe(true);
    }
  });
});
