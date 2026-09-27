/**
 * Video processing & playback API (spec module 7).
 *
 *   GET  /media/evidence/:id/playback      tokenised HLS / MP4 / poster / sprite URLs + processing state
 *   GET  /media/stream/:evidenceId/*       (token) derived media with Range; playlists/VTT rewritten to carry the token
 *   GET  /media/image/:derivativeId        (token, scope image, ref = derivative id) thumbnails/posters/snapshots/sprites
 *   GET  /media/evidence/:id/original      short-lived download URL for the ORIGINAL
 *   GET  /media/download/:evidenceId       (token, scope download) streams the original (custody audited)
 *   POST /media/evidence/:id/snapshots     exact-frame PNG snapshot — extracted by the worker (media.snapshot); the API
 *                                          waits up to SNAPSHOT_WAIT_SECONDS (default 20) → 201, else 202 + requestId
 *   GET  /media/snapshot-requests/:id      status of a queued snapshot (requester only) → snapshot when COMPLETED
 *   GET  /media/evidence/:id/snapshots     list snapshots
 *   POST /media/evidence/:id/reprocess     re-run the media pipeline (force)
 *
 * Storage URLs are never returned; browsers use `?t=` media tokens (see ./tokens.ts).
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';
import { appendAudit, enqueue, loadConfig } from '@ksp/core';
import { QUEUES, type MediaHlsPayload, type MediaProcessPayload, type SnapshotExtractPayload } from '@ksp/shared';
import { loadEvidenceFor } from '../../lib/access.js';
import { recordInternalShareOpen } from '../../lib/share-views.js';
import { AppError, conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { hasPermission, hasPermissionAt } from '../../lib/principal.js';
import { authenticateMediaToken, DOWNLOAD_TOKEN_TTL_SECONDS, IMAGE_TOKEN_TTL_SECONDS, imageUrl, issueUserToken, streamUrl, tokenExpiry } from './tokens.js';
import { contentTypeFor, rewritePlaylist, rewriteVtt, sendObject } from './stream.js';
import { frameAt } from './snapshot.js';

/** How long POST /snapshots waits for the worker before answering 202 (FN-8). */
const SNAPSHOT_WAIT_MS = Math.max(0, Number(process.env.SNAPSHOT_WAIT_SECONDS ?? 20)) * 1000;

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
    await recordInternalShareOpen(app.db, p, ev, req.actor(), { ip: req.ip, userAgent: req.headers['user-agent'] ?? null, via: 'playback' });
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
    // Adaptive stream state (EXT-9 MEDIA_PROFILE). on-demand-hls: the first playback of a READY item queues the ladder;
    // the proxy MP4 plays immediately (HTTP Range) and the next playback after completion gets HLS.
    const profile = loadConfig().MEDIA_PROFILE;
    let hlsStatus: 'READY' | 'PREPARING' | 'FAILED' | 'NOT_BUILT' = hls ? 'READY' : 'NOT_BUILT';
    if (ready && !hls && profile === 'on-demand-hls') {
      const hj = await app.db.selectFrom('processing_jobs').select(['status', 'updated_at']).where('evidence_id', '=', ev.id).where('kind', '=', 'MEDIA_HLS')
        .orderBy('created_at', 'desc').limit(1).executeTakeFirst();
      const recentFailure = hj?.status === 'FAILED' && Date.now() - new Date(hj.updated_at).getTime() < 3600_000;
      // A request in the last 2 h that has not produced a job row yet is still queued (pg-boss singletonKey does not
      // dedupe on the standard queue policy, so the request audit is the de-duplication record).
      const pending = !hj || hj.status === 'COMPLETED' ? await app.db.selectFrom('audit_events').select('seq').where('evidence_id', '=', ev.id).where('action', '=', 'MEDIA_STREAM_REQUESTED')
        .where('occurred_at', '>', sql<Date>`now() - interval '2 hours'`).limit(1).executeTakeFirst() : undefined;
      if (hj && ['QUEUED', 'RUNNING'].includes(hj.status)) hlsStatus = 'PREPARING';
      else if (recentFailure) hlsStatus = 'FAILED'; // retried by a later playback after an hour
      else if (pending && !hj) hlsStatus = 'PREPARING';
      else {
        const queued = await enqueue<MediaHlsPayload>(QUEUES.MEDIA_HLS, { evidenceId: ev.id }, { singletonKey: `hls:${ev.id}` });
        if (queued) {
          await appendAudit(app.db, req.actor(), { action: 'MEDIA_STREAM_REQUESTED', resourceType: 'evidence', resourceId: ev.id, evidenceId: ev.id, orgUnitId: ev.org_unit_id, details: { profile, queueJobId: queued } });
        }
        hlsStatus = 'PREPARING';
      }
    }
    const progress = row.media_status === 'READY' ? 1 : job && job.status === 'RUNNING' ? job.progress : 0;
    return {
      mediaProfile: profile,
      hlsStatus,
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
    const auth = await authenticateMediaToken(app.db, req, req.query.t, { evidenceId, scope: 'stream' });
    const { claims } = auth;
    const relPath = req.params['*'];
    if (!REL_PATH.test(relPath) || relPath.split('/').some((s) => s === '..' || s === '.')) throw notFound('Media');
    const key = `evidence/${evidenceId}/${relPath}`;
    let d;
    if (claims.typ === 'SHARE') {
      // External share recipients: ONLY the watermarked variant generated for THIS share (or, when the sharer
      // disabled watermarking, the plain proxy MP4). Never HLS/posters/sprites/other shares' variants.
      if (auth.share?.watermark) {
        d = (await derivativesOf(evidenceId, ['WATERMARKED'])).find((x) => x.object_key === key && (x.meta as { shareId?: string }).shareId === claims.sub);
      } else {
        d = (await derivativesOf(evidenceId, ['PROXY_MP4'])).find((x) => x.object_key === key);
      }
    } else {
      const ds = await derivativesOf(evidenceId, STREAMABLE_KINDS);
      d = ds.find((x) => (x.kind === 'HLS' ? key.startsWith(x.object_key) && /(?:^|\/)(?:master|index)\.m3u8$|\/seg_\d{5}\.ts$/.test(key) : x.object_key === key));
    }
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
    // Derived images are not watermarked: never served to external share recipients.
    if (claims.typ === 'SHARE') throw new AppError(403, 'TOKEN_SCOPE', 'Media token not valid for this resource');
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
    // External shares: the ORIGINAL only when the share explicitly allows it (allow_download AND allow_original);
    // otherwise recipients get the watermarked copy via /share-portal/download.
    if (auth.claims.typ === 'SHARE' && (!auth.shareAllowsOriginal || auth.claims.ref !== 'original')) throw forbidden('This share does not allow downloading the original');
    // Evidence download tokens carry no ref; tokens minted for other download routes (e.g. ref 'report') are refused.
    if (auth.claims.typ !== 'SHARE' && auth.claims.ref !== undefined) throw new AppError(403, 'TOKEN_SCOPE', 'Media token not valid for this resource');
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
        details: { sha256: ev.sha256, sizeBytes: Number(ev.size_bytes), range: range ?? null, storageTier: ev.storage_tier, via: auth.claims.typ.toLowerCase() },
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
    let location: { bucket: string; key: string; versionId: string | null };
    let fps: number;
    let durationMs: number;
    if (source === 'proxy') {
      const proxy = await app.db.selectFrom('evidence_derivatives').selectAll().where('evidence_id', '=', ev.id).where('kind', '=', 'PROXY_MP4').executeTakeFirst();
      if (row.media_status !== 'READY' || !proxy) throw conflict('Media is not ready for snapshots');
      const m = proxy.meta as { fps?: number; durationMs?: number };
      fps = m.fps ?? Number(row.frame_rate ?? 25);
      durationMs = m.durationMs ?? Number(row.duration_ms ?? 0);
      location = { bucket: proxy.bucket, key: proxy.object_key, versionId: null };
    } else {
      if (!row.storage_bucket || !row.storage_key || !row.frame_rate) throw conflict('Original is not available for frame extraction');
      fps = Number(row.frame_rate);
      durationMs = Number(row.duration_ms ?? 0);
      location = { bucket: row.storage_bucket, key: row.storage_key, versionId: row.storage_version_id };
    }
    if (!(fps > 0)) throw unprocessable('Frame rate unknown');
    if (durationMs && timeMs > durationMs) throw unprocessable('timeMs is beyond the end of the media');
    const lastFrame = durationMs ? Math.max(0, Math.ceil((durationMs * fps) / 1000 - 1e-6) - 1) : Number.MAX_SAFE_INTEGER;
    const frame = Math.min(frameAt(timeMs, fps), lastFrame);
    if (!p.userId) throw forbidden('Snapshots require an interactive user');
    // FN-8: FFmpeg runs in the worker. Queue, then wait briefly so the UI keeps its synchronous flow.
    const reqRow = await app.db.insertInto('snapshot_requests')
      .values({ evidence_id: ev.id, requested_by: p.userId, actor: JSON.stringify(req.actor()), params: JSON.stringify({ timeMs, source, frame, fps, ...location }) })
      .returning('id').executeTakeFirstOrThrow();
    await enqueue<SnapshotExtractPayload>(QUEUES.SNAPSHOT_EXTRACT, { snapshotRequestId: reqRow.id });
    const deadline = Date.now() + SNAPSHOT_WAIT_MS;
    for (;;) {
      const s = await app.db.selectFrom('snapshot_requests').select(['status', 'derivative_id', 'error']).where('id', '=', reqRow.id).executeTakeFirstOrThrow();
      if (s.status === 'COMPLETED' && s.derivative_id) {
        const token = issueUserToken(p, ev.id, 'image', { ttlSeconds: IMAGE_TOKEN_TTL_SECONDS, ref: s.derivative_id });
        return reply.status(201).send(snapshotDto(await snapshotRow(s.derivative_id), token));
      }
      if (s.status === 'FAILED') throw unprocessable(s.error ?? 'Frame could not be extracted at this position');
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    return reply.status(202).send({ requestId: reqRow.id, status: 'QUEUED', statusUrl: `/api/v1/media/snapshot-requests/${reqRow.id}` });
  });

  const snapshotRow = (id: string) =>
    app.db.selectFrom('evidence_derivatives as d').leftJoin('users as u', 'u.id', 'd.created_by')
      .select(['d.id', 'd.meta', 'd.sha256', 'd.width', 'd.height', 'd.size_bytes', 'd.created_at', 'd.created_by', 'u.full_name as creator_name'])
      .where('d.id', '=', id).executeTakeFirstOrThrow();

  app.get('/snapshot-requests/:id', {
    schema: { tags: ['media'], summary: 'Status of a queued snapshot extraction (requester only)', params: idParams },
  }, async (req) => {
    const p = req.requirePrincipal();
    const r = await app.db.selectFrom('snapshot_requests').selectAll().where('id', '=', req.params.id).where('requested_by', '=', p.userId ?? '00000000-0000-0000-0000-000000000000').executeTakeFirst();
    if (!r) throw notFound('Snapshot request');
    // Still subject to the evidence rules (access may have been withdrawn since the request).
    await loadEvidenceFor(app.db, p, r.evidence_id, 'evidence:snapshot', req.actor());
    const snapshot = r.status === 'COMPLETED' && r.derivative_id
      ? snapshotDto(await snapshotRow(r.derivative_id), issueUserToken(p, r.evidence_id, 'image', { ttlSeconds: IMAGE_TOKEN_TTL_SECONDS, ref: r.derivative_id }))
      : null;
    return { requestId: r.id, evidenceId: r.evidence_id, status: r.status, error: r.status === 'FAILED' ? r.error : null, snapshot };
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
      // Operators monitoring processing queues may retry jobs without evidence media access — but only inside the
      // jurisdiction of their system:monitor grant (SEC-09: out-of-scope ids are indistinguishable from unknown ones).
      const row = await app.db.selectFrom('evidence').select(['id', 'org_unit_id', 'org_path', 'status']).where('id', '=', req.params.id).executeTakeFirst();
      if (!row || !hasPermissionAt(p, 'system:monitor', row.org_path)) throw notFound('Evidence');
      ev = row;
    } else {
      throw forbidden();
    }
    if (!PLAYABLE_STATUSES.includes(ev.status)) throw conflict('Only registered evidence can be processed');
    const hasDerivatives = !!(await app.db.selectFrom('evidence_derivatives').select('id').where('evidence_id', '=', ev.id).where('kind', '=', 'PROXY_MP4').executeTakeFirst());
    const jobId = await app.db.transaction().execute(async (tx) => {
      // FN-7: never stack a second pipeline on one that is queued or running (serialised per item).
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`reprocess:${ev.id}`}, 0))`.execute(tx);
      const busy = await tx.selectFrom('evidence as e')
        .select(['e.media_status', sql<boolean>`EXISTS (SELECT 1 FROM processing_jobs pj WHERE pj.evidence_id = e.id AND pj.kind = 'MEDIA_PROCESS' AND pj.status IN ('QUEUED','RUNNING'))`.as('job')])
        .where('e.id', '=', ev.id).executeTakeFirstOrThrow();
      if (busy.media_status === 'PROCESSING' || busy.job) throw conflict('Media processing is already queued or running for this item');
      // With existing derivatives the item stays READY (still playable) until the rebuilt set replaces it.
      if (!hasDerivatives) await tx.updateTable('evidence').set({ media_status: 'PENDING', media_error: null }).where('id', '=', ev.id).where('media_status', '<>', 'PROCESSING').execute();
      await appendAudit(tx, req.actor(), { action: 'MEDIA_REPROCESS_REQUESTED', resourceType: 'evidence', resourceId: ev.id, evidenceId: ev.id, orgUnitId: ev.org_unit_id, details: { reason: req.body?.reason ?? null, rebuild: hasDerivatives } });
      const id = await enqueue<MediaProcessPayload>(QUEUES.MEDIA_PROCESS, { evidenceId: ev.id, force: true });
      // Tracked from the moment it is queued (the worker's ProcessingTracker reuses this row by queue job id).
      if (id) await tx.insertInto('processing_jobs').values({ kind: 'MEDIA_PROCESS', evidence_id: ev.id, queue_job_id: id, status: 'QUEUED' }).execute();
      return id;
    });
    return reply.status(202).send({ queued: true, jobId });
  });
}
