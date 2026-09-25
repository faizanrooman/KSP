/**
 * Evidence ingestion pipeline (shared by the finalize worker and the quarantine-release API):
 *
 *   finalizeUpload(sessionId)  — hash → validate/probe → metadata → duplicate check → register | quarantine
 *   registerEvidence(id)       — write-once copy into the evidence bucket (Object Lock, conditional write),
 *                                re-hash of the stored object, evidence number, retention, REGISTERED.
 *   rejectQuarantined(id)      — REJECTED, staged object deleted, record kept.
 *
 * Every step is idempotent: a retried job resumes safely (content-addressed destination key, NOOP on
 * terminal states) and every state change commits together with its custody audit event.
 */
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { QUEUES, formatStatusReason, type MediaProcessPayload, type QuarantineReason } from '@ksp/shared';
import type { AppConfig } from '../config.js';
import type { Database, Tx } from '../db/index.js';
import type { Storage } from '../storage.js';
import { appendAudit, systemActor, type AuditActor } from '../audit.js';
import { getQueue } from '../queue.js';
import { inspectMedia, type ExtractedMetadata } from './inspect.js';
import { wormCopy } from './storage-ops.js';

export interface IngestLogger {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
}

export interface IngestDeps {
  db: Database;
  storage: Storage;
  cfg: AppConfig;
  log?: IngestLogger;
  /** Progress callback (0..1) for user-visible job tracking. */
  onProgress?: (fraction: number) => Promise<void> | void;
  /** Override MEDIA_PROCESS enqueueing (defaults to the pg-boss queue). */
  enqueueMedia?: (payload: MediaProcessPayload) => Promise<unknown>;
  /** Server-side copy part size (tests use small values to exercise multi-part copies). */
  copyPartSize?: number;
}

export type IngestOutcome =
  | { outcome: 'REGISTERED'; evidenceId: string; evidenceNumber: string; sha256: string }
  | { outcome: 'QUARANTINED'; evidenceId: string; reason: QuarantineReason; message: string }
  | { outcome: 'NOOP'; evidenceId: string | null; status: string | null };

export const INGEST_ACTOR = systemActor('ingest-worker');

/** Terminal (or post-registration) statuses that finalize never touches again. */
const SETTLED = new Set(['REGISTERED', 'QUARANTINED', 'REJECTED', 'DISPOSAL_PENDING', 'DISPOSED']);

export class IngestError extends Error {
  constructor(message: string, readonly permanent = false) {
    super(message);
    this.name = 'IngestError';
  }
}

function originalKey(createdAt: Date, evidenceId: string, sha256: string): string {
  const yyyy = createdAt.getUTCFullYear();
  const mm = String(createdAt.getUTCMonth() + 1).padStart(2, '0');
  return `originals/${yyyy}/${mm}/${evidenceId}/${sha256}`;
}

/** Evidence numbers are allocated per station per calendar year in India Standard Time. */
function istYear(d: Date): number {
  return new Date(d.getTime() + 330 * 60_000).getUTCFullYear();
}

async function nextEvidenceNumber(tx: Tx, orgUnitId: string, stationCode: string, at: Date): Promise<string> {
  const year = istYear(at);
  // INSERT .. ON CONFLICT DO UPDATE takes a row lock on the counter: concurrent registrations serialise here.
  const { rows } = await sql<{ last_value: number }>`
    INSERT INTO evidence_number_counters (org_unit_id, year, last_value) VALUES (${orgUnitId}::uuid, ${year}, 1)
    ON CONFLICT (org_unit_id, year) DO UPDATE SET last_value = evidence_number_counters.last_value + 1
    RETURNING last_value`.execute(tx);
  const code = stationCode.toUpperCase().replace(/[^A-Z0-9]+/g, '');
  return `KSP-${code}-${year}-${String(rows[0]!.last_value).padStart(6, '0')}`;
}

async function loadEvidence(db: Database | Tx, id: string) {
  return db
    .selectFrom('evidence as e')
    .innerJoin('org_units as o', 'o.id', 'e.org_unit_id')
    .select([
      'e.id', 'e.status', 'e.status_reason', 'e.org_unit_id', 'e.sha256', 'e.sha512', 'e.size_bytes', 'e.created_at', 'e.upload_session_id',
      'e.storage_bucket', 'e.storage_key', 'e.storage_tier', 'e.registered_at', 'e.media_status', 'e.mime_type', 'e.gps_latitude', 'e.recorded_at',
      'e.original_filename', 'e.duplicate_of', 'e.uploaded_by',
      'o.code as station_code', 'o.latitude as station_lat', 'o.longitude as station_lon',
    ])
    .where('e.id', '=', id)
    .executeTakeFirst();
}

async function quarantine(deps: IngestDeps, evidenceId: string, orgUnitId: string, code: QuarantineReason, message: string, extra: Record<string, unknown> = {}): Promise<IngestOutcome> {
  await deps.db.transaction().execute(async (tx) => {
    await tx
      .updateTable('evidence')
      .set({ status: 'QUARANTINED', status_reason: formatStatusReason(code, message), ...(extra.duplicateOf ? { duplicate_of: extra.duplicateOf as string } : {}) })
      .where('id', '=', evidenceId)
      .where('registered_at', 'is', null)
      .execute();
    await appendAudit(tx, INGEST_ACTOR, {
      action: 'EVIDENCE_QUARANTINED',
      outcome: 'FAILURE',
      resourceType: 'evidence',
      resourceId: evidenceId,
      evidenceId,
      orgUnitId,
      details: { reason: code, message: message.slice(0, 1000), ...extra },
    });
  });
  deps.log?.warn({ evidenceId, reason: code }, 'evidence quarantined');
  return { outcome: 'QUARANTINED', evidenceId, reason: code, message };
}

/** Deterministic UUID (name-based, SHA-256) so a job can be sent at most once per evidence item. */
export function deterministicJobId(namespace: string, key: string): string {
  const h = createHash('sha256').update(`${namespace}:${key}`).digest('hex');
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Request derivative processing for a newly registered original. The job id is derived from the evidence
 * id, so retries of the finalize job (or of this call) never create a second MEDIA_PROCESS job.
 */
async function ensureMediaQueued(deps: IngestDeps, evidenceId: string): Promise<void> {
  const payload: MediaProcessPayload = { evidenceId };
  if (deps.enqueueMedia) {
    await deps.enqueueMedia(payload);
    return;
  }
  const boss = await getQueue();
  await boss.send(QUEUES.MEDIA_PROCESS, payload, { id: deterministicJobId(QUEUES.MEDIA_PROCESS, evidenceId), singletonKey: `media:${evidenceId}` });
}

async function deleteStaged(deps: IngestDeps, bucket: string | null, key: string | null): Promise<void> {
  if (!bucket || !key || bucket !== deps.storage.bucket('staging')) return;
  await deps.storage.delete(bucket, key).catch((err: unknown) => deps.log?.warn({ err, key }, 'staging cleanup failed (lifecycle rule will expire it)'));
}

/**
 * Run the complete finalize pipeline for a completed upload session. Safe to call repeatedly.
 */
export async function finalizeUpload(deps: IngestDeps, uploadSessionId: string): Promise<IngestOutcome> {
  const { db, storage } = deps;
  const session = await db.selectFrom('upload_sessions').selectAll().where('id', '=', uploadSessionId).executeTakeFirst();
  if (!session) throw new IngestError(`upload session ${uploadSessionId} not found`, true);
  if (session.status !== 'COMPLETED' || !session.evidence_id) {
    deps.log?.warn({ uploadSessionId, status: session.status }, 'finalize skipped: session not completed');
    return { outcome: 'NOOP', evidenceId: session.evidence_id, status: null };
  }
  const ev = await loadEvidence(db, session.evidence_id);
  if (!ev) throw new IngestError(`evidence for session ${uploadSessionId} not found`, true);
  if (SETTLED.has(ev.status)) {
    // Retry after a crash between commit and follow-ups: make sure media processing was requested.
    if (ev.status === 'REGISTERED' && ev.media_status === 'PENDING') {
      await ensureMediaQueued(deps, ev.id);
      await deleteStaged(deps, session.staging_bucket, session.staging_key);
    }
    return { outcome: 'NOOP', evidenceId: ev.id, status: ev.status };
  }

  await db.updateTable('evidence').set({ status: 'VALIDATING' }).where('id', '=', ev.id).where('status', 'in', ['RECEIVED', 'VALIDATING']).execute();
  await deps.onProgress?.(0.05);

  // 1. Hash the staged object once (SHA-256 + SHA-512).
  const staged = await storage.head(session.staging_bucket, session.staging_key);
  if (!staged) throw new IngestError(`staged object for session ${uploadSessionId} is missing`);
  const h = await storage.hashObject(session.staging_bucket, session.staging_key);
  if (h.size !== Number(session.declared_size)) {
    return quarantine(deps, ev.id, ev.org_unit_id, 'CORRUPT', `Stored upload is ${h.size} bytes but ${session.declared_size} were declared`);
  }
  const declaredMatch = session.declared_sha256 ? session.declared_sha256 === h.sha256 : null;
  await db.transaction().execute(async (tx) => {
    await tx.updateTable('evidence').set({ sha256: h.sha256, sha512: h.sha512 }).where('id', '=', ev.id).where('registered_at', 'is', null).execute();
    await appendAudit(tx, INGEST_ACTOR, {
      action: 'EVIDENCE_HASHED',
      resourceType: 'evidence',
      resourceId: ev.id,
      evidenceId: ev.id,
      orgUnitId: ev.org_unit_id,
      details: { sha256: h.sha256, sha512: h.sha512, sizeBytes: h.size, declaredSha256: session.declared_sha256, declaredMatch },
    });
  });
  await deps.onProgress?.(0.35);
  if (declaredMatch === false) {
    return quarantine(deps, ev.id, ev.org_unit_id, 'HASH_MISMATCH', `Client declared ${session.declared_sha256} but the server computed ${h.sha256}`, {
      declaredSha256: session.declared_sha256,
      computedSha256: h.sha256,
    });
  }

  // 2. Probe + decode integrity check through an internal (never client-visible) presigned URL.
  const url = await storage.internalUrl(session.staging_bucket, session.staging_key, 3600);
  const inspected = await inspectMedia(url);
  await deps.onProgress?.(0.55);

  // 3. Technical metadata (also stored for quarantined items when the file could be probed).
  if (inspected.probe) await storeMetadata(deps, ev, inspected.meta, inspected.probe);
  if (!inspected.ok) {
    await appendAudit(db, INGEST_ACTOR, {
      action: 'EVIDENCE_VALIDATION_FAILED',
      outcome: 'FAILURE',
      resourceType: 'evidence',
      resourceId: ev.id,
      evidenceId: ev.id,
      orgUnitId: ev.org_unit_id,
      details: { reason: inspected.code, message: inspected.message.slice(0, 1000) },
    });
    return quarantine(deps, ev.id, ev.org_unit_id, inspected.code, inspected.message);
  }
  await appendAudit(db, INGEST_ACTOR, {
    action: 'EVIDENCE_VALIDATED',
    resourceType: 'evidence',
    resourceId: ev.id,
    evidenceId: ev.id,
    orgUnitId: ev.org_unit_id,
    details: { container: inspected.meta.containerFormat, videoCodec: inspected.meta.videoCodec, durationMs: inspected.meta.durationMs, decodeCheck: 'PASSED' },
  });

  // 4. Duplicate detection: an EARLIER non-disposed, non-rejected item with the same SHA-256.
  const dup = await db
    .selectFrom('evidence')
    .select(['id', 'evidence_number', 'status'])
    .where('sha256', '=', h.sha256)
    .where('id', '<>', ev.id)
    .where('status', 'not in', ['DISPOSED', 'REJECTED'])
    .where((eb) => eb.or([eb('created_at', '<', ev.created_at), eb.and([eb('created_at', '=', ev.created_at), eb('id', '<', ev.id)])]))
    .orderBy('created_at')
    .limit(1)
    .executeTakeFirst();
  if (dup) {
    await appendAudit(db, INGEST_ACTOR, {
      action: 'EVIDENCE_DUPLICATE_DETECTED',
      resourceType: 'evidence',
      resourceId: ev.id,
      evidenceId: ev.id,
      orgUnitId: ev.org_unit_id,
      details: { duplicateOf: dup.id, duplicateOfNumber: dup.evidence_number, sha256: h.sha256 },
    });
    return quarantine(deps, ev.id, ev.org_unit_id, 'DUPLICATE', `Identical to existing evidence ${dup.evidence_number ?? dup.id} (${dup.status})`, { duplicateOf: dup.id });
  }

  // 5. Register.
  return registerEvidence(deps, ev.id, INGEST_ACTOR);
}

async function storeMetadata(deps: IngestDeps, ev: NonNullable<Awaited<ReturnType<typeof loadEvidence>>>, meta: ExtractedMetadata | null, probeJson: unknown): Promise<void> {
  const session = ev.upload_session_id
    ? await deps.db.selectFrom('upload_sessions').select(['declared_metadata']).where('id', '=', ev.upload_session_id).executeTakeFirst()
    : undefined;
  const declared = (session?.declared_metadata ?? {}) as { recordedAt?: string; latitude?: number; longitude?: number };
  const declaredRecorded = declared.recordedAt ? new Date(declared.recordedAt) : null;
  const recordedAt = declaredRecorded && !Number.isNaN(declaredRecorded.getTime()) ? declaredRecorded : meta?.creationTime ?? null;
  let gps: { lat: number | null; lon: number | null; source: string | null } = { lat: null, lon: null, source: null };
  if (meta?.gps) gps = { lat: meta.gps.lat, lon: meta.gps.lon, source: 'CONTAINER_TAG' };
  else if (typeof declared.latitude === 'number' && typeof declared.longitude === 'number') gps = { lat: declared.latitude, lon: declared.longitude, source: 'DECLARED' };
  else if (ev.station_lat != null && ev.station_lon != null) gps = { lat: ev.station_lat, lon: ev.station_lon, source: 'STATION' };
  const values = {
    probe: JSON.stringify(probeJson),
    duration_ms: meta?.durationMs ?? null,
    container_format: meta?.containerFormat ?? null,
    video_codec: meta?.videoCodec ?? null,
    audio_codec: meta?.audioCodec ?? null,
    width: meta?.width ?? null,
    height: meta?.height ?? null,
    frame_rate: meta?.frameRate ?? null,
    bit_rate: meta?.bitRate ?? null,
    mime_type: meta?.mimeType ?? ev.mime_type,
    recorded_at: recordedAt,
    recorded_end_at: recordedAt && meta?.durationMs ? new Date(recordedAt.getTime() + meta.durationMs) : null,
    gps_latitude: gps.lat,
    gps_longitude: gps.lon,
    gps_source: gps.source,
    device_metadata: JSON.stringify(meta?.deviceMetadata ?? {}),
  };
  await deps.db.transaction().execute(async (tx) => {
    await tx.updateTable('evidence').set(values).where('id', '=', ev.id).where('registered_at', 'is', null).execute();
    await appendAudit(tx, INGEST_ACTOR, {
      action: 'EVIDENCE_METADATA_EXTRACTED',
      resourceType: 'evidence',
      resourceId: ev.id,
      evidenceId: ev.id,
      orgUnitId: ev.org_unit_id,
      details: {
        durationMs: values.duration_ms,
        container: values.container_format,
        videoCodec: values.video_codec,
        audioCodec: values.audio_codec,
        width: values.width,
        height: values.height,
        frameRate: values.frame_rate,
        recordedAt: recordedAt?.toISOString() ?? null,
        recordedAtSource: declaredRecorded ? 'DECLARED' : meta?.creationTime ? 'CONTAINER_TAG' : null,
        gpsSource: gps.source,
        deviceTags: Object.keys(meta?.deviceMetadata ?? {}),
      },
    });
  });
}

export interface RegisterOptions {
  /** Quarantine release: allowed from QUARANTINED; this audit is written in the registration transaction. */
  release?: { reason: string; previousReason: string | null };
}

/**
 * Move a validated (or released) item into immutable storage and register it. Idempotent.
 */
export async function registerEvidence(deps: IngestDeps, evidenceId: string, actor: AuditActor, opts: RegisterOptions = {}): Promise<IngestOutcome> {
  const { db, storage } = deps;
  const ev = await loadEvidence(db, evidenceId);
  if (!ev) throw new IngestError(`evidence ${evidenceId} not found`, true);
  if (ev.registered_at || ev.status === 'REGISTERED') {
    return { outcome: 'NOOP', evidenceId, status: ev.status };
  }
  const allowed = opts.release ? ['QUARANTINED'] : ['VALIDATING', 'RECEIVED'];
  if (!allowed.includes(ev.status)) throw new IngestError(`evidence ${evidenceId} is ${ev.status}; cannot register`, true);
  if (!ev.storage_bucket || !ev.storage_key) throw new IngestError(`evidence ${evidenceId} has no staged object`, true);

  // Hash if the item never got that far (e.g. released after a processing failure).
  let sha256 = ev.sha256;
  let sha512 = ev.sha512;
  if (!sha256 || !sha512) {
    const h = await storage.hashObject(ev.storage_bucket, ev.storage_key);
    if (h.size !== Number(ev.size_bytes)) throw new IngestError(`staged object is ${h.size} bytes, expected ${ev.size_bytes}`, true);
    sha256 = h.sha256;
    sha512 = h.sha512;
    await db.transaction().execute(async (tx) => {
      await tx.updateTable('evidence').set({ sha256, sha512 }).where('id', '=', evidenceId).where('registered_at', 'is', null).execute();
      await appendAudit(tx, actor, { action: 'EVIDENCE_HASHED', resourceType: 'evidence', resourceId: evidenceId, evidenceId, orgUnitId: ev.org_unit_id, details: { sha256, sha512, sizeBytes: h.size } });
    });
  }

  const bucket = storage.bucket('evidence');
  const key = originalKey(ev.created_at, evidenceId, sha256);
  const copy = await wormCopy(
    storage,
    { bucket: ev.storage_bucket, key: ev.storage_key, size: Number(ev.size_bytes) },
    { bucket, key, contentType: ev.mime_type ?? 'application/octet-stream', metadata: { 'evidence-id': evidenceId, sha256 } },
    { partSize: deps.copyPartSize },
  );
  await deps.onProgress?.(0.8);

  // Re-hash what was actually stored and compare with the registered hash before accepting it.
  const stored = await storage.hashObject(bucket, key, copy.versionId ?? undefined);
  const ok = stored.sha256 === sha256 && stored.sha512 === sha512 && stored.size === Number(ev.size_bytes);
  if (!ok) {
    await db.transaction().execute(async (tx) => {
      await tx.insertInto('integrity_checks').values({ evidence_id: evidenceId, trigger: 'REGISTRATION', expected_sha256: sha256, actual_sha256: stored.sha256, ok: false, error: 'stored copy differs from staged upload' }).execute();
      await appendAudit(tx, actor, {
        action: 'EVIDENCE_INTEGRITY_FAILED',
        outcome: 'FAILURE',
        resourceType: 'evidence',
        resourceId: evidenceId,
        evidenceId,
        orgUnitId: ev.org_unit_id,
        details: { stage: 'REGISTRATION', expectedSha256: sha256, actualSha256: stored.sha256, reusedExisting: copy.reused },
      });
    });
    throw new IngestError(`stored original hash mismatch for ${evidenceId} (expected ${sha256}, got ${stored.sha256})`);
  }

  const now = new Date();
  const result = await db.transaction().execute(async (tx) => {
    // Lock the row; a concurrent attempt that registered first wins and this one becomes a NOOP.
    const cur = await tx.selectFrom('evidence').select(['status', 'registered_at', 'evidence_number']).where('id', '=', evidenceId).forUpdate().executeTakeFirstOrThrow();
    if (cur.registered_at) return { outcome: 'NOOP' as const, evidenceNumber: cur.evidence_number };
    if (!allowed.includes(cur.status)) throw new IngestError(`evidence ${evidenceId} changed to ${cur.status} during registration`, true);
    const policy = await tx.selectFrom('retention_policies').select(['id', 'code', 'retention_days']).where('is_default', '=', true).executeTakeFirst();
    const retainUntil = policy?.retention_days ? new Date(now.getTime() + policy.retention_days * 86_400_000) : null;
    const evidenceNumber = await nextEvidenceNumber(tx, ev.org_unit_id, ev.station_code, now);
    const gpsFallback = ev.gps_latitude == null && ev.station_lat != null && ev.station_lon != null
      ? { gps_latitude: ev.station_lat, gps_longitude: ev.station_lon, gps_source: 'STATION' }
      : {};
    if (opts.release) {
      await appendAudit(tx, actor, {
        action: 'EVIDENCE_QUARANTINE_RELEASED',
        resourceType: 'evidence',
        resourceId: evidenceId,
        evidenceId,
        orgUnitId: ev.org_unit_id,
        details: { reason: opts.release.reason, previousStatusReason: opts.release.previousReason },
      });
    }
    await tx
      .updateTable('evidence')
      .set({
        status: 'REGISTERED',
        status_reason: null,
        evidence_number: evidenceNumber,
        storage_bucket: bucket,
        storage_key: key,
        storage_version_id: copy.versionId,
        storage_tier: 'ACTIVE',
        object_lock_until: copy.lockUntil,
        retention_policy_id: policy?.id ?? null,
        retain_until: retainUntil,
        registered_at: now,
        last_verified_at: now,
        ...gpsFallback,
      })
      .where('id', '=', evidenceId)
      .execute();
    // Storage copy registry (migration 0300, owned by the lifecycle module): the original is the CURRENT copy.
    await tx
      .insertInto('evidence_storage_copies')
      .values({ evidence_id: evidenceId, tier: 'ACTIVE', bucket, object_key: key, version_id: copy.versionId, sha256, status: 'CURRENT', object_lock_until: copy.lockUntil })
      .onConflict((oc) => oc.columns(['bucket', 'object_key', 'version_id']).doUpdateSet({ status: 'CURRENT' }))
      .execute();
    await tx.insertInto('integrity_checks').values({ evidence_id: evidenceId, trigger: 'REGISTRATION', expected_sha256: sha256, actual_sha256: stored.sha256, ok: true }).execute();
    await appendAudit(tx, actor, {
      action: 'EVIDENCE_STORED',
      resourceType: 'evidence',
      resourceId: evidenceId,
      evidenceId,
      orgUnitId: ev.org_unit_id,
      details: {
        tier: 'ACTIVE',
        versionId: copy.versionId,
        objectLockMode: storage.cfg.OBJECT_LOCK_MODE,
        objectLockUntil: copy.lockUntil?.toISOString() ?? null,
        storedSha256: stored.sha256,
        storedSha512: stored.sha512,
        verified: true,
        reusedExistingObject: copy.reused,
      },
    });
    await appendAudit(tx, actor, {
      action: 'EVIDENCE_REGISTERED',
      resourceType: 'evidence',
      resourceId: evidenceId,
      evidenceId,
      orgUnitId: ev.org_unit_id,
      details: {
        evidenceNumber,
        sha256,
        sizeBytes: Number(ev.size_bytes),
        retentionPolicy: policy?.code ?? null,
        retainUntil: retainUntil?.toISOString() ?? null,
        released: !!opts.release,
        duplicateOf: ev.duplicate_of,
      },
    });
    return { outcome: 'REGISTERED' as const, evidenceNumber };
  });
  if (result.outcome === 'NOOP') return { outcome: 'NOOP', evidenceId, status: 'REGISTERED' };

  await deps.onProgress?.(0.95);
  await deleteStaged(deps, ev.storage_bucket, ev.storage_key);
  await ensureMediaQueued(deps, evidenceId);
  deps.log?.info({ evidenceId, evidenceNumber: result.evidenceNumber }, 'evidence registered');
  return { outcome: 'REGISTERED', evidenceId, evidenceNumber: result.evidenceNumber, sha256 };
}

/** Reject a quarantined item: REJECTED, staged object deleted, record (and its audit trail) kept forever. */
export async function rejectQuarantined(deps: IngestDeps, evidenceId: string, actor: AuditActor, reason: string): Promise<void> {
  const ev = await loadEvidence(deps.db, evidenceId);
  if (!ev) throw new IngestError(`evidence ${evidenceId} not found`, true);
  if (ev.status !== 'QUARANTINED') throw new IngestError(`evidence ${evidenceId} is ${ev.status}, not QUARANTINED`, true);
  await deps.db.transaction().execute(async (tx) => {
    const res = await tx
      .updateTable('evidence')
      .set({ status: 'REJECTED', storage_bucket: null, storage_key: null })
      .where('id', '=', evidenceId)
      .where('status', '=', 'QUARANTINED')
      .where('registered_at', 'is', null)
      .executeTakeFirst();
    if (!res.numUpdatedRows) throw new IngestError(`evidence ${evidenceId} changed state concurrently`, true);
    await appendAudit(tx, actor, {
      action: 'EVIDENCE_REJECTED',
      resourceType: 'evidence',
      resourceId: evidenceId,
      evidenceId,
      orgUnitId: ev.org_unit_id,
      details: { reason, previousStatusReason: ev.status_reason, stagedObjectDeleted: true, sha256: ev.sha256 },
    });
  });
  await deleteStaged(deps, ev.storage_bucket, ev.storage_key);
}

/**
 * Final failure after all retries: quarantine for manual review (PROCESSING_FAILED) so nothing is lost,
 * and mark the upload session's error. Returns the evidence id (if any).
 */
export async function markIngestFailed(deps: IngestDeps, uploadSessionId: string, error: string): Promise<{ evidenceId: string | null; orgUnitId: string | null }> {
  const session = await deps.db.selectFrom('upload_sessions').select(['evidence_id', 'org_unit_id']).where('id', '=', uploadSessionId).executeTakeFirst();
  if (!session) return { evidenceId: null, orgUnitId: null };
  await deps.db.updateTable('upload_sessions').set({ error: error.slice(0, 2000) }).where('id', '=', uploadSessionId).execute();
  if (session.evidence_id) {
    const ev = await deps.db.selectFrom('evidence').select(['status']).where('id', '=', session.evidence_id).executeTakeFirst();
    if (ev && (ev.status === 'RECEIVED' || ev.status === 'VALIDATING')) {
      await quarantine(deps, session.evidence_id, session.org_unit_id, 'PROCESSING_FAILED', error.slice(0, 800));
    }
  }
  return { evidenceId: session.evidence_id, orgUnitId: session.org_unit_id };
}
