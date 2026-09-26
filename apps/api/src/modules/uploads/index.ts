/**
 * Evidence ingestion API: resumable, chunked, concurrent uploads (S3 multipart under the hood) and the
 * quarantine review queue. See docs/INGESTION.md.
 *
 *   POST   /uploads/batches                         create an upload batch for a station
 *   GET    /uploads/batches/:id                     batch + its sessions
 *   POST   /uploads                                 initiate an upload session
 *   GET    /uploads                                 recent sessions (mine | station)
 *   GET    /uploads/:id                             session status + received part numbers (resume)
 *   PUT    /uploads/:id/parts/:n                    upload one chunk (application/octet-stream, x-chunk-sha256)
 *   POST   /uploads/:id/complete                    assemble, create evidence (RECEIVED), enqueue finalize
 *   DELETE /uploads/:id                             abort
 *   GET    /uploads/quarantine                      quarantined evidence in scope
 *   POST   /uploads/quarantine/:evidenceId/release  register despite the quarantine finding (reason required)
 *   POST   /uploads/quarantine/:evidenceId/reject   reject (REJECTED; staged object deleted; record kept)
 */
import { createHash, randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';
import {
  ALLOWED_UPLOAD_EXTENSIONS,
  CHUNK_SHA256_HEADER,
  MAX_CHUNKS,
  MAX_CHUNK_SIZE,
  MIN_CHUNK_SIZE,
  QUEUES,
  expectedPartSize,
  parseStatusReason,
  totalChunksFor,
  type IngestFinalizePayload,
  type UploadSessionView,
} from '@ksp/shared';
import { IngestError, appendAudit, enqueue, registerEvidence, rejectQuarantined, type Database, type IngestDeps } from '@ksp/core';
import { hasPermission, hasPermissionAt, scopePaths, type Principal } from '../../lib/principal.js';
import { evidenceVisibleSql, loadEvidenceFor, orgScopeSql } from '../../lib/access.js';
import { AppError, badRequest, conflict, forbidden, gone, notFound } from '../../lib/errors.js';
import { getSettings } from '../../lib/settings.js';

export const prefix = '/uploads';

const MiB = 1024 * 1024;
const uuid = z.string().uuid();
const isoDate = z.string().datetime({ offset: true });

const metadataSchema = z
  .object({
    title: z.string().trim().max(300).optional(),
    description: z.string().trim().max(5000).optional(),
    category: z.string().trim().max(100).optional(),
    officerBadge: z.string().trim().min(1).max(64).optional(),
    officerId: uuid.optional(),
    deviceSerial: z.string().trim().min(1).max(128).optional(),
    recordedAt: isoDate.optional(),
    incidentAt: isoDate.optional(),
    locationText: z.string().trim().max(500).optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    notes: z.string().trim().max(5000).optional(),
  })
  .strict()
  .refine((m) => (m.latitude === undefined) === (m.longitude === undefined), { message: 'latitude and longitude must be provided together' });

const listQuery = z.object({
  scope: z.enum(['mine', 'station']).default('mine'),
  orgUnitId: uuid.optional(),
  batchId: uuid.optional(),
  status: z.string().max(20).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

type SessionRow = {
  id: string;
  batch_id: string | null;
  org_unit_id: string;
  org_name: string;
  original_filename: string;
  declared_size: number;
  declared_mime: string | null;
  declared_sha256: string | null;
  chunk_size: number;
  total_chunks: number;
  received_bytes: number;
  status: string;
  error: string | null;
  created_by: string;
  creator_name: string;
  created_at: Date;
  updated_at: Date;
  expires_at: Date;
  e_id: string | null;
  e_number: string | null;
  e_status: string | null;
  e_reason: string | null;
  e_sha256: string | null;
};

function toView(r: SessionRow, receivedParts?: number[]): UploadSessionView {
  return {
    id: r.id,
    batchId: r.batch_id,
    orgUnitId: r.org_unit_id,
    orgUnitName: r.org_name,
    filename: r.original_filename,
    size: Number(r.declared_size),
    mimeType: r.declared_mime,
    declaredSha256: r.declared_sha256,
    chunkSize: r.chunk_size,
    totalChunks: r.total_chunks,
    receivedBytes: Number(r.received_bytes),
    ...(receivedParts ? { receivedParts } : {}),
    status: r.status,
    error: r.error,
    createdBy: r.created_by,
    createdByName: r.creator_name,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
    evidence: r.e_id
      ? { id: r.e_id, evidenceNumber: r.e_number, status: r.e_status!, statusReason: r.e_reason, reasonCode: parseStatusReason(r.e_reason).code, sha256: r.e_sha256 }
      : null,
  };
}

/** Session rows joined with station + creator + (visible) evidence summary. */
function sessionQuery(db: Database, p: Principal) {
  return db
    .selectFrom('upload_sessions as s')
    .innerJoin('org_units as o', 'o.id', 's.org_unit_id')
    .innerJoin('users as u', 'u.id', 's.created_by')
    .leftJoin('evidence as e', (j) => j.onRef('e.id', '=', 's.evidence_id').on(evidenceVisibleSql(p, 'e')))
    .select([
      's.id', 's.batch_id', 's.org_unit_id', 'o.name as org_name', 'o.path as org_path', 's.original_filename', 's.declared_size', 's.declared_mime',
      's.declared_sha256', 's.chunk_size', 's.total_chunks', 's.received_bytes', 's.status', 's.error', 's.created_by', 'u.full_name as creator_name',
      's.created_at', 's.updated_at', 's.expires_at', 'e.id as e_id', 'e.evidence_number as e_number', 'e.status as e_status',
      'e.status_reason as e_reason', 'e.sha256 as e_sha256',
    ]);
}

function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  return base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255);
}

function userId(p: Principal): string {
  if (!p.userId) throw forbidden('Uploads must be performed by a named user account');
  return p.userId;
}

async function loadStation(db: Database, p: Principal, orgUnitId: string) {
  const org = await db.selectFrom('org_units').select(['id', 'code', 'name', 'path', 'unit_type', 'active']).where('id', '=', orgUnitId).executeTakeFirst();
  // Out-of-jurisdiction and non-existent are indistinguishable (404).
  if (!org || !hasPermissionAt(p, 'evidence:upload', org.path)) throw notFound('Station');
  if (!org.active) throw badRequest('Station is inactive');
  if (org.unit_type !== 'STATION' && org.unit_type !== 'UNIT') throw badRequest('Evidence must be uploaded to a police station or unit');
  return org;
}

export default async function uploads(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const deps = (): IngestDeps => ({ db: app.db, storage: app.storage, cfg: app.cfg, log: app.log });

  async function enqueueFinalize(sessionId: string): Promise<void> {
    const payload: IngestFinalizePayload = { uploadSessionId: sessionId };
    await enqueue(QUEUES.INGEST_FINALIZE, payload, { singletonKey: `ingest:${sessionId}` });
  }

  /** Load a session the caller may act on as its creator (anyone else: 404). */
  async function ownSession(req: FastifyRequest, id: string) {
    const uid = userId(req.requirePrincipal());
    const s = await app.db.selectFrom('upload_sessions').selectAll().where('id', '=', id).where('created_by', '=', uid).executeTakeFirst();
    if (!s) throw notFound('Upload session');
    return s;
  }

  async function viewFor(p: Principal, id: string, withParts: boolean): Promise<UploadSessionView> {
    const r = (await sessionQuery(app.db, p).where('s.id', '=', id).executeTakeFirst()) as (SessionRow & { org_path: string }) | undefined;
    if (!r || (r.created_by !== p.userId && !hasPermissionAt(p, 'evidence:read', r.org_path))) throw notFound('Upload session');
    const parts = withParts
      ? (await app.db.selectFrom('upload_parts').select('part_number').where('session_id', '=', id).orderBy('part_number').execute()).map((x) => x.part_number)
      : undefined;
    return toView(r, parts);
  }

  // ---- batches ----------------------------------------------------------------------------------
  app.post('/batches', {
    preHandler: app.authorize('evidence:upload'),
    schema: {
      tags: ['uploads'],
      summary: 'Create an upload batch for a station',
      body: z.object({ orgUnitId: uuid, label: z.string().trim().max(200).optional(), clientInfo: z.record(z.union([z.string().max(500), z.number(), z.boolean()])).optional() }).strict(),
    },
  }, async (req, reply) => {
    const p = req.requirePrincipal();
    const uid = userId(p);
    const org = await loadStation(app.db, p, req.body.orgUnitId);
    const clientInfo = { ...(req.body.clientInfo ?? {}), userAgent: (req.headers['user-agent'] ?? '').slice(0, 300) };
    const row = await app.db
      .insertInto('upload_batches')
      .values({ org_unit_id: org.id, created_by: uid, label: req.body.label || null, client_info: JSON.stringify(clientInfo) })
      .returning(['id', 'org_unit_id', 'label', 'client_info', 'created_at'])
      .executeTakeFirstOrThrow();
    reply.status(201);
    return { id: row.id, orgUnitId: row.org_unit_id, orgUnitName: org.name, label: row.label, clientInfo: row.client_info, createdAt: row.created_at.toISOString() };
  });

  app.get('/batches/:id', {
    preHandler: app.authorize('evidence:upload'),
    schema: { tags: ['uploads'], summary: 'Upload batch with its sessions', params: z.object({ id: uuid }) },
  }, async (req) => {
    const p = req.requirePrincipal();
    const b = await app.db
      .selectFrom('upload_batches as b')
      .innerJoin('org_units as o', 'o.id', 'b.org_unit_id')
      .select(['b.id', 'b.org_unit_id', 'o.name as org_name', 'o.path as org_path', 'b.label', 'b.client_info', 'b.created_by', 'b.created_at'])
      .where('b.id', '=', req.params.id)
      .executeTakeFirst();
    if (!b || (b.created_by !== p.userId && !hasPermissionAt(p, 'evidence:read', b.org_path))) throw notFound('Upload batch');
    const rows = (await sessionQuery(app.db, p).where('s.batch_id', '=', b.id).orderBy('s.created_at').execute()) as SessionRow[];
    const items = rows.map((r) => toView(r));
    const count = (pred: (v: UploadSessionView) => boolean) => items.filter(pred).length;
    return {
      id: b.id,
      orgUnitId: b.org_unit_id,
      orgUnitName: b.org_name,
      label: b.label,
      clientInfo: b.client_info,
      createdAt: b.created_at.toISOString(),
      summary: {
        total: items.length,
        registered: count((v) => v.evidence?.status === 'REGISTERED'),
        quarantined: count((v) => v.evidence?.status === 'QUARANTINED'),
        processing: count((v) => v.status === 'COMPLETED' && (!v.evidence || ['RECEIVED', 'VALIDATING'].includes(v.evidence.status))),
        uploading: count((v) => ['INITIATED', 'UPLOADING', 'COMPLETING'].includes(v.status)),
        failed: count((v) => ['FAILED', 'ABORTED', 'EXPIRED'].includes(v.status) || v.evidence?.status === 'REJECTED'),
      },
      items,
    };
  });

  // ---- quarantine (registered before /:id so the static path wins) --------------------------------
  app.get('/quarantine', {
    preHandler: app.authorize('evidence:quarantine_manage'),
    schema: {
      tags: ['uploads'],
      summary: 'Quarantined evidence awaiting review',
      querystring: z.object({
        orgUnitId: uuid.optional(),
        reason: z.string().max(40).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(25),
      }),
    },
  }, async (req) => {
    const p = req.requirePrincipal();
    const { orgUnitId, reason, page, pageSize } = req.query;
    let q = app.db
      .selectFrom('evidence as e')
      .innerJoin('org_units as o', 'o.id', 'e.org_unit_id')
      .innerJoin('users as u', 'u.id', 'e.uploaded_by')
      .leftJoin('evidence as d', 'd.id', 'e.duplicate_of')
      .where('e.status', '=', 'QUARANTINED')
      .where(orgScopeSql(p, 'evidence:quarantine_manage', 'e.org_path'))
      .where(evidenceVisibleSql(p, 'e'));
    if (orgUnitId) q = q.where(sql<boolean>`e.org_path <@ (SELECT path FROM org_units WHERE id = ${orgUnitId}::uuid)`);
    if (reason) q = q.where('e.status_reason', 'like', `${reason.replace(/[^A-Z_]/g, '')}:%`);
    const total = Number((await q.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
    const rows = await q
      .select([
        'e.id', 'e.original_filename', 'e.size_bytes', 'e.sha256', 'e.status_reason', 'e.duplicate_of', 'd.evidence_number as duplicate_number',
        'e.org_unit_id', 'o.name as org_name', 'e.uploaded_by', 'u.full_name as uploader_name', 'e.created_at', 'e.updated_at', 'e.container_format',
        'e.video_codec', 'e.duration_ms', 'e.title', 'e.upload_session_id',
      ])
      .orderBy('e.updated_at', 'desc')
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .execute();
    return {
      items: rows.map((r) => {
        const pr = parseStatusReason(r.status_reason);
        return {
          id: r.id,
          title: r.title,
          originalFilename: r.original_filename,
          sizeBytes: Number(r.size_bytes),
          sha256: r.sha256,
          statusReason: r.status_reason,
          reasonCode: pr.code,
          reasonMessage: pr.message,
          duplicateOf: r.duplicate_of ? { id: r.duplicate_of, evidenceNumber: r.duplicate_number } : null,
          orgUnitId: r.org_unit_id,
          orgUnitName: r.org_name,
          uploadedBy: { id: r.uploaded_by, name: r.uploader_name },
          uploadSessionId: r.upload_session_id,
          containerFormat: r.container_format,
          videoCodec: r.video_codec,
          durationMs: r.duration_ms == null ? null : Number(r.duration_ms),
          createdAt: r.created_at.toISOString(),
          quarantinedAt: r.updated_at.toISOString(),
        };
      }),
      total,
      page,
      pageSize,
    };
  });

  async function quarantineTarget(req: FastifyRequest, evidenceId: string) {
    const p = req.requirePrincipal();
    const ev = await loadEvidenceFor(app.db, p, evidenceId, 'evidence:quarantine_manage', req.actor());
    // Quarantine decisions are jurisdictional: a relationship (own upload, case, share) is not enough.
    if (!hasPermissionAt(p, 'evidence:quarantine_manage', ev.org_path)) throw forbidden();
    if (ev.status !== 'QUARANTINED') throw conflict(`Evidence is ${ev.status}, not QUARANTINED`);
    // Separation of duties: the uploader cannot decide on their own quarantined upload.
    if (ev.uploaded_by === p.userId) throw new AppError(403, 'SEPARATION_OF_DUTIES', 'You cannot review your own upload');
    return ev;
  }

  const decisionSchema = { params: z.object({ evidenceId: uuid }), body: z.object({ reason: z.string().trim().min(5).max(2000) }).strict() };

  app.post('/quarantine/:evidenceId/release', {
    preHandler: app.authorize('evidence:quarantine_manage'),
    schema: { tags: ['uploads'], summary: 'Release a quarantined item and register it', ...decisionSchema },
  }, async (req) => {
    const ev = await quarantineTarget(req, req.params.evidenceId);
    const cur = await app.db.selectFrom('evidence').select('status_reason').where('id', '=', ev.id).executeTakeFirstOrThrow();
    try {
      const out = await registerEvidence(deps(), ev.id, req.actor(), { release: { reason: req.body.reason, previousReason: cur.status_reason } });
      const after = await app.db.selectFrom('evidence').select(['id', 'status', 'evidence_number']).where('id', '=', ev.id).executeTakeFirstOrThrow();
      return { id: after.id, status: after.status, evidenceNumber: after.evidence_number, outcome: out.outcome };
    } catch (err) {
      if (err instanceof IngestError && err.permanent) throw conflict(err.message);
      throw err;
    }
  });

  app.post('/quarantine/:evidenceId/reject', {
    preHandler: app.authorize('evidence:quarantine_manage'),
    schema: { tags: ['uploads'], summary: 'Reject a quarantined item (record kept, staged file deleted)', ...decisionSchema },
  }, async (req) => {
    const ev = await quarantineTarget(req, req.params.evidenceId);
    try {
      await rejectQuarantined(deps(), ev.id, req.actor(), req.body.reason);
    } catch (err) {
      if (err instanceof IngestError && err.permanent) throw conflict(err.message);
      throw err;
    }
    return { id: ev.id, status: 'REJECTED' };
  });

  // ---- sessions ---------------------------------------------------------------------------------
  app.post('/', {
    preHandler: app.authorize('evidence:upload'),
    // Per client IP (a station client initiates one session per file; 120/min is far above real ingest rates).
    config: { rateLimit: { max: app.cfg.NODE_ENV === 'test' ? 10_000 : 120, timeWindow: '1 minute' } },
    schema: {
      tags: ['uploads'],
      summary: 'Initiate a resumable upload session',
      body: z.object({
        batchId: uuid.optional(),
        orgUnitId: uuid,
        filename: z.string().min(1).max(1024),
        size: z.number().int().positive(),
        mimeType: z.string().trim().max(200).optional(),
        sha256: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
        chunkSize: z.number().int().positive().optional(),
        metadata: metadataSchema.optional(),
      }).strict(),
    },
  }, async (req, reply) => {
    const p = req.requirePrincipal();
    const uid = userId(p);
    const b = req.body;
    const org = await loadStation(app.db, p, b.orgUnitId);
    const filename = sanitizeFilename(b.filename);
    const ext = extname(filename).toLowerCase();
    if (!filename || !(ALLOWED_UPLOAD_EXTENSIONS as readonly string[]).includes(ext)) {
      throw new AppError(400, 'UNSUPPORTED_FILE_TYPE', `File type "${ext || filename}" is not accepted. Allowed: ${ALLOWED_UPLOAD_EXTENSIONS.join(', ')}`);
    }
    const settings = await getSettings(app.db);
    const policy = settings.uploadPolicy;
    if (b.size > policy.maxFileSizeBytes) {
      throw new AppError(413, 'FILE_TOO_LARGE', `File is larger than the maximum of ${policy.maxFileSizeBytes} bytes`, { maxFileSizeBytes: policy.maxFileSizeBytes });
    }
    if (b.batchId) {
      const batch = await app.db.selectFrom('upload_batches').select(['id', 'org_unit_id']).where('id', '=', b.batchId).where('created_by', '=', uid).executeTakeFirst();
      if (!batch) throw notFound('Upload batch');
      if (batch.org_unit_id !== org.id) throw badRequest('Batch belongs to a different station');
    }
    const open = await app.db
      .selectFrom('upload_sessions')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('created_by', '=', uid)
      .where('status', 'in', ['INITIATED', 'UPLOADING', 'COMPLETING'])
      .where('expires_at', '>', new Date())
      .executeTakeFirstOrThrow();
    if (Number(open.n) >= policy.maxConcurrentSessionsPerUser) {
      throw new AppError(429, 'UPLOAD_LIMIT', `You already have ${open.n} uploads in progress (limit ${policy.maxConcurrentSessionsPerUser}). Complete or cancel some first.`);
    }

    // Resolve declared officer / device now so mistakes surface before gigabytes are transferred.
    const md = b.metadata ?? {};
    let officerId: string | null = null;
    let deviceId: string | null = null;
    // SEC-13: the declared officer / device must belong to the uploader's upload jurisdiction (or, for officers, to a
    // unit above the target station). Otherwise any uploader could attribute footage to — and, via evidence:read_own,
    // make it visible to — any officer statewide, and probe badge numbers/serials across districts. Out-of-scope is
    // indistinguishable from unknown.
    const uploadScope = scopePaths(p, 'evidence:upload');
    const inScope = (col: string) => sql<boolean>`(${sql.ref(col)} <@ ${sql.val(uploadScope)}::ltree[])`;
    if (md.officerId || md.officerBadge) {
      let oq = app.db.selectFrom('users as u').innerJoin('org_units as ho', 'ho.id', 'u.home_org_unit_id').select(['u.id']).where('u.status', '=', 'ACTIVE')
        .where((eb) => eb.or([inScope('ho.path'), eb(sql<string>`${org.path}::ltree`, '<@', eb.ref('ho.path'))]));
      oq = md.officerId ? oq.where('u.id', '=', md.officerId) : oq.where(sql<boolean>`lower(u.badge_number) = lower(${md.officerBadge!})`);
      const officer = await oq.executeTakeFirst();
      if (!officer) throw new AppError(400, 'UNKNOWN_OFFICER', `No active officer found for ${md.officerId ? 'id' : 'badge'} "${md.officerId ?? md.officerBadge}"`);
      officerId = officer.id;
    }
    if (md.deviceSerial) {
      const device = await app.db.selectFrom('devices as d').innerJoin('org_units as dorg', 'dorg.id', 'd.org_unit_id').select(['d.id', 'd.assigned_officer_id', 'd.status'])
        .where(sql<boolean>`lower(d.serial_number) = lower(${md.deviceSerial})`).where(inScope('dorg.path')).executeTakeFirst();
      if (!device) throw new AppError(400, 'UNKNOWN_DEVICE', `No registered device with serial "${md.deviceSerial}"`);
      deviceId = device.id;
      officerId ??= device.assigned_officer_id;
    }

    let chunkSize = Math.min(MAX_CHUNK_SIZE, Math.max(MIN_CHUNK_SIZE, b.chunkSize ?? policy.chunkSizeBytes));
    if (Math.ceil(b.size / chunkSize) > MAX_CHUNKS) chunkSize = Math.ceil(b.size / MAX_CHUNKS / MiB) * MiB;
    const totalChunks = totalChunksFor(b.size, chunkSize);
    const id = randomUUID();
    const now = new Date();
    const stagingBucket = app.storage.bucket('staging');
    const stagingKey = `uploads/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${id}`;
    const s3UploadId = await app.storage.createMultipart(stagingBucket, stagingKey, 'application/octet-stream');
    const expiresAt = new Date(now.getTime() + policy.sessionTtlHours * 3600_000);
    const declared = { ...md, resolvedOfficerId: officerId, resolvedDeviceId: deviceId };
    try {
      await app.db.transaction().execute(async (tx) => {
        await tx
          .insertInto('upload_sessions')
          .values({
            id,
            batch_id: b.batchId ?? null,
            created_by: uid,
            org_unit_id: org.id,
            original_filename: filename,
            declared_size: b.size,
            declared_mime: b.mimeType || null,
            declared_sha256: b.sha256?.toLowerCase() ?? null,
            chunk_size: chunkSize,
            total_chunks: totalChunks,
            staging_bucket: stagingBucket,
            staging_key: stagingKey,
            s3_upload_id: s3UploadId,
            declared_metadata: JSON.stringify(declared),
            expires_at: expiresAt,
          })
          .execute();
        await appendAudit(tx, req.actor(), {
          action: 'UPLOAD_INITIATED',
          resourceType: 'upload_session',
          resourceId: id,
          orgUnitId: org.id,
          details: { filename, sizeBytes: b.size, declaredSha256: b.sha256?.toLowerCase() ?? null, batchId: b.batchId ?? null, chunkSize, totalChunks, officerId, deviceId },
        });
      });
    } catch (err) {
      await app.storage.abortMultipart(stagingBucket, stagingKey, s3UploadId);
      throw err;
    }
    reply.status(201);
    return { id, chunkSize, totalChunks, expiresAt: expiresAt.toISOString(), status: 'INITIATED' };
  });

  app.get('/', {
    preHandler: app.authorize('evidence:upload'),
    schema: { tags: ['uploads'], summary: 'Recent upload sessions (mine, or my stations with evidence:read)', querystring: listQuery },
  }, async (req) => {
    const p = req.requirePrincipal();
    const { scope, orgUnitId, batchId, status, page, pageSize } = req.query;
    let q = sessionQuery(app.db, p);
    if (scope === 'station') {
      if (!hasPermission(p, 'evidence:read')) throw forbidden();
      const paths = scopePaths(p, 'evidence:read');
      q = q.where(sql<boolean>`o.path <@ ${sql.val(paths)}::ltree[]`);
    } else {
      q = q.where('s.created_by', '=', userId(p));
    }
    if (orgUnitId) q = q.where(sql<boolean>`o.path <@ (SELECT path FROM org_units WHERE id = ${orgUnitId}::uuid)`);
    if (batchId) q = q.where('s.batch_id', '=', batchId);
    if (status) {
      if (['REGISTERED', 'QUARANTINED', 'REJECTED', 'VALIDATING', 'RECEIVED'].includes(status)) q = q.where('e.status', '=', status);
      else q = q.where('s.status', '=', status);
    }
    const total = Number((await q.clearSelect().select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
    const rows = (await q.orderBy('s.created_at', 'desc').limit(pageSize).offset((page - 1) * pageSize).execute()) as SessionRow[];
    return { items: rows.map((r) => toView(r)), total, page, pageSize };
  });

  app.get('/:id', {
    preHandler: app.authorize('evidence:upload'),
    schema: { tags: ['uploads'], summary: 'Upload session status and received parts (for resume)', params: z.object({ id: uuid }) },
  }, async (req) => viewFor(req.requirePrincipal(), req.params.id, true));

  app.put('/:id/parts/:n', {
    preHandler: app.authorize('evidence:upload'),
    schema: {
      tags: ['uploads'],
      summary: 'Upload one chunk (application/octet-stream) with its SHA-256 in x-chunk-sha256',
      params: z.object({ id: uuid, n: z.coerce.number().int().min(1).max(MAX_CHUNKS) }),
    },
  }, async (req) => {
    const s = await ownSession(req, req.params.id);
    const n = req.params.n;
    if (!(req.headers['content-type'] ?? '').startsWith('application/octet-stream')) throw badRequest('Chunks must be sent as application/octet-stream');
    const body = req.body;
    if (!Buffer.isBuffer(body)) throw badRequest('Missing chunk body');
    if (s.status !== 'INITIATED' && s.status !== 'UPLOADING') throw conflict(`Upload is ${s.status}; no more parts accepted`, { status: s.status });
    if (s.expires_at < new Date()) throw gone('Upload session has expired; start a new upload');
    if (n > s.total_chunks) throw badRequest(`Part ${n} is out of range (1..${s.total_chunks})`);
    const expected = expectedPartSize(Number(s.declared_size), s.chunk_size, n);
    if (body.length !== expected) throw new AppError(400, 'CHUNK_SIZE_MISMATCH', `Part ${n} must be ${expected} bytes, received ${body.length}`, { expected, received: body.length });
    const declared = String(req.headers[CHUNK_SHA256_HEADER] ?? '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(declared)) throw badRequest(`Header ${CHUNK_SHA256_HEADER} (hex SHA-256 of the chunk) is required`);
    const actual = createHash('sha256').update(body).digest('hex');
    if (actual !== declared) {
      throw new AppError(400, 'CHUNK_HASH_MISMATCH', `Part ${n} was corrupted in transit (SHA-256 mismatch); resend it`, { expected: declared, actual });
    }
    const etag = await app.storage.uploadPart(s.staging_bucket, s.staging_key, s.s3_upload_id!, n, body);
    const res = await app.db.transaction().execute(async (tx) => {
      const cur = await tx.selectFrom('upload_sessions').select(['status']).where('id', '=', s.id).forUpdate().executeTakeFirstOrThrow();
      if (cur.status !== 'INITIATED' && cur.status !== 'UPLOADING') throw conflict(`Upload is ${cur.status}; no more parts accepted`, { status: cur.status });
      await tx
        .insertInto('upload_parts')
        .values({ session_id: s.id, part_number: n, size_bytes: body.length, sha256: actual, etag })
        .onConflict((oc) => oc.columns(['session_id', 'part_number']).doUpdateSet({ size_bytes: body.length, sha256: actual, etag, received_at: new Date() }))
        .execute();
      const agg = await tx
        .selectFrom('upload_parts')
        .select((eb) => [eb.fn.sum<number>('size_bytes').as('bytes'), eb.fn.countAll<number>().as('parts')])
        .where('session_id', '=', s.id)
        .executeTakeFirstOrThrow();
      await tx.updateTable('upload_sessions').set({ received_bytes: Number(agg.bytes), status: 'UPLOADING' }).where('id', '=', s.id).execute();
      return { receivedBytes: Number(agg.bytes), receivedParts: Number(agg.parts) };
    });
    return { partNumber: n, size: body.length, sha256: actual, ...res, totalChunks: s.total_chunks };
  });

  app.post('/:id/complete', {
    preHandler: app.authorize('evidence:upload'),
    schema: { tags: ['uploads'], summary: 'Complete the upload: assemble parts, create the evidence record, start validation', params: z.object({ id: uuid }) },
  }, async (req) => {
    const p = req.requirePrincipal();
    const s = await ownSession(req, req.params.id);
    if (s.status === 'COMPLETED') {
      // Idempotent: make sure finalisation was requested (e.g. enqueue failed after commit).
      const ev = s.evidence_id ? await app.db.selectFrom('evidence').select('status').where('id', '=', s.evidence_id).executeTakeFirst() : undefined;
      if (ev?.status === 'RECEIVED') await enqueueFinalize(s.id);
      return viewFor(p, s.id, false);
    }
    if (!['INITIATED', 'UPLOADING', 'COMPLETING'].includes(s.status)) throw conflict(`Upload is ${s.status}`, { status: s.status });
    if (s.expires_at < new Date() && s.status !== 'COMPLETING') throw gone('Upload session has expired; start a new upload');

    const parts = await app.db.transaction().execute(async (tx) => {
      // Re-check the state under the row lock: a concurrent complete may have finished meanwhile (SEC-10: without
      // this, a racing request reset COMPLETED -> COMPLETING and registered a second evidence row).
      const cur = await tx.selectFrom('upload_sessions').select(['status']).where('id', '=', s.id).forUpdate().executeTakeFirstOrThrow();
      if (cur.status === 'COMPLETED') return null;
      if (!['INITIATED', 'UPLOADING', 'COMPLETING'].includes(cur.status)) throw conflict(`Upload is ${cur.status}`, { status: cur.status });
      const rows = await tx.selectFrom('upload_parts').select(['part_number', 'size_bytes', 'etag']).where('session_id', '=', s.id).orderBy('part_number').execute();
      const have = new Set(rows.map((r) => r.part_number));
      const missing: number[] = [];
      for (let i = 1; i <= s.total_chunks; i++) if (!have.has(i)) missing.push(i);
      const bytes = rows.reduce((a, r) => a + Number(r.size_bytes), 0);
      if (missing.length || bytes !== Number(s.declared_size)) {
        throw new AppError(400, 'UPLOAD_INCOMPLETE', `Upload is incomplete: ${missing.length} of ${s.total_chunks} parts missing`, {
          missingParts: missing.slice(0, 1000),
          receivedBytes: bytes,
          declaredSize: Number(s.declared_size),
        });
      }
      await tx.updateTable('upload_sessions').set({ status: 'COMPLETING' }).where('id', '=', s.id).execute();
      return rows;
    });
    if (!parts) return viewFor(p, s.id, false);

    try {
      await app.storage.completeMultipart(s.staging_bucket, s.staging_key, s.s3_upload_id!, parts.map((x) => ({ partNumber: x.part_number, etag: x.etag })));
    } catch (err) {
      // A previous attempt may have completed the multipart upload before crashing.
      const head = await app.storage.head(s.staging_bucket, s.staging_key);
      if (!head || Number(head.ContentLength) !== Number(s.declared_size)) {
        await app.db.updateTable('upload_sessions').set({ status: 'UPLOADING', error: (err as Error).message.slice(0, 1000) }).where('id', '=', s.id).execute();
        throw new AppError(502, 'STORAGE_ERROR', 'Could not assemble the uploaded parts; retry completing the upload');
      }
    }
    const head = await app.storage.head(s.staging_bucket, s.staging_key);
    if (!head || Number(head.ContentLength) !== Number(s.declared_size)) {
      await app.db.updateTable('upload_sessions').set({ status: 'FAILED', error: 'assembled object size mismatch' }).where('id', '=', s.id).execute();
      throw new AppError(500, 'STORAGE_ERROR', 'Assembled upload has an unexpected size');
    }

    const md = s.declared_metadata as Record<string, unknown> & { resolvedOfficerId?: string | null; resolvedDeviceId?: string | null };
    const org = await app.db.selectFrom('org_units').select(['id', 'path']).where('id', '=', s.org_unit_id).executeTakeFirstOrThrow();
    const str = (k: string) => (typeof md[k] === 'string' && md[k] ? (md[k] as string) : null);
    const lat = typeof md.latitude === 'number' ? md.latitude : null;
    const lon = typeof md.longitude === 'number' ? md.longitude : null;
    const evidenceId = await app.db.transaction().execute(async (tx) => {
      const cur = await tx.selectFrom('upload_sessions').select(['status', 'evidence_id']).where('id', '=', s.id).forUpdate().executeTakeFirstOrThrow();
      if (cur.evidence_id) return cur.evidence_id;
      const ev = await tx
        .insertInto('evidence')
        .values({
          status: 'RECEIVED',
          org_unit_id: s.org_unit_id,
          org_path: org.path,
          upload_session_id: s.id,
          uploaded_by: s.created_by,
          officer_id: md.resolvedOfficerId ?? null,
          device_id: md.resolvedDeviceId ?? null,
          title: str('title') ?? s.original_filename,
          description: str('description'),
          category: str('category'),
          incident_at: str('incidentAt'),
          recorded_at: str('recordedAt'),
          location_text: str('locationText'),
          gps_latitude: lat,
          gps_longitude: lon,
          gps_source: lat != null ? 'DECLARED' : null,
          original_filename: s.original_filename,
          mime_type: s.declared_mime,
          size_bytes: s.declared_size,
          storage_tier: 'STAGING',
          storage_bucket: s.staging_bucket,
          storage_key: s.staging_key,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await tx.updateTable('upload_sessions').set({ status: 'COMPLETED', evidence_id: ev.id, error: null }).where('id', '=', s.id).execute();
      const details = { uploadSessionId: s.id, batchId: s.batch_id, filename: s.original_filename, sizeBytes: Number(s.declared_size), declaredSha256: s.declared_sha256, parts: s.total_chunks };
      await appendAudit(tx, req.actor(), { action: 'UPLOAD_COMPLETED', resourceType: 'upload_session', resourceId: s.id, evidenceId: ev.id, orgUnitId: s.org_unit_id, details });
      await appendAudit(tx, req.actor(), {
        action: 'EVIDENCE_RECEIVED',
        resourceType: 'evidence',
        resourceId: ev.id,
        evidenceId: ev.id,
        orgUnitId: s.org_unit_id,
        details: { ...details, officerId: md.resolvedOfficerId ?? null, deviceId: md.resolvedDeviceId ?? null, notes: str('notes') },
      });
      return ev.id;
    });
    await enqueueFinalize(s.id);
    void evidenceId;
    return viewFor(p, s.id, false);
  });

  app.delete('/:id', {
    preHandler: app.authorize('evidence:upload'),
    schema: { tags: ['uploads'], summary: 'Abort an upload session', params: z.object({ id: uuid }) },
  }, async (req) => {
    const s = await ownSession(req, req.params.id);
    if (s.status === 'ABORTED') return { id: s.id, status: 'ABORTED' };
    if (s.status !== 'INITIATED' && s.status !== 'UPLOADING') throw conflict(`Upload is ${s.status} and cannot be cancelled`, { status: s.status });
    await app.db.transaction().execute(async (tx) => {
      const res = await tx.updateTable('upload_sessions').set({ status: 'ABORTED' }).where('id', '=', s.id).where('status', 'in', ['INITIATED', 'UPLOADING']).executeTakeFirst();
      if (!res.numUpdatedRows) throw conflict('Upload changed state; reload and retry');
      await appendAudit(tx, req.actor(), { action: 'UPLOAD_ABORTED', resourceType: 'upload_session', resourceId: s.id, orgUnitId: s.org_unit_id, details: { filename: s.original_filename, receivedBytes: Number(s.received_bytes) } });
    });
    if (s.s3_upload_id) await app.storage.abortMultipart(s.staging_bucket, s.staging_key, s.s3_upload_id);
    return { id: s.id, status: 'ABORTED' };
  });
}
