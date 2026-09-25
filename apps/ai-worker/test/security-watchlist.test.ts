/** Watchlist reference images: decode failures never expose server paths (SEC-07); stills decode under the image whitelist. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ffmpeg, loadConfig } from '@ksp/core';
import { imageErrorMessage, loadStill } from '../src/watchlist.js';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(loadConfig().WORK_DIR, 'sec-watchlist-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('watchlist reference image handling', () => {
  it('decodes JPEG and PNG stills saved under a server-generated .img name', async () => {
    for (const fmt of ['mjpeg', 'png']) {
      const f = join(dir, `${fmt}.img`);
      await ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=48x32', '-frames:v', '1', '-c:v', fmt, '-f', 'image2', f]);
      const img = await loadStill(f);
      expect([img.width, img.height], fmt).toEqual([48, 32]);
    }
  });

  it('a corrupt image fails without leaking the temp path or work dir in the stored error', async () => {
    const f = join(dir, 'corrupt.img');
    writeFileSync(f, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0x41)]));
    const err = await loadStill(f).then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = imageErrorMessage(err!, f, dir);
    expect(msg).toMatch(/^IMAGE_UNREADABLE: /);
    expect(msg).not.toContain(dir);
    expect(msg).not.toContain(loadConfig().WORK_DIR);
  });
});
