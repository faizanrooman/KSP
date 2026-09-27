/**
 * Chain of custody (spec module 13).
 *
 *   GET /custody/evidence/:id             one keyset page of the chronological custody events (per-event ledger
 *                                         verification) + whole-chain verification of the item computed in SQL
 *                                         (?after=<seq> | ?before=<seq>, ?limit=1..1000 (200), ?filter=all|custody)
 *   GET /custody/evidence/:id/report.pdf  signed Chain-of-Custody report (PDF with signed JSON payload attached)
 *
 * Access: custody:read + the evidence must be visible to the caller (loadEvidenceFor; out of scope => 404).
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { AUDIT_ACTIONS, type AuditAction } from '@ksp/shared';
import { appendAudit } from '@ksp/core';
import { buildCustodyReport, loadCustodyPage, verifyCustodyChain, type CustodyEvent } from '@ksp/core/custody';
import { loadEvidenceFor } from '../../lib/access.js';

export const prefix = '/custody';

const idParams = z.object({ id: z.string().uuid() });
const seqParam = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const pageQuery = z
  .object({
    after: seqParam.optional(),
    before: seqParam.optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(200),
    filter: z.enum(['all', 'custody']).default('all'),
  })
  .strict()
  .refine((q) => q.after === undefined || q.before === undefined, { message: 'Use either after or before' });
const CUSTODY_ACTIONS = Object.entries(AUDIT_ACTIONS as Record<string, { custody: boolean }>).filter(([, a]) => a.custody).map(([code]) => code);

export function custodyEventDto(e: CustodyEvent) {
  return {
    seq: e.seq,
    eventId: e.eventId,
    occurredAt: e.occurredAt,
    action: e.action,
    category: e.category,
    custody: (AUDIT_ACTIONS as Record<string, { custody: boolean } | undefined>)[e.action as AuditAction]?.custody ?? false,
    outcome: e.outcome,
    actor: { type: e.actorType, id: e.actorId, username: e.actorName, name: e.actorFullName ?? e.actorName },
    ip: e.actorIp,
    resourceType: e.resourceType,
    resourceId: e.resourceId,
    caseId: e.caseId,
    details: e.details,
    prevHash: e.prevHash,
    hash: e.hash,
    verified: e.hashOk && e.linkOk,
  };
}

function safeName(v: string): string {
  return v.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'evidence';
}

export default async function custody(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get('/evidence/:id', {
    preHandler: app.authorize('custody:read'),
    schema: { tags: ['custody'], summary: 'Chain of custody of an evidence item (keyset pages), with whole-chain ledger verification', params: idParams, querystring: pageQuery },
  }, async (req) => {
    const p = req.requirePrincipal();
    const ev = await loadEvidenceFor(app.db, p, req.params.id, 'custody:read', req.actor());
    const row = await app.db
      .selectFrom('evidence')
      .select(['id', 'evidence_number', 'title', 'status', 'sha256', 'sha512', 'size_bytes', 'original_filename', 'registered_at', 'legal_hold'])
      .where('id', '=', ev.id)
      .executeTakeFirstOrThrow();
    const q = req.query;
    const actions = q.filter === 'custody' ? CUSTODY_ACTIONS : undefined;
    const [page, chain] = await Promise.all([
      loadCustodyPage(app.db, ev.id, { after: q.after, before: q.before, limit: q.limit, actions }),
      verifyCustodyChain(app.db, ev.id, actions),
    ]);
    const { firstSeq, lastSeq, matching, ...verification } = chain;
    const first = page.events[0]?.seq ?? null;
    const last = page.events[page.events.length - 1]?.seq ?? null;
    return {
      evidence: {
        id: row.id,
        evidenceNumber: row.evidence_number,
        title: row.title,
        status: row.status,
        sha256: row.sha256,
        sha512: row.sha512,
        sizeBytes: Number(row.size_bytes),
        originalFilename: row.original_filename,
        registeredAt: row.registered_at?.toISOString() ?? null,
        legalHold: row.legal_hold,
      },
      events: page.events.map(custodyEventDto),
      page: {
        limit: q.limit,
        filter: q.filter,
        total: matching,
        hasMore: page.hasMore,
        hasEarlier: page.hasEarlier,
        nextAfter: page.hasMore ? last : null,
        prevBefore: page.hasEarlier ? first : null,
        firstSeq,
        lastSeq,
      },
      verification,
    };
  });

  app.get('/evidence/:id/report.pdf', {
    preHandler: app.authorize('custody:read'),
    config: { rateLimit: { max: app.cfg.NODE_ENV === 'test' ? 10_000 : 30, timeWindow: '1 minute' } },
    schema: { tags: ['custody'], summary: 'Signed Chain-of-Custody report (PDF)', params: idParams },
  }, async (req, reply) => {
    const p = req.requirePrincipal();
    const ev = await loadEvidenceFor(app.db, p, req.params.id, 'custody:read', req.actor());
    const report = await buildCustodyReport(app.db, ev.id, { type: 'USER', id: p.userId, name: p.displayName });
    await appendAudit(app.db, req.actor(), {
      action: 'CUSTODY_REPORT_GENERATED',
      resourceType: 'evidence',
      resourceId: ev.id,
      evidenceId: ev.id,
      orgUnitId: ev.org_unit_id,
      details: {
        payloadSha256: report.payloadSha256,
        pdfSha256: createHash('sha256').update(report.pdf).digest('hex'),
        events: report.payload.events.length,
        chainIntact: report.payload.verification.chainIntact,
        ledgerHeadSeq: report.payload.verification.ledgerHead?.seq ?? null,
        keyId: report.signature.keyId,
        algorithm: report.signature.algorithm,
      },
    });
    const name = safeName(`custody_${ev.evidence_number ?? ev.id}.pdf`);
    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="${name}"`)
      .header('Cache-Control', 'private, no-store')
      .header('X-Payload-SHA256', report.payloadSha256)
      .header('X-Signature-Algorithm', report.signature.algorithm)
      .header('X-Signing-Key-Id', report.signature.keyId)
      .header('X-Certificate-Fingerprint', report.signature.certificateFingerprint256)
      .send(report.pdf);
  });
}
