/**
 * Secure-sharing helpers shared by the API (revoke) and the worker (shares.expire): per-share watermarked playback
 * variants (derived bucket, evidence_derivatives kind WATERMARKED, meta.shareId) are deleted as soon as the share
 * can no longer be used; each deletion is a custody event on the item.
 */
import { sql } from 'kysely';
import { appendAudit, type AuditActor } from './audit.js';
import type { Database } from './db/index.js';
import type { Storage } from './storage.js';

export async function deleteShareVariants(db: Database, storage: Storage, shareId: string, actor: AuditActor, reason: string): Promise<{ deleted: number; failed: number }> {
  const { rows } = await sql<{ id: string; evidence_id: string; bucket: string; object_key: string; sha256: string | null; org_unit_id: string; case_id: string | null }>`
    SELECT d.id, d.evidence_id, d.bucket, d.object_key, d.sha256, e.org_unit_id, s.case_id
      FROM evidence_derivatives d
      JOIN evidence e ON e.id = d.evidence_id
      JOIN shares s ON s.id = ${shareId}::uuid
     WHERE d.kind = 'WATERMARKED' AND d.meta->>'shareId' = ${shareId}`.execute(db);
  let deleted = 0;
  let failed = 0;
  for (const d of rows) {
    try {
      await storage.delete(d.bucket, d.object_key);
    } catch {
      failed++;
      continue; // keep the row so the next sweep retries
    }
    await db.transaction().execute(async (tx) => {
      await tx.deleteFrom('evidence_derivatives').where('id', '=', d.id).execute();
      await appendAudit(tx, actor, {
        action: 'SHARE_WATERMARK_DELETED', resourceType: 'share', resourceId: shareId, evidenceId: d.evidence_id, caseId: d.case_id, orgUnitId: d.org_unit_id,
        details: { derivativeId: d.id, sha256: d.sha256, reason },
      });
    });
    deleted++;
  }
  return { deleted, failed };
}
