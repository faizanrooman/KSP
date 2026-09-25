/**
 * Video processing & playback API (spec module 7).
 *
 *   GET  /media/evidence/:id/playback      tokenised HLS / MP4 / poster / sprite URLs + processing state
 *   GET  /media/stream/:evidenceId/*       (token) derived media with Range; playlists/VTT rewritten to carry the token
 *   GET  /media/image/:derivativeId        (token, scope image, ref = derivative id) thumbnails/posters/snapshots/sprites
 *   GET  /media/evidence/:id/original      short-lived download URL for the ORIGINAL
 *   GET  /media/download/:evidenceId       (token, scope download) streams the original (custody audited)
 *   POST /media/evidence/:id/snapshots     exact-frame PNG snapshot
 *   GET  /media/evidence/:id/snapshots     list snapshots
 *   POST /media/evidence/:id/reprocess     re-run the media pipeline (force)
 *
 * Storage URLs are never returned; browsers use `?t=` media tokens (see ./tokens.ts).
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { appendAudit, enqueue } from '@ksp/core';
import { QUEUES, type MediaProcessPayload } from '@ksp/shared';
import { loadEvidenceFor } from '../../lib/access.js';
import { AppError, conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { hasPermission } from '../../lib/principal.js';
import { authenticateMediaToken, DOWNLOAD_TOKEN_TTL_SECONDS, IMAGE_TOKEN_TTL_SECONDS, imageUrl, issueUserToken, streamUrl, tokenExpiry } from './tokens.js';
import { contentTypeFor, rewritePlaylist, rewriteVtt, sendObject } from './stream.js';
import { extractFrame, frameAt } from './snapshot.js';

export const prefix = '/media';

/** EVIDENCE_PLAYED is written at most once per user + evidence item per window. */
export const PLAY_AUDIT_WINDOW_MINUTES = 10;
const STREAMABLE_KINDS = ['HLS', 'PROXY_MP4', 'SPRITE', 'POSTER', 'THUMBNAIL'] as const;
const IMAGE_KINDS = ['THUMBNAIL', 'POSTER', 'SNAPSHOT', 'SPRITE', 'AI_FRAME', 'AI_CROP'];
const PLAYABLE_STATUSES = ['REGISTERED', 'DISPOSAL_PENDING'];
const REL_PATH = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/;

const idParams = z.object({ id: z.string().uuid() });
const tokenQuery = z.object({ t: z.string().min(10).max(4096).optional() });

function safeFilename(v: string): string {
  return v.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 180) || 'evidence';
}

export default async function media(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  const derivativesOf = (evidenceId: string, kinds: readonly string[]) =>
    app.db.selectFrom('evidence_derivatives').selectAll().where('evidence_id', '=', evidenceId).where('kind', 'in', kinds as string[]).orderBy('object_key').execute();

  // ---------------------------------------------------------------------------------------------
  app.get('/evidence/:id/playback', {
    schema: { tags: ['media'], summary: 'Playback descriptor with tokenised stream URLs', params: idParams },
  }, async (req) => {
    const p = req.requirePrincipal();
    const ev = await loadEvidenceFor(app.db, p, req.params.id, 'evidence:play', req.actor());
    const row = await app.db
      .selectFrom('evidence')
      .select(['id', 'media_status', 'media_error', 'duration_ms', 'frame_rate', 'width', 'height', 'status'])
      .where('id', '=', ev.id)
      .executeTakeFirstOrThrow();
    const job = await app.db
      .selectFrom('processing_jobs')
      .select(['status', 'progress', 'error', 'updated_at'])
      .where('evidence_id', '=', ev.id)
      .where('kind', '=', 'MEDIA_PROCESS')
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    const ds = await derivativesOf(ev.id, STREAMABLE_KINDS);
    const proxy = ds.find((d) => d.kind === 'PROXY_MP4');
    const hls = ds.find((d) => d.kind === 'HLS');
    const poster = ds.find((d) => d.kind === 'POSTER');
    const thumb = ds.find((d) => d.kind === 'THUMBNAIL');
    const vtt = ds.find((d) => d.kind === 'SPRITE' && d.mime_type === 'text/vtt');
    const pm = (proxy?.meta ?? {}) as { fps?: number; durationMs?: number; gop?: number; sourceVfr?: boolean };
    const ready = row.media_status === 'READY' && !!proxy && PLAYABLE_STATUSES.includes(row.status);
    const rel = (key: string) => key.slice(`evidence/${ev.id}/`.length);
    let urls: Record<string, string | null> = { hlsUrl: null, mp4Url: null, posterUrl: null, thumbnailUrl: null, spriteVttUrl: null };
    let expiresAt: string | null = null;
    if (ready) {
      const token = issueUserToken(p, ev.id, 'stream');
      expiresAt = tokenExpiry(token);
      urls = {
        hlsUrl: hls ? streamUrl(ev.id, `${rel(hls.object_key)}${(hls.meta as { master?: string }).master ?? 'master.m3u8'}`, token) : null,
        mp4Url: streamUrl(ev.id, rel(proxy.object_key), token),
        posterUrl: poster ? streamUrl(ev.id, rel(poster.object_key), token) : null,
        thumbnailUrl: thumb ? streamUrl(ev.id, rel(thumb.object_key), token) : null,
        spriteVttUrl: vtt ? streamUrl(ev.id, rel(vtt.object_key), token) : null,
      };
      // Custody: EVIDENCE_PLAYED, throttled to one event per user + evidence per window (token refreshes
      // every few minutes would otherwise flood the chain of custody).
      const recent = await app.db
        .selectFrom('audit_events')
        .select('seq')
        .where('evidence_id', '=', ev.id)
        .where('action', '=', 'EVIDENCE_PLAYED')
        .where('actor_id', '=', p.userId!)
        .where('occurred_at', '>', sql<Date>`now() - make_interval(mins => ${PLAY_AUDIT_WINDOW_MINUTES})`)
        .limit(1)
        .executeTakeFirst();
      if (!recent) {
        await appendAudit(app.db, req.actor(), { action: 'EVIDENCE_PLAYED', resourceType: 'evidence', resourceId: ev.id, evidenceId: ev.id, orgUnitId: ev.org_unit_id, details: { via: 'playback', throttleMinutes: PLAY_AUDIT_WINDOW_MINUTES } });
      }
    }
    const progress = row.media_status === 'READY' ? 1 : job && job.status === 'RUNNING' ? job.progress : 0;
    return {
      evidenceId: ev.id,
      mediaStatus: row.media_status,
      mediaError: row.media_status === 'READY' ? null : row.media_error,
      progress,
      durationMs: pm.durationMs ?? (row.duration_ms === null ? null : Number(row.duration_ms)),
      frameRate: pm.fps ?? (row.frame_rate === null ? null : Number(row.frame_rate)),
      sourceFrameRate: row.frame_rate === null ? null : Number(row.frame_rate),
      sourceVfr: pm.sourceVfr ?? null,
      width: proxy?.width ?? row.width,
      height: proxy?.height ?? row.height,
      sourceWidth: row.width,
      sourceHeight: row.height,
      renditions: ((hls?.meta as { renditions?: Array<{ name: string; width: number; height: number }> } | undefined)?.renditions ?? []).map((r) => ({ name: r.name, width: r.width, height: r.height })),
      ...urls,
      expiresAt,
    };
  });

  // ---------------------------------------------------------------------------------------------
  app.get('/stream/:evidenceId/*', {
    config: { public: true },
    schema: { tags: ['media'], summary: 'Stream a derived media object (media token)', params: z.object({ evidenceId: z.string().uuid(), '*': z.string().max(300) }), querystring: tokenQuery },
  }, async (req, reply) => {
    const { evidenceId } = req.params;
    const { claims } = await authenticateMediaToken(app.db, req, req.query.t, { evidenceId, scope: 'stream' });
    const relPath = req.params['*'];
    if (!REL_PATH.test(relPath) || relPath.split('/').some((s) => s === '..' || s === '.')) throw notFound('Media');
    const key = `evidence/${evidenceId}/${relPath}`;
    const ds = await derivativesOf(evidenceId, STREAMABLE_KINDS);
    const d = ds.find((x) => (x.kind === 'HLS' ? key.startsWith(x.object_key) && /(?:^|\/)(?:master|index)\.m3u8$|\/seg_\d{5}\.ts$/.test(key) : x.object_key === key));
    if (!d) throw notFound('Media');
    const ev = await app.db.selectFrom('evidence').select(['status']).where('id', '=', evidenceId).executeTakeFirst();
    if (!ev || !PLAYABLE_STATUSES.includes(ev.status)) throw notFound('Media');
    const ctype = contentTypeFor(key, d.mime_type ?? undefined);
    if (key.endsWith('.m3u8') || key.endsWith('.vtt')) {
      const text = (await app.storage.getBuffer(d.bucket, key)).toString('utf8');
      const token = req.query.t!;
      const body = key.endsWith('.m3u8') ? rewritePlaylist(text, token) : rewriteVtt(text, token);
      void claims;
      return reply.header('Content-Type', ctype).header('Cache-Control', 'private, no-store').send(body);
    }
    return sendObject(app.storage, req, reply, { bucket: d.bucket, key, contentType: ctype });
  });

  // ---------------------------------------------------------------------------------------------
  app.get('/image/:derivativeId', {
    config: { public: true },
    schema: { tags: ['media'], summary: 'Derived image (thumbnail, poster, snapshot, sprite) by media token', params: z.object({ derivativeId: z.string().uuid() }), querystring: tokenQuery.extend({ download: z.enum(['0', '1']).optional() }) },
  }, async (req, reply) => {
    const { derivativeId } = req.params;
    const { claims } = await authenticateMediaToken(app.db, req, req.query.t, { scope: 'image', ref: derivativeId });
    const d = await app.db
      .selectFrom('evidence_derivatives as d')
      .innerJoin('evidence as e', 'e.id', 'd.evidence_id')
      .select(['d.id', 'd.evidence_id', 'd.kind', 'd.bucket', 'd.object_key', 'd.mime_type', 'd.meta', 'e.evidence_number', 'e.status'])
      .where('d.id', '=', derivativeId)
      .executeTakeFirst();
    if (!d || d.evidence_id !== claims.eid) throw new AppError(403, 'TOKEN_SCOPE', 'Media token not valid for this resource');
    if (!IMAGE_KINDS.includes(d.kind) || !(d.mime_type ?? '').startsWith('image/') || !PLAYABLE_STATUSES.includes(d.status)) throw notFound('Image');
    const extra: Record<string, string> = {};
    if (req.query.download === '1') {
      const frame = (d.meta as { frameNumber?: number }).frameNumber;
      const name = safeFilename(`${d.evidence_number ?? d.evidence_id}_${d.kind.toLowerCase()}${frame !== undefined ? `_f${frame}` : ''}_${d.id.slice(0, 8)}.${d.object_key.split('.').pop()}`);
      extra['Content-Disposition'] = `attachment; filename="${name}"`;
    }
    return sendObject(app.storage, req, reply, { bucket: d.bucket, key: d.object_key, contentType: d.mime_type ?? contentTypeFor(d.object_key) }, extra);
  });

  // ---------------------------------------------------------------------------------------------
  app.get('/evidence/:id/original', {
    schema: { tags: ['media'], summary: 'Short-lived download URL for the original evidence file', params: idParams },
  }, async (req) => {
    const p = req.requirePrincipal();
    const ev = await loadEvidenceFor(app.db, p, req.params.id, 'evidence:download_original', req.actor());
    const row = await app.db.selectFrom('evidence').select(['status', 'storage_key', 'sha256', 'size_bytes', 'original_filename', 'evidence_number']).where('id', '=', ev.id).executeTakeFirstOrThrow();
    if (!PLAYABLE_STATUSES.includes(row.status) || !row.storage_key) throw conflict('The original is not available for download');
    const token = issueUserToken(p, ev.id, 'download', { ttlSeconds: DOWNLOAD_TOKEN_TTL_SECONDS });
    return {
      url: `/api/v1/media/download/${ev.id}?t=${encodeURIComponent(token)}`,
      expiresAt: tokenExpiry(token),
      filename: safeFilename(`${row.evidence_number ?? ev.id}_${row.original_filename}`),
      sha256: row.sha256,
      sizeBytes: Number(row.size_bytes),
    };
  });

  app.get('/download/:evidenceId', {
    config: { public: true },
    schema: { tags: ['media'], summary: 'Stream the original evidence file (media token, custody audited)', params: z.object({ evidenceId: z.string().uuid() }), querystring: tokenQuery },
  }, async (req, reply) => {
    const { evidenceId } = req.params;
    const auth = await authenticateMediaToken(app.db, req, req.query.t, { evidenceId, scope: 'download' });
    if (auth.claims.typ === 'SHARE' && !auth.shareAllowsDownload) throw forbidden('This share does not allow downloads');
    const ev = await app.db
      .selectFrom('evidence')
      .select(['id', 'status', 'org_unit_id', 'evidence_number', 'original_filename', 'storage_bucket', 'storage_key', 'storage_version_id', 'sha256', 'size_bytes', 'storage_tier'])
      .where('id', '=', evidenceId)
      .executeTakeFirst();
    if (!ev || !PLAYABLE_STATUSES.includes(ev.status) || !ev.storage_bucket || !ev.storage_key) throw notFound('Evidence');
    const range = req.headers.range;
    // One custody event per download, not per range request: resumed/segmented downloads (Range not starting
    // at byte 0) are part of the same download.
    const startsAtZero = !range || /^bytes=0-/.test(range.trim());
    if (startsAtZero) {
      await appendAudit(app.db, auth.actor, {
        action: 'EVIDENCE_DOWNLOADED', resourceType: 'evidence', resourceId: ev.id, evidenceId: ev.id, orgUnitId: ev.org_unit_id,
        details: { sha256: ev.sha256, sizeBytes: Number(ev.size_bytes), range: range ?? null, storageTier: ev.storage_tier, via: auth.claims.typ === 'SHARE' ? 'share' : 'user' },
      });
    }
    const filename = safeFilename(`${ev.evidence_number ?? ev.id}_${ev.original_filename}`);
    return sendObject(app.storage, req, reply, { bucket: ev.storage_bucket, key: ev.storage_key, versionId: ev.storage_version_id, contentType: 'application/octet-stream' }, {
      'Content-Disposition': `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'X-Evidence-SHA256': ev.sha256 ?? '',
      'X-Evidence-Number': ev.evidence_number ?? '',
    });
  });

  // ---------------------------------------------------------------------------------------------
  const snapshotDto = (d: { id: string; meta: unknown; sha256: string | null; width: number | null; height: number | null; size_bytes: string | number | bigint | null; created_at: Date; created_by: string | null; creator_name?: string | null }, token: string) => {
    const m = (d.meta ?? {}) as { timeMs?: number; frameNumber?: number; frameTimeMs?: number; fps?: number; source?: string };
    return {
      id: d.id,
      timeMs: m.timeMs ?? null,
      frameNumber: m.frameNumber ?? null,
      frameTimeMs: m.frameTimeMs ?? null,
      fps: m.fps ?? null,
      source: m.source ?? null,
      sha256: d.sha256,
      width: d.width,
      height: d.height,
      sizeBytes: d.size_bytes === null ? null : Number(d.size_bytes),
      createdAt: d.created_at.toISOString(),
      createdBy: d.created_by ? { id: d.created_by, name: d.creator_name ?? null } : null,
      url: imageUrl(d.id, token),
      downloadUrl: `${imageUrl(d.id, token)}&download=1`,
    };
  };

  app.post('/evidence/:id/snapshots', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: {
      tags: ['media'], summary: 'Create an exact-frame PNG snapshot', params: idParams,
      body: z.object({ timeMs: z.number().min(0).max(1e10), source: z.enum(['proxy', 'original']).default('proxy') }),
    },
  }, async (req, reply) => {
    const p = req.requirePrincipal();
    const ev = await loadEvidenceFor(app.db, p, req.params.id, 'evidence:snapshot', req.actor());
    const row = await app.db
      .selectFrom('evidence')
      .select(['status', 'media_status', 'duration_ms', 'frame_rate', 'storage_bucket', 'storage_key', 'storage_version_id'])
      .where('id', '=', ev.id)
      .executeTakeFirstOrThrow();
    if (!PLAYABLE_STATUSES.includes(row.status)) throw conflict('Evidence is not available');
    const { timeMs, source } = req.body;
    let input: string;
    let fps: number;
    let durationMs: number;
    if (source === 'proxy') {
      const proxy = await app.db.selectFrom('evidence_derivatives').selectAll().where('evidence_id', '=', ev.id).where('kind', '=', 'PROXY_MP4').executeTakeFirst();
      if (row.media_status !== 'READY' || !proxy) throw conflict('Media is not ready for snapshots');
      const m = proxy.meta as { fps?: number; durationMs?: number };
      fps = m.fps ?? Number(row.frame_rate ?? 25);
      durationMs = m.durationMs ?? Number(row.duration_ms ?? 0);
      input = await app.storage.internalUrl(proxy.bucket, proxy.object_key, 600);
    } else {
      if (!row.storage_bucket || !row.storage_key || !row.frame_rate) throw conflict('Original is not available for frame extraction');
      fps = Number(row.frame_rate);
      durationMs = Number(row.duration_ms ?? 0);
      input = await app.storage.internalUrl(row.storage_bucket, row.storage_key, 600, row.storage_version_id ?? undefined);
    }
    if (!(fps > 0)) throw unprocessable('Frame rate unknown');
    if (durationMs && timeMs > durationMs) throw unprocessable('timeMs is beyond the end of the media');
    const lastFrame = durationMs ? Math.max(0, Math.ceil((durationMs * fps) / 1000 - 1e-6) - 1) : Number.MAX_SAFE_INTEGER;
    const frame = Math.min(frameAt(timeMs, fps), lastFrame);
    let snap;
    try {
      snap = await extractFrame({ input, frame, fps, workDir: app.cfg.WORK_DIR });
    } catch (err) {
      req.log.warn({ err }, 'snapshot extraction failed');
      throw unprocessable('Frame could not be extracted at this position');
    }
    const sha256 = createHash('sha256').update(snap.png).digest('hex');
    const id = randomUUID();
    const bucket = app.storage.bucket('derived');
    const key = `evidence/${ev.id}/snapshot/${id}.png`;
    await app.storage.put(bucket, key, snap.png, { contentType: 'image/png', metadata: { sha256 } });
    const meta = { timeMs, frameNumber: frame, frameTimeMs: Math.round((frame / fps) * 1000 * 1000) / 1000, fps, source, sha256 };
    const saved = await app.db.transaction().execute(async (tx) => {
      const d = await tx
        .insertInto('evidence_derivatives')
        .values({ id, evidence_id: ev.id, kind: 'SNAPSHOT', bucket, object_key: key, mime_type: 'image/png', size_bytes: snap.png.length, sha256, width: snap.width, height: snap.height, meta: JSON.stringify(meta), created_by: p.userId })
        .returningAll()
        .executeTakeFirstOrThrow();
      await appendAudit(tx, req.actor(), { action: 'EVIDENCE_SNAPSHOT_CREATED', resourceType: 'evidence_derivative', resourceId: id, evidenceId: ev.id, orgUnitId: ev.org_unit_id, details: meta });
      return d;
    }).catch(async (err) => {
      await app.storage.delete(bucket, key).catch(() => undefined);
      throw err;
    });
    const token = issueUserToken(p, ev.id, 'image', { ttlSeconds: IMAGE_TOKEN_TTL_SECONDS, ref: id });
    return reply.status(201).send(snapshotDto({ ...saved, creator_name: p.username ?? null }, token));
  });

  app.get('/evidence/:id/snapshots', {
    schema: { tags: ['media'], summary: 'List snapshots of an evidence item', params: idParams },
  }, async (req) => {
    const p = req.requirePrincipal();
    const ev = await loadEvidenceFor(app.db, p, req.params.id, 'evidence:play', req.actor());
    const rows = await app.db
      .selectFrom('evidence_derivatives as d')
      .leftJoin('users as u', 'u.id', 'd.created_by')
      .select(['d.id', 'd.meta', 'd.sha256', 'd.width', 'd.height', 'd.size_bytes', 'd.created_at', 'd.created_by', 'u.full_name as creator_name'])
      .where('d.evidence_id', '=', ev.id)
      .where('d.kind', '=', 'SNAPSHOT')
      .orderBy('d.created_at', 'desc')
      .limit(500)
      .execute();
    return { items: rows.map((r) => snapshotDto(r, issueUserToken(p, ev.id, 'image', { ttlSeconds: IMAGE_TOKEN_TTL_SECONDS, ref: r.id }))), total: rows.length };
  });

  // ---------------------------------------------------------------------------------------------
  app.post('/evidence/:id/reprocess', {
    schema: { tags: ['media'], summary: 'Re-run media processing (rebuilds all playback derivatives)', params: idParams, body: z.object({ reason: z.string().trim().max(500).optional() }).default({}) },
  }, async (req, reply) => {
    const p = req.requirePrincipal();
    let ev: { id: string; org_unit_id: string; status: string };
    if (hasPermission(p, 'evidence:edit_metadata')) {
      ev = await loadEvidenceFor(app.db, p, req.params.id, 'evidence:edit_metadata', req.actor());
    } else if (hasPermission(p, 'system:monitor')) {
      // Operators monitoring processing queues may retry jobs system-wide without evidence media access.
      const row = await app.db.selectFrom('evidence').select(['id', 'org_unit_id', 'status']).where('id', '=', req.params.id).executeTakeFirst();
      if (!row) throw notFound('Evidence');
      ev = row;
    } else {
      throw forbidden();
    }
    if (!PLAYABLE_STATUSES.includes(ev.status)) throw conflict('Only registered evidence can be processed');
    await app.db.transaction().execute(async (tx) => {
      await tx.updateTable('evidence').set({ media_status: 'PENDING', media_error: null }).where('id', '=', ev.id).where('media_status', '<>', 'PROCESSING').execute();
      await appendAudit(tx, req.actor(), { action: 'MEDIA_REPROCESS_REQUESTED', resourceType: 'evidence', resourceId: ev.id, evidenceId: ev.id, orgUnitId: ev.org_unit_id, details: { reason: req.body?.reason ?? null } });
    });
    const jobId = await enqueue<MediaProcessPayload>(QUEUES.MEDIA_PROCESS, { evidenceId: ev.id, force: true });
    return reply.status(202).send({ queued: true, jobId });
  });
}
