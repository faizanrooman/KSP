/**
 * Public portal for EXTERNAL share recipients (no user account). All routes are `config.public`.
 *
 *   POST /share-portal/open                           {token, code} -> share session (X-Share-Session) + items
 *   GET  /share-portal/session                        re-read the share for a valid session
 *   GET  /share-portal/items/:evidenceId/playback     watermarked playback URL (SHARE media token) or 202 PREPARING
 *   GET  /share-portal/items/:evidenceId/download-link?variant=watermarked|original   (allowDownload / allowOriginal)
 *   GET  /share-portal/download/:evidenceId?t=        (SHARE token, scope download) streams the watermarked copy or original
 *   GET  /share-portal/items/:evidenceId/print?timeMs= watermarked frame PNG for printing (allowPrint)
 *
 * Every access is written to share_access_log and to the audit ledger (actor EXTERNAL_RECIPIENT, id = share id).
 * Failed access codes count towards a lockout (MAX_CODE_ATTEMPTS -> LOCKED). Storage URLs are never returned.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'kysely';
import { appendAudit, enqueue, sha256Hex, signMediaToken, verifySecret, dummySecretHash, type AuditActor } from '@ksp/core';
import { QUEUES, type AuditAction, type ShareWatermarkPayload } from '@ksp/shared';
import { AppError, notFound, unauthenticated } from '../../lib/errors.js';
import { authenticateMediaToken, tokenExpiry } from '../media/tokens.js';
import { sendObject } from '../media/stream.js';
import { extractFrame, frameAt } from '../media/snapshot.js';
import { SHARE_SESSION_HEADER, signShareSession, verifyShareSession } from './session.js';

export const prefix = '/share-portal';

export const MAX_CODE_ATTEMPTS = 5;
export const SHARE_MEDIA_TTL_SECONDS = 600;
export const SHARE_ACCESS_AUDIT_WINDOW_MINUTES = 10;
const STORED = ['REGISTERED', 'DISPOSAL_PENDING'];
const GENERIC = 'Invalid link or access code';

type ShareRec = {
  id: string; status: string; expires_at: Date; max_views: number | null; view_count: number; failed_code_attempts: number; access_code_hash: string | null;
  recipient_name: string | null; recipient_email: string | null; recipient_org: string | null; purpose: string; allow_download: boolean; allow_original: boolean;
  allow_print: boolean; watermark: boolean; case_id: string | null; created_by: string; creator_name: string; creator_rank: string | null; org_name: string; recipient_type: string;
};

function safeName(v: string): string {
  return v.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 160) || 'evidence';
}

export const watermarkKey = (evidenceId: string, shareId: string) => `evidence/${evidenceId}/shares/${shareId}/watermarked.mp4`;

export default async function sharePortal(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const test = app.cfg.NODE_ENV === 'test';

  const actorFor = (req: FastifyRequest, share: { id: string; recipient_name: string | null } | null): AuditActor => ({
    type: 'EXTERNAL_RECIPIENT', id: share?.id ?? null, name: share?.recipient_name ?? null, ip: req.ip, userAgent: req.headers['user-agent'] ?? null,
  });

  const loadShare = (where: { id?: string; tokenHash?: string }) => {
    let q = app.db
      .selectFrom('shares as s')
      .innerJoin('users as u', 'u.id', 's.created_by')
      .innerJoin('org_units as o', 'o.id', 's.org_unit_id')
      .select(['s.id', 's.status', 's.expires_at', 's.max_views', 's.view_count', 's.failed_code_attempts', 's.access_code_hash', 's.recipient_name', 's.recipient_email', 's.recipient_org',
        's.purpose', 's.allow_download', 's.allow_original', 's.allow_print', 's.watermark', 's.case_id', 's.created_by', 'u.full_name as creator_name', 'u.rank as creator_rank', 'o.name as org_name', 's.recipient_type'])
      .where('s.recipient_type', '=', 'EXTERNAL');
    if (where.id) q = q.where('s.id', '=', where.id);
    if (where.tokenHash) q = q.where('s.token_hash', '=', where.tokenHash);
    return q.executeTakeFirst() as Promise<ShareRec | undefined>;
  };

  const items = (shareId: string) =>
    app.db
      .selectFrom('share_items as si')
      .innerJoin('evidence as e', 'e.id', 'si.evidence_id')
      .select(['e.id', 'e.evidence_number', 'e.title', 'e.duration_ms', 'e.recorded_at', 'e.org_unit_id', 'e.status', 'e.media_status', 'e.frame_rate'])
      .where('si.share_id', '=', shareId)
      .orderBy('e.evidence_number')
      .execute();

  async function log(req: FastifyRequest, shareId: string, action: 'OPEN' | 'VIEW' | 'STREAM' | 'DOWNLOAD' | 'PRINT' | 'DENIED' | 'CODE_FAILED', evidenceId: string | null, detail: string | null) {
    const ip = /^[0-9a-fA-F:.]+$/.test(req.ip) ? req.ip : null;
    await app.db.insertInto('share_access_log').values({ share_id: shareId, evidence_id: evidenceId, action, ip, user_agent: (req.headers['user-agent'] ?? '').slice(0, 512) || null, detail }).execute();
  }

  async function auditItems(req: FastifyRequest, share: ShareRec, action: AuditAction, evs: Array<{ id: string; org_unit_id: string }>, details: Record<string, unknown>, outcome?: 'SUCCESS' | 'DENIED' | 'FAILURE') {
    for (const e of evs) {
      await appendAudit(app.db, actorFor(req, share), { action, outcome, resourceType: 'share', resourceId: share.id, evidenceId: e.id, caseId: share.case_id, orgUnitId: e.org_unit_id, details });
    }
  }

  /** Deny + record. Throws. */
  async function deny(req: FastifyRequest, share: ShareRec, evs: Array<{ id: string; org_unit_id: string }>, reason: string, err: AppError): Promise<never> {
    await log(req, share.id, 'DENIED', evs.length === 1 ? evs[0]!.id : null, reason);
    await auditItems(req, share, 'SHARE_ACCESS_DENIED', evs, { reason }, 'DENIED');
    throw err;
  }

  function stateError(share: ShareRec): AppError | null {
    if (share.status === 'REVOKED') return new AppError(410, 'SHARE_REVOKED', 'This share has been revoked');
    if (share.status === 'LOCKED') return new AppError(423, 'SHARE_LOCKED', 'This share is locked after too many wrong access codes; contact the sender');
    if (share.status === 'EXPIRED' || share.expires_at <= new Date()) return new AppError(410, 'SHARE_EXPIRED', 'This share has expired');
    return null;
  }

  /** Validate the X-Share-Session header; the share must still be ACTIVE and unexpired. */
  async function session(req: FastifyRequest): Promise<ShareRec> {
    const s = verifyShareSession(req.headers[SHARE_SESSION_HEADER] as string | undefined);
    if (!s) throw unauthenticated('Share session missing or expired; open the link again');
    const share = await loadShare({ id: s.shareId });
    if (!share) throw unauthenticated('Share session missing or expired; open the link again');
    const e = stateError(share);
    if (e) await deny(req, share, [], `session used while ${e.code}`, e);
    return share;
  }

  async function sessionItem(req: FastifyRequest, evidenceId: string) {
    const share = await session(req);
    const it = (await items(share.id)).find((i) => i.id === evidenceId);
    if (!it) {
      await log(req, share.id, 'DENIED', null, 'evidence not in share');
      await appendAudit(app.db, actorFor(req, share), { action: 'SHARE_ACCESS_DENIED', outcome: 'DENIED', resourceType: 'share', resourceId: share.id, details: { reason: 'evidence not in share', requestedEvidenceId: evidenceId } });
      throw notFound('Item');
    }
    if (!STORED.includes(it.status)) throw notFound('Item');
    return { share, it };
  }

  function shareView(share: ShareRec) {
    return {
      id: share.id,
      recipient: { name: share.recipient_name, email: share.recipient_email, organisation: share.recipient_org },
      purpose: share.purpose,
      sharedBy: { name: share.creator_name, rank: share.creator_rank, unit: share.org_name },
      permissions: { allowDownload: share.allow_download, allowOriginal: share.allow_download && share.allow_original, allowPrint: share.allow_print, watermark: share.watermark },
      expiresAt: share.expires_at.toISOString(),
      maxViews: share.max_views,
      viewCount: share.view_count,
    };
  }

  async function itemsView(shareId: string) {
    return (await items(shareId)).filter((i) => STORED.includes(i.status)).map((i) => ({
      evidenceId: i.id, evidenceNumber: i.evidence_number, title: i.title, durationMs: i.duration_ms === null ? null : Number(i.duration_ms), recordedAt: i.recorded_at?.toISOString() ?? null,
    }));
  }

  /** The playable variant for this share: the per-share watermarked MP4, or the plain proxy if watermarking is off. */
  async function variant(share: ShareRec, evidenceId: string) {
    if (share.watermark) {
      return app.db.selectFrom('evidence_derivatives').selectAll().where('evidence_id', '=', evidenceId).where('kind', '=', 'WATERMARKED').where('object_key', '=', watermarkKey(evidenceId, share.id)).executeTakeFirst();
    }
    return app.db.selectFrom('evidence_derivatives').selectAll().where('evidence_id', '=', evidenceId).where('kind', '=', 'PROXY_MP4').executeTakeFirst();
  }

  async function ensureWatermark(share: ShareRec, evidenceId: string) {
    await enqueue<ShareWatermarkPayload>(QUEUES.SHARE_WATERMARK, { shareId: share.id, evidenceId }, { singletonKey: `${share.id}:${evidenceId}` });
  }

  const wmClaim = (share: ShareRec) => `${share.recipient_name ?? ''} <${share.recipient_email ?? ''}> | share ${share.id} | ${new Date().toISOString()}`.slice(0, 300);

  // ---------------------------------------------------------------------------------------------
  app.post('/open', {
    config: { public: true, rateLimit: { max: test ? 10_000 : 10, timeWindow: '1 minute' } },
    schema: { tags: ['share-portal'], summary: 'Open an external share with its link token and access code', body: z.object({ token: z.string().min(20).max(200), code: z.string().trim().min(4).max(20) }) },
  }, async (req) => {
    const share = await loadShare({ tokenHash: sha256Hex(req.body.token) });
    if (!share) {
      await verifySecret(await dummySecretHash(), req.body.code); // equalise timing
      await appendAudit(app.db, actorFor(req, null), { action: 'SHARE_ACCESS_DENIED', outcome: 'DENIED', resourceType: 'share', details: { reason: 'unknown link' } });
      throw unauthenticated(GENERIC);
    }
    const evs = await items(share.id);
    if (share.status === 'ACTIVE' && share.expires_at <= new Date()) {
      await app.db.updateTable('shares').set({ status: 'EXPIRED' }).where('id', '=', share.id).where('status', '=', 'ACTIVE').execute();
    }
    const st = stateError(share);
    if (st) await deny(req, share, evs, `open while ${st.code}`, st);
    if (share.max_views !== null && share.view_count >= share.max_views) {
      await deny(req, share, evs, 'view limit reached', new AppError(403, 'SHARE_VIEW_LIMIT', 'This share has reached its maximum number of views'));
    }
    const ok = !!share.access_code_hash && (await verifySecret(share.access_code_hash, req.body.code));
    if (!ok) {
      const upd = await app.db
        .updateTable('shares')
        .set((eb) => ({ failed_code_attempts: eb('failed_code_attempts', '+', 1) }))
        .where('id', '=', share.id)
        .returning(['failed_code_attempts'])
        .executeTakeFirstOrThrow();
      const attempts = upd.failed_code_attempts;
      await log(req, share.id, 'CODE_FAILED', null, `attempt ${attempts}`);
      await auditItems(req, share, 'SHARE_ACCESS_DENIED', evs, { reason: 'wrong access code', attempt: attempts }, 'DENIED');
      if (attempts >= MAX_CODE_ATTEMPTS) {
        await app.db.transaction().execute(async (tx) => {
          await tx.updateTable('shares').set({ status: 'LOCKED', locked_at: new Date() }).where('id', '=', share.id).where('status', '=', 'ACTIVE').execute();
          for (const e of evs) await appendAudit(tx, actorFor(req, share), { action: 'SHARE_LOCKED', outcome: 'DENIED', resourceType: 'share', resourceId: share.id, evidenceId: e.id, caseId: share.case_id, orgUnitId: e.org_unit_id, details: { attempts } });
        });
        throw new AppError(423, 'SHARE_LOCKED', 'Too many wrong access codes: this share is now locked; contact the sender');
      }
      throw new AppError(401, 'UNAUTHENTICATED', GENERIC, { attemptsRemaining: MAX_CODE_ATTEMPTS - attempts });
    }
    await app.db.transaction().execute(async (tx) => {
      await tx.updateTable('shares').set((eb) => ({ view_count: eb('view_count', '+', 1), failed_code_attempts: 0, last_accessed_at: new Date() })).where('id', '=', share.id).execute();
      for (const e of evs) await appendAudit(tx, actorFor(req, share), { action: 'SHARE_ACCESSED', resourceType: 'share', resourceId: share.id, evidenceId: e.id, caseId: share.case_id, orgUnitId: e.org_unit_id, details: { via: 'open', view: share.view_count + 1 } });
    });
    await log(req, share.id, 'OPEN', null, null);
    // Kick off watermark generation for every item so playback is ready by the time the recipient clicks.
    if (share.watermark) {
      for (const e of evs) if (STORED.includes(e.status) && e.media_status === 'READY' && !(await variant(share, e.id))) await ensureWatermark(share, e.id);
    }
    const sess = signShareSession(share.id);
    return { sessionToken: sess.token, sessionExpiresAt: sess.expiresAt, share: { ...shareView(share), viewCount: share.view_count + 1 }, items: await itemsView(share.id) };
  });

  app.get('/session', {
    config: { public: true },
    schema: { tags: ['share-portal'], summary: 'Share details for a valid share session' },
  }, async (req) => {
    const share = await session(req);
    return { share: shareView(share), items: await itemsView(share.id) };
  });

  // ---------------------------------------------------------------------------------------------
  app.get('/items/:evidenceId/playback', {
    config: { public: true },
    schema: { tags: ['share-portal'], summary: 'Watermarked playback URL for a shared item', params: z.object({ evidenceId: z.string().uuid() }) },
  }, async (req, reply) => {
    const { share, it } = await sessionItem(req, req.params.evidenceId);
    if (it.media_status !== 'READY') return reply.status(202).send({ status: 'PROCESSING', message: 'The video is still being processed' });
    const d = await variant(share, it.id);
    if (!d) {
      if (share.watermark) await ensureWatermark(share, it.id);
      return reply.status(202).send({ status: 'PREPARING', message: 'A watermarked copy is being prepared for you; this can take a few minutes' });
    }
    const token = signMediaToken({ typ: 'SHARE', sub: share.id, eid: it.id, scope: 'stream', wm: wmClaim(share), ttlSeconds: SHARE_MEDIA_TTL_SECONDS });
    const recent = await app.db
      .selectFrom('share_access_log')
      .select('id')
      .where('share_id', '=', share.id)
      .where('evidence_id', '=', it.id)
      .where('action', '=', 'STREAM')
      .where('created_at', '>', sql<Date>`now() - make_interval(mins => ${SHARE_ACCESS_AUDIT_WINDOW_MINUTES})`)
      .limit(1)
      .executeTakeFirst();
    if (!recent) {
      await log(req, share.id, 'STREAM', it.id, share.watermark ? 'watermarked' : 'proxy');
      await auditItems(req, share, 'SHARE_ACCESSED', [it], { via: 'playback', watermarked: share.watermark, throttleMinutes: SHARE_ACCESS_AUDIT_WINDOW_MINUTES });
    }
    const rel = d.object_key.slice(`evidence/${it.id}/`.length);
    return {
      status: 'READY',
      evidenceId: it.id,
      mp4Url: `/api/v1/media/stream/${it.id}/${rel}?t=${encodeURIComponent(token)}`,
      expiresAt: tokenExpiry(token),
      watermarked: share.watermark,
      durationMs: (d.meta as { durationMs?: number }).durationMs ?? (it.duration_ms === null ? null : Number(it.duration_ms)),
      width: d.width,
      height: d.height,
    };
  });

  app.get('/items/:evidenceId/download-link', {
    config: { public: true },
    schema: { tags: ['share-portal'], summary: 'Short-lived download URL (watermarked copy by default; original only if allowed)', params: z.object({ evidenceId: z.string().uuid() }), querystring: z.object({ variant: z.enum(['watermarked', 'original']).default('watermarked') }) },
  }, async (req, reply) => {
    const { share, it } = await sessionItem(req, req.params.evidenceId);
    const v = req.query.variant;
    if (!share.allow_download) await deny(req, share, [it], 'download not allowed', new AppError(403, 'SHARE_DOWNLOAD_NOT_ALLOWED', 'This share does not allow downloads'));
    if (v === 'original' && !share.allow_original) await deny(req, share, [it], 'original download not allowed', new AppError(403, 'SHARE_DOWNLOAD_NOT_ALLOWED', 'This share does not allow downloading the original'));
    if (v === 'watermarked' && !(await variant(share, it.id))) {
      if (share.watermark && it.media_status === 'READY') await ensureWatermark(share, it.id);
      return reply.status(202).send({ status: 'PREPARING', message: 'The watermarked copy is being prepared' });
    }
    const token = signMediaToken({ typ: 'SHARE', sub: share.id, eid: it.id, scope: 'download', ref: v, wm: wmClaim(share), ttlSeconds: 60 });
    return { status: 'READY', url: `/api/v1/share-portal/download/${it.id}?t=${encodeURIComponent(token)}`, expiresAt: tokenExpiry(token), variant: v };
  });

  app.get('/download/:evidenceId', {
    config: { public: true },
    schema: { tags: ['share-portal'], summary: 'Stream a shared item download (SHARE media token)', params: z.object({ evidenceId: z.string().uuid() }), querystring: z.object({ t: z.string().min(10).max(4096).optional() }) },
  }, async (req, reply) => {
    const auth = await authenticateMediaToken(app.db, req, req.query.t, { evidenceId: req.params.evidenceId, scope: 'download' });
    if (auth.claims.typ !== 'SHARE' || !auth.share) throw new AppError(403, 'TOKEN_SCOPE', 'Media token not valid for this resource');
    const share = (await loadShare({ id: auth.share.id }))!;
    const it = (await items(share.id)).find((i) => i.id === req.params.evidenceId);
    if (!it || !STORED.includes(it.status)) throw notFound('Item');
    const v = auth.claims.ref === 'original' ? 'original' : 'watermarked';
    if (!share.allow_download || (v === 'original' && !share.allow_original)) await deny(req, share, [it], `${v} download not allowed`, new AppError(403, 'SHARE_DOWNLOAD_NOT_ALLOWED', 'This share does not allow this download'));
    const range = req.headers.range;
    const first = !range || /^bytes=0-/.test(range.trim());
    let obj: { bucket: string; key: string; versionId?: string | null; contentType: string; sha256: string | null; name: string };
    if (v === 'original') {
      const e = await app.db.selectFrom('evidence').select(['storage_bucket', 'storage_key', 'storage_version_id', 'sha256', 'evidence_number', 'original_filename']).where('id', '=', it.id).executeTakeFirstOrThrow();
      if (!e.storage_bucket || !e.storage_key) throw notFound('Item');
      obj = { bucket: e.storage_bucket, key: e.storage_key, versionId: e.storage_version_id, contentType: 'application/octet-stream', sha256: e.sha256, name: safeName(`${e.evidence_number ?? it.id}_${e.original_filename}`) };
    } else {
      const d = await variant(share, it.id);
      if (!d) throw notFound('Item');
      obj = { bucket: d.bucket, key: d.object_key, contentType: 'video/mp4', sha256: d.sha256, name: safeName(`${it.evidence_number ?? it.id}_${share.watermark ? 'WATERMARKED_COPY' : 'COPY'}.mp4`) };
    }
    if (first) {
      await app.db.updateTable('shares').set((eb) => ({ download_count: eb('download_count', '+', 1), last_accessed_at: new Date() })).where('id', '=', share.id).execute();
      await log(req, share.id, 'DOWNLOAD', it.id, v);
      await auditItems(req, share, 'SHARE_DOWNLOADED', [it], { variant: v, sha256: obj.sha256, range: range ?? null });
    }
    return sendObject(app.storage, req, reply, { bucket: obj.bucket, key: obj.key, versionId: obj.versionId, contentType: obj.contentType }, {
      'Content-Disposition': `attachment; filename="${obj.name}"`,
      ...(obj.sha256 ? { 'X-Content-SHA256': obj.sha256 } : {}),
    });
  });

  app.get('/items/:evidenceId/print', {
    config: { public: true, rateLimit: { max: test ? 10_000 : 30, timeWindow: '1 minute' } },
    schema: { tags: ['share-portal'], summary: 'Watermarked still frame (PNG) for printing', params: z.object({ evidenceId: z.string().uuid() }), querystring: z.object({ timeMs: z.coerce.number().min(0).max(1e10).default(0) }) },
  }, async (req, reply) => {
    const { share, it } = await sessionItem(req, req.params.evidenceId);
    if (!share.allow_print) await deny(req, share, [it], 'print not allowed', new AppError(403, 'SHARE_PRINT_NOT_ALLOWED', 'This share does not allow printing'));
    const d = await variant(share, it.id);
    if (!d) {
      if (share.watermark && it.media_status === 'READY') await ensureWatermark(share, it.id);
      return reply.status(202).send({ status: 'PREPARING', message: 'The watermarked copy is being prepared' });
    }
    const fps = (d.meta as { fps?: number }).fps ?? Number(it.frame_rate ?? 25);
    const durationMs = (d.meta as { durationMs?: number }).durationMs ?? Number(it.duration_ms ?? 0);
    const t = durationMs ? Math.min(req.query.timeMs, Math.max(0, durationMs - 100)) : req.query.timeMs;
    let frame;
    try {
      frame = await extractFrame({ input: await app.storage.internalUrl(d.bucket, d.object_key, 600), frame: frameAt(t, fps || 25), fps: fps || 25, workDir: app.cfg.WORK_DIR });
    } catch (err) {
      req.log.warn({ err }, 'share print frame extraction failed');
      throw new AppError(422, 'UNPROCESSABLE', 'Frame could not be extracted at this position');
    }
    await log(req, share.id, 'PRINT', it.id, `t=${Math.round(t)}ms`);
    await auditItems(req, share, 'SHARE_PRINTED', [it], { timeMs: Math.round(t), watermarked: share.watermark });
    return reply.header('Content-Type', 'image/png').header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff').send(frame.png);
  });
}
