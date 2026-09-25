/**
 * Fast synthetic rows for search / workspace tests (no storage objects needed: search only touches metadata).
 * Evidence rows are inserted REGISTERED through the app connection exactly like ingestion would leave them.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { loadConfig } from '@ksp/core';
import { getApp } from './helpers.js';

export const token = (prefix = 'zq') => `${prefix}${randomBytes(5).toString('hex')}`;
const hex = (n: number) => randomBytes(n).toString('hex');

export interface SynOpts {
  orgCode: string;
  uploadedBy: string;
  title?: string;
  description?: string;
  category?: string;
  locationText?: string;
  officerId?: string | null;
  deviceId?: string | null;
  recordedAt?: Date;
  durationMs?: number;
  gps?: { lat: number; lon: number };
  storageTier?: 'ACTIVE' | 'ARCHIVE' | 'LONG_TERM';
  mediaStatus?: string;
  legalHold?: boolean;
  tags?: string[];
  status?: string;
  createdAt?: Date;
}

export async function orgOf(code: string) {
  const app = await getApp();
  return app.db.selectFrom('org_units').select(['id', 'path']).where('code', '=', code).executeTakeFirstOrThrow();
}

export async function insertEvidence(o: SynOpts): Promise<{ id: string; evidenceNumber: string }> {
  const app = await getApp();
  const org = await orgOf(o.orgCode);
  const id = randomUUID();
  const number = `SYN-${hex(4).toUpperCase()}-${hex(3).toUpperCase()}`;
  const recordedAt = o.recordedAt ?? new Date(Date.now() - 86_400_000);
  const dur = o.durationMs ?? 60_000;
  const created = o.createdAt ?? new Date();
  await app.db
    .insertInto('evidence')
    .values({
      id,
      evidence_number: number,
      status: o.status ?? 'REGISTERED',
      org_unit_id: org.id,
      org_path: org.path,
      uploaded_by: o.uploadedBy,
      officer_id: o.officerId ?? null,
      device_id: o.deviceId ?? null,
      title: o.title ?? `Synthetic ${number}`,
      description: o.description ?? null,
      category: o.category ?? null,
      location_text: o.locationText ?? null,
      original_filename: `BWC_${id.slice(0, 8)}.mp4`,
      mime_type: 'video/mp4',
      size_bytes: 1000,
      sha256: hex(32),
      storage_tier: o.storageTier ?? 'ACTIVE',
      recorded_at: recordedAt,
      recorded_end_at: new Date(recordedAt.getTime() + dur),
      duration_ms: dur,
      frame_rate: 25,
      width: 320,
      height: 240,
      gps_latitude: o.gps?.lat ?? null,
      gps_longitude: o.gps?.lon ?? null,
      gps_source: o.gps ? 'DECLARED' : null,
      media_status: o.mediaStatus ?? 'READY',
      legal_hold: o.legalHold ?? false,
      registered_at: created,
      created_at: created,
    })
    .execute();
  for (const tag of o.tags ?? []) await app.db.insertInto('evidence_tags').values({ evidence_id: id, tag, source: 'MANUAL' }).execute();
  return { id, evidenceNumber: number };
}

let modelId: string | undefined;
async function aiModel(): Promise<string> {
  if (modelId) return modelId;
  const app = await getApp();
  const code = token('syn-model-');
  const m = await app.db
    .insertInto('ai_models')
    .values({ code, name: 'Synthetic test model', task: 'OBJECT_DETECTION', version: '1', artifact_uri: 'file:///dev/null', status: 'STAGED' })
    .returning('id')
    .executeTakeFirstOrThrow();
  return (modelId = m.id);
}

export interface DetOpts {
  task?: string;
  label: string;
  confidence?: number;
  frameTimeMs?: number;
  reviewStatus?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'NEEDS_SECOND_REVIEW';
  attributes?: Record<string, unknown>;
}

export async function insertDetections(evidenceId: string, requestedBy: string, dets: DetOpts[]): Promise<string[]> {
  const app = await getApp();
  const mid = await aiModel();
  const job = await app.db
    .insertInto('ai_jobs')
    .values({ evidence_id: evidenceId, requested_by: requestedBy, tasks: ['OBJECT_DETECTION'], status: 'COMPLETED', input: JSON.stringify({}) })
    .returning('id')
    .executeTakeFirstOrThrow();
  const ids: string[] = [];
  for (const d of dets) {
    const r = await app.db
      .insertInto('ai_detections')
      .values({
        job_id: job.id, evidence_id: evidenceId, model_id: mid, model_code: 'syn', model_version: '1', task: d.task ?? 'OBJECT_DETECTION', label: d.label,
        confidence: d.confidence ?? 0.9, threshold: 0.5, frame_time_ms: d.frameTimeMs ?? 1000, review_status: d.reviewStatus ?? 'APPROVED',
        attributes: JSON.stringify(d.attributes ?? {}),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    ids.push(r.id);
  }
  return ids;
}

/** Run statements as the schema owner (ANALYZE / EXPLAIN setup that the DML-only app role cannot do). */
export async function asOwner<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const url = loadConfig().DATABASE_MIGRATION_URL;
  if (!url) throw new Error('DATABASE_MIGRATION_URL not configured');
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}
