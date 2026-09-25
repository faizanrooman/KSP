/**
 * Test fixture: generate real media with FFmpeg and register it as evidence exactly like ingestion does
 * (original in the object-locked evidence bucket under originals/<yyyy>/<mm>/<id>/<sha256>, written with
 * { lock: true, ifNoneMatch: true }; REGISTERED evidence row with hashes, probe fields and org_path).
 * Depends only on @ksp/core so both API and worker tests can use it.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpeg, hashStream, parseRate, probe, type Database, type ProbeResult, type Storage } from '@ksp/core';
import { createReadStream } from 'node:fs';

export type MediaKind =
  | 'h264' // H.264/AAC MP4, testsrc2 + sine, 640x360 25 fps, 6 s
  | 'frames' // testsrc (frame-varying) 320x240 25 fps 4 s, GOP 50 (non-key frames for exact-seek tests)
  | 'hevc_mkv'
  | 'mjpeg_avi'
  | 'vfr' // 30 fps for 2 s then 15 fps (variable frame rate)
  | 'portrait' // 360x640
  | 'p1080' // 1920x1080 short
  | 'long_lowres' // 20 min 160x90 5 fps ("huge duration")
  | 'truncated' // MP4 with moov at end, truncated to 60 %
  | 'garbled' // random bytes
  | 'audio_only'; // AAC in M4A

const EXT: Record<MediaKind, { ext: string; mime: string }> = {
  h264: { ext: 'mp4', mime: 'video/mp4' },
  frames: { ext: 'mp4', mime: 'video/mp4' },
  hevc_mkv: { ext: 'mkv', mime: 'video/x-matroska' },
  mjpeg_avi: { ext: 'avi', mime: 'video/x-msvideo' },
  vfr: { ext: 'mp4', mime: 'video/mp4' },
  portrait: { ext: 'mp4', mime: 'video/mp4' },
  p1080: { ext: 'mp4', mime: 'video/mp4' },
  long_lowres: { ext: 'mp4', mime: 'video/mp4' },
  truncated: { ext: 'mp4', mime: 'video/mp4' },
  garbled: { ext: 'mp4', mime: 'video/mp4' },
  audio_only: { ext: 'm4a', mime: 'audio/mp4' },
};

const lavfi = (spec: string) => ['-f', 'lavfi', '-i', spec];
const h264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'];
const aac = ['-c:a', 'aac', '-b:a', '64k'];

let dirPromise: Promise<string> | undefined;
export function mediaDir(): Promise<string> {
  return (dirPromise ??= (async () => {
    const d = join(tmpdir(), `ksp-test-media-${process.pid}`);
    await mkdir(d, { recursive: true });
    return d;
  })());
}

const cache = new Map<MediaKind, Promise<string>>();
/** Generate (once per process) a media file of the given kind; returns its local path. */
export function generateMedia(kind: MediaKind): Promise<string> {
  let p = cache.get(kind);
  if (!p) {
    p = build(kind);
    cache.set(kind, p);
  }
  return p;
}

async function build(kind: MediaKind): Promise<string> {
  const out = join(await mediaDir(), `${kind}.${EXT[kind].ext}`);
  const T = { timeoutMs: 300_000 };
  switch (kind) {
    case 'h264':
      await ffmpeg([...lavfi('testsrc2=s=640x360:r=25:d=6'), ...lavfi('sine=f=440:sample_rate=48000:d=6'), ...h264, '-g', '50', ...aac, '-shortest', '-movflags', '+faststart', out], T);
      break;
    case 'frames':
      await ffmpeg([...lavfi('testsrc=s=320x240:r=25:d=4'), ...h264, '-g', '50', '-keyint_min', '50', '-sc_threshold', '0', '-movflags', '+faststart', out], T);
      break;
    case 'hevc_mkv':
      await ffmpeg([...lavfi('testsrc2=s=320x240:r=24:d=3'), ...lavfi('sine=f=600:d=3'), '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error', '-pix_fmt', 'yuv420p', ...aac, '-shortest', out], T);
      break;
    case 'mjpeg_avi':
      await ffmpeg([...lavfi('testsrc2=s=320x240:r=15:d=3'), ...lavfi('sine=f=300:d=3'), '-c:v', 'mjpeg', '-q:v', '5', '-pix_fmt', 'yuvj420p', '-c:a', 'pcm_s16le', '-shortest', out], T);
      break;
    case 'vfr':
      // frames 0..59 at 30 fps, then every frame lasts 1/15 s.
      await ffmpeg([...lavfi('testsrc2=s=320x240:r=30:d=4'), '-vf', "setpts='if(lt(N,60),N/30,2+(N-60)/15)/TB'", '-fps_mode', 'vfr', ...h264, '-movflags', '+faststart', out], T);
      break;
    case 'portrait':
      await ffmpeg([...lavfi('testsrc2=s=360x640:r=30:d=3'), ...lavfi('sine=f=500:d=3'), ...h264, ...aac, '-shortest', '-movflags', '+faststart', out], T);
      break;
    case 'p1080':
      await ffmpeg([...lavfi('testsrc2=s=1920x1080:r=25:d=2'), ...lavfi('sine=f=700:d=2'), ...h264, ...aac, '-shortest', '-movflags', '+faststart', out], T);
      break;
    case 'long_lowres':
      await ffmpeg([...lavfi('testsrc2=s=160x90:r=5:d=1200'), ...lavfi('sine=f=200:sample_rate=8000:d=1200'), ...h264, '-g', '25', '-c:a', 'aac', '-b:a', '16k', '-ac', '1', '-shortest', '-movflags', '+faststart', out], T);
      break;
    case 'truncated': {
      await ffmpeg([...lavfi('testsrc2=s=320x240:r=25:d=4'), ...h264, out], T); // moov at the END (no faststart)
      const { size } = await stat(out);
      await truncate(out, Math.floor(size * 0.6));
      break;
    }
    case 'garbled':
      await writeFile(out, randomBytes(256 * 1024));
      break;
    case 'audio_only':
      await ffmpeg([...lavfi('sine=f=440:d=3'), ...aac, out], T);
      break;
  }
  return out;
}

export interface MediaEvidence {
  id: string;
  evidenceNumber: string;
  sha256: string;
  sha512: string;
  size: number;
  bucket: string;
  key: string;
  versionId: string | null;
  path: string;
  orgUnitId: string;
}

let seq = 0;
/**
 * Register a generated file as evidence at `org` (org unit code), uploaded by `uploadedBy` (username).
 */
export async function createMediaEvidence(
  db: Database,
  storage: Storage,
  opts: { kind: MediaKind; org?: string; uploadedBy?: string; title?: string },
): Promise<MediaEvidence> {
  const path = await generateMedia(opts.kind);
  const org = await db.selectFrom('org_units').select(['id', 'path', 'code']).where('code', '=', opts.org ?? 'ps_cubbonpark').executeTakeFirstOrThrow();
  const user = await db.selectFrom('users').select('id').where('username', '=', opts.uploadedBy ?? 'io.meera').executeTakeFirstOrThrow();
  const id = randomUUID();
  const { sha256, sha512, size } = await hashStream(createReadStream(path));
  const now = new Date();
  const key = `originals/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${id}/${sha256}`;
  const bucket = storage.bucket('evidence');
  const put = await storage.put(bucket, key, await readFile(path), { contentType: EXT[opts.kind].mime, lock: true, ifNoneMatch: true });
  let p: ProbeResult | null = null;
  try {
    p = await probe(path);
  } catch {
    p = null;
  }
  const v = p?.streams.find((s) => s.codec_type === 'video');
  const a = p?.streams.find((s) => s.codec_type === 'audio');
  const dur = p?.format.duration ? Math.round(Number(p.format.duration) * 1000) : null;
  const evidenceNumber = `KSP-TEST-${now.getUTCFullYear()}-${process.pid}${String(++seq).padStart(4, '0')}${randomBytes(2).toString('hex')}`;
  await db
    .insertInto('evidence')
    .values({
      id,
      evidence_number: evidenceNumber,
      status: 'REGISTERED',
      org_unit_id: org.id,
      org_path: org.path,
      uploaded_by: user.id,
      officer_id: user.id,
      title: opts.title ?? `Fixture ${opts.kind}`,
      original_filename: `${opts.kind}.${EXT[opts.kind].ext}`,
      mime_type: EXT[opts.kind].mime,
      size_bytes: size,
      sha256,
      sha512,
      storage_bucket: bucket,
      storage_key: key,
      storage_version_id: put.versionId ?? null,
      storage_tier: 'ACTIVE',
      recorded_at: now,
      duration_ms: dur,
      container_format: p?.format.format_name ?? null,
      video_codec: v?.codec_name ?? null,
      audio_codec: a?.codec_name ?? null,
      width: v?.width ?? null,
      height: v?.height ?? null,
      frame_rate: parseRate(v?.r_frame_rate) ?? null,
      probe: p ? JSON.stringify(p) : null,
      media_status: 'PENDING',
      registered_at: now,
    } as never)
    .execute();
  return { id, evidenceNumber, sha256, sha512, size, bucket, key, versionId: put.versionId ?? null, path, orgUnitId: org.id };
}
