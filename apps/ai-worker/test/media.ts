/**
 * Real test imagery (public domain / CC0, Wikimedia Commons), downloaded once with SHA-256 verification and
 * cached next to the model directory. Turned into short videos with FFmpeg; attached as PROXY_MP4 derivatives
 * exactly where the video pipeline puts them (derived bucket, evidence/<id>/proxy/proxy.mp4).
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ffmpeg, loadConfig, probe, storage, type Database } from '@ksp/core';

export const TEST_IMAGES = {
  street: {
    file: 'street_porlamar.jpg',
    url: 'https://upload.wikimedia.org/wikipedia/commons/9/93/Traffic_and_pedestrians_on_Calle_Vel%C3%A1squez_near_Catedral_San_Nicol%C3%A1s_de_Bari_in_Porlamar%2C_Venezuela.jpg',
    sha256: '2c97420ab515eda95204755d114c64a7f8a4acf47e7670e104e85a9cea5feca3',
    licence: 'CC0 (Wikimedia Commons: Traffic and pedestrians on Calle Velásquez … Porlamar, Venezuela)',
  },
  crowd: {
    file: 'street_dhaka.jpg',
    url: 'https://upload.wikimedia.org/wikipedia/commons/5/58/Busy_street_with_pedestrians_in_Dhaka%2C_Bangladesh.jpg',
    sha256: 'dd352bcdc4250f1bf5e525b4036ce6bb5bf287cc1f0940f6952c1aac270147c4',
    licence: 'Public domain (Wikimedia Commons: Busy street with pedestrians in Dhaka, Bangladesh)',
  },
  portrait: {
    file: 'portrait_obama.jpg',
    url: 'https://upload.wikimedia.org/wikipedia/commons/8/8d/President_Barack_Obama.jpg',
    sha256: '744dd848fbb0584229169e01c4944664957c62495fb9e8af514a088ebca43e19',
    licence: 'Public domain (US Government work; Wikimedia Commons: President Barack Obama.jpg)',
  },
  plate: {
    file: 'plate_uk.jpg',
    url: 'https://upload.wikimedia.org/wikipedia/commons/9/9e/UK_%28Northern_Ireland%29_Number_Plate_IJZ_8992_%28JZ_-_Down_%28NI%29_%29_-_Dateless_Plate_-_Ford_Fiesta_%28Woolston_Car_Centre%29.jpg',
    sha256: '964896827eaee3528c68cdbb320022ef11a893dc1cc456c0575f6d939441771a',
    licence: 'CC0 (Wikimedia Commons: UK (Northern Ireland) Number Plate IJZ 8992 … Ford Fiesta)',
  },
} as const;
export type TestImage = keyof typeof TEST_IMAGES;

export function mediaDir(): string {
  return resolve(loadConfig().AI_MODELS_DIR, '..', 'ai-test-media');
}

/** Download (or reuse) every test image; returns local paths, or throws with the reason. */
export async function ensureImages(): Promise<Record<TestImage, string>> {
  const dir = mediaDir();
  await mkdir(dir, { recursive: true });
  const out = {} as Record<TestImage, string>;
  for (const [k, img] of Object.entries(TEST_IMAGES) as Array<[TestImage, (typeof TEST_IMAGES)[TestImage]]>) {
    const path = join(dir, img.file);
    const sha = existsSync(path) ? createHash('sha256').update(await readFile(path)).digest('hex') : null;
    if (sha !== img.sha256) {
      const res = await fetch(img.url, { headers: { 'user-agent': 'KSP-VMS-tests/1.0 (automated test fixture download)' } });
      if (!res.ok) throw new Error(`download ${img.file}: HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const got = createHash('sha256').update(buf).digest('hex');
      if (got !== img.sha256) throw new Error(`SHA-256 mismatch for ${img.file}: ${got}`);
      await writeFile(`${path}.part`, buf);
      await rename(`${path}.part`, path);
    }
    out[k] = path;
  }
  return out;
}

export async function tryEnsureImages(): Promise<{ images: Record<TestImage, string> | null; reason: string | null }> {
  try {
    return { images: await ensureImages(), reason: null };
  } catch (err) {
    return { images: null, reason: (err as Error).message };
  }
}

/** Build an H.264 1280x720 25 fps video showing each image for `seconds` (letterboxed). Cached by spec. */
export async function slideshow(images: string[], seconds: number | number[], name: string): Promise<string> {
  const dir = mediaDir();
  const out = join(dir, `${name}.mp4`);
  if (existsSync(out)) return out;
  const secs = images.map((_, i) => (Array.isArray(seconds) ? seconds[i]! : seconds));
  const args: string[] = [];
  images.forEach((img, i) => args.push('-loop', '1', '-t', String(secs[i]), '-i', img));
  const chains = images.map((_, i) => `[${i}:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=25,format=yuv420p[v${i}]`);
  const filter = `${chains.join(';')};${images.map((_, i) => `[v${i}]`).join('')}concat=n=${images.length}:v=1:a=0[out]`;
  await ffmpeg([...args, '-filter_complex', filter, '-map', '[out]', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-movflags', '+faststart', `${out}.tmp.mp4`]);
  await rename(`${out}.tmp.mp4`, out);
  return out;
}

/** Attach a local MP4 as the evidence's PROXY_MP4 (derived bucket) and mark media READY. */
export async function attachProxy(db: Database, evidenceId: string, file: string): Promise<{ derivativeId: string; key: string }> {
  const st = storage();
  const bucket = st.bucket('derived');
  const key = `evidence/${evidenceId}/proxy/proxy.mp4`;
  const buf = await readFile(file);
  await st.put(bucket, key, buf, { contentType: 'video/mp4', contentLength: buf.length });
  const info = await probe(file);
  const v = info.streams.find((s) => s.codec_type === 'video');
  const d = await db.insertInto('evidence_derivatives').values({
    evidence_id: evidenceId, kind: 'PROXY_MP4', bucket, object_key: key, mime_type: 'video/mp4', size_bytes: buf.length,
    sha256: createHash('sha256').update(buf).digest('hex'), width: v?.width ?? null, height: v?.height ?? null, meta: JSON.stringify({ test: true }),
  }).returning('id').executeTakeFirstOrThrow();
  await db.updateTable('evidence').set({ media_status: 'READY' }).where('id', '=', evidenceId).execute();
  return { derivativeId: d.id, key };
}
