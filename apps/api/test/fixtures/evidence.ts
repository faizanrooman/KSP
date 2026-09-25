/**
 * Test fixture: a REGISTERED evidence item backed by a real FFmpeg-generated MP4 stored immutably in the
 * evidence bucket (originals/<yyyy>/<mm>/<id>/<sha256>, Object Lock, If-None-Match), exactly as ingestion does.
 *
 *   const ev = await createRegisteredEvidence({ orgCode: 'ps_cubbonpark', uploadedBy: user.id });
 *
 * Pass `db` when calling from outside the API test harness (e.g. worker tests). Reusable by every module's tests.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { appendAudit, ffmpeg, hashStream, loadConfig, probe, storage, systemActor, type Database } from '@ksp/core';
import { Readable } from 'node:stream';

export interface CreateEvidenceOptions {
  orgCode: string;
  uploadedBy: string;
  officerId?: string | null;
  deviceId?: string | null;
  title?: string;
  description?: string;
  category?: string;
  recordedAt?: Date;
  /** Backdate registration (drives retention / tier ages). */
  registeredAt?: Date;
  retentionPolicyCode?: string | null;
  gps?: { lat: number; lon: number };
  /** Record a WRONG sha256/sha512 in the row (the stored object is untouched) — for fixity-failure tests. */
  corruptRecordedHash?: boolean;
  durationSeconds?: number;
  db?: Database;
}

export interface CreatedEvidence {
  id: string;
  evidenceNumber: string;
  orgUnitId: string;
  orgPath: string;
  sha256: string;
  sha512: string;
  sizeBytes: number;
  bucket: string;
  key: string;
  versionId: string | undefined;
}

let base: Promise<string> | undefined;
/** One base clip per process; each evidence gets unique bytes by re-muxing with a unique metadata tag. */
function baseClip(dir: string, seconds: number): Promise<string> {
  return (base ??= (async () => {
    const out = join(dir, `base-${seconds}s.mp4`);
    await ffmpeg(['-f', 'lavfi', '-i', `testsrc2=size=320x240:rate=25:duration=${seconds}`, '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', out]);
    return out;
  })());
}

async function resolveDb(db?: Database): Promise<Database> {
  if (db) return db;
  const { getApp } = await import('../helpers.js');
  return (await getApp()).db;
}

export async function createRegisteredEvidence(opts: CreateEvidenceOptions): Promise<CreatedEvidence> {
  const db = await resolveDb(opts.db);
  const cfg = loadConfig();
  const dir = join(cfg.WORK_DIR, 'test-fixtures');
  await mkdir(dir, { recursive: true });
  const id = randomUUID();
  const file = join(dir, `${id}.mp4`);
  await ffmpeg(['-i', await baseClip(dir, opts.durationSeconds ?? 2), '-c', 'copy', '-map_metadata', '-1', '-metadata', `comment=ksp-fixture-${id}`, '-movflags', '+faststart', file]);
  const buf = await readFile(file);
  const info = await probe(file);
  await rm(file, { force: true });
  const hashes = await hashStream(Readable.from([buf]));

  const org = await db.selectFrom('org_units').select(['id', 'code', 'path']).where('code', '=', opts.orgCode).executeTakeFirstOrThrow();
  const registeredAt = opts.registeredAt ?? new Date();
  const yyyy = String(registeredAt.getUTCFullYear());
  const mm = String(registeredAt.getUTCMonth() + 1).padStart(2, '0');
  const st = storage();
  const bucket = st.bucket('evidence');
  const key = `originals/${yyyy}/${mm}/${id}/${hashes.sha256}`;
  const put = await st.put(bucket, key, buf, { contentType: 'video/mp4', lock: true, ifNoneMatch: true, contentLength: buf.length, metadata: { 'evidence-id': id, sha256: hashes.sha256 } });
  const head = await st.head(bucket, key);

  const v = info.streams.find((s) => s.codec_type === 'video');
  const a = info.streams.find((s) => s.codec_type === 'audio');
  const durationMs = Math.round(Number(info.format.duration ?? '0') * 1000);
  const recordedAt = opts.recordedAt ?? new Date(registeredAt.getTime() - 3_600_000);
  const policy = opts.retentionPolicyCode === null
    ? null
    : await db.selectFrom('retention_policies').select(['id', 'retention_days']).where((eb) => (opts.retentionPolicyCode ? eb('code', '=', opts.retentionPolicyCode) : eb('is_default', '=', true))).executeTakeFirstOrThrow();
  const recorded = opts.corruptRecordedHash
    ? { sha256: hashes.sha256.split('').reverse().join(''), sha512: hashes.sha512.split('').reverse().join('') }
    : { sha256: hashes.sha256, sha512: hashes.sha512 };

  const evidenceNumber = await db.transaction().execute(async (tx) => {
    const c = await tx
      .insertInto('evidence_number_counters')
      .values({ org_unit_id: org.id, year: Number(yyyy), last_value: 1 })
      .onConflict((oc) => oc.columns(['org_unit_id', 'year']).doUpdateSet((eb) => ({ last_value: eb('evidence_number_counters.last_value', '+', 1) })))
      .returning('last_value')
      .executeTakeFirstOrThrow();
    const number = `KSP-${org.code.replace(/^ps_/, '').toUpperCase()}-${yyyy}-${String(c.last_value).padStart(6, '0')}`;
    await tx
      .insertInto('evidence')
      .values({
        id,
        evidence_number: number,
        status: 'REGISTERED',
        org_unit_id: org.id,
        org_path: org.path,
        uploaded_by: opts.uploadedBy,
        officer_id: opts.officerId ?? null,
        device_id: opts.deviceId ?? null,
        title: opts.title ?? `Fixture ${number}`,
        description: opts.description ?? null,
        category: opts.category ?? null,
        original_filename: `BWC_${id.slice(0, 8)}.mp4`,
        mime_type: 'video/mp4',
        size_bytes: buf.length,
        sha256: recorded.sha256,
        sha512: recorded.sha512,
        storage_bucket: bucket,
        storage_key: key,
        storage_version_id: put.versionId ?? null,
        storage_tier: 'ACTIVE',
        object_lock_until: head?.ObjectLockRetainUntilDate ?? null,
        recorded_at: recordedAt,
        recorded_end_at: new Date(recordedAt.getTime() + durationMs),
        duration_ms: durationMs,
        container_format: info.format.format_name,
        video_codec: v?.codec_name ?? null,
        audio_codec: a?.codec_name ?? null,
        width: v?.width ?? null,
        height: v?.height ?? null,
        frame_rate: 25,
        bit_rate: info.format.bit_rate ? Number(info.format.bit_rate) : null,
        gps_latitude: opts.gps?.lat ?? null,
        gps_longitude: opts.gps?.lon ?? null,
        gps_source: opts.gps ? 'DECLARED' : null,
        probe: JSON.stringify({ format: info.format, streams: info.streams }),
        media_status: 'PENDING',
        retention_policy_id: policy?.id ?? null,
        retain_until: policy?.retention_days ? new Date(registeredAt.getTime() + policy.retention_days * 86_400_000) : null,
        registered_at: registeredAt,
        created_at: registeredAt,
      })
      .execute();
    await appendAudit(tx, systemActor('test-fixture'), { action: 'EVIDENCE_REGISTERED', resourceType: 'evidence', resourceId: id, evidenceId: id, orgUnitId: org.id, details: { sha256: hashes.sha256, fixture: true } });
    return number;
  });

  return { id, evidenceNumber, orgUnitId: org.id, orgPath: org.path, sha256: hashes.sha256, sha512: hashes.sha512, sizeBytes: buf.length, bucket, key, versionId: put.versionId };
}
