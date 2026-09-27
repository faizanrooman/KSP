/**
 * maxViews for INTERNAL shares (FN-11). An internal recipient "opens" a shared item when they load its detail
 * page or request playback AND the item is visible to them only through a share (rules 1–3 of lib/access.ts do not
 * apply). The first open of an item within OPEN_WINDOW_MINUTES counts one view on the share (repeat requests of the
 * same viewing session — detail, then playback — do not); the share stops granting visibility once
 * view_count ≥ max_views and the last open is older than the window (evidenceVisibleSql rule 4).
 * Each counted open is a SHARE_ACCESSED custody event (details.via = 'internal') and a share_access_log VIEW row.
 */
import { sql } from 'kysely';
import { appendAudit, type AuditActor, type Database } from '@ksp/core';
import type { Principal } from './principal.js';
import { evidenceVisibleSql } from './access.js';
import { notFound } from './errors.js';

export const OPEN_WINDOW_MINUTES = 30;

export async function recordInternalShareOpen(db: Database, p: Principal, ev: { id: string; org_unit_id: string }, actor: AuditActor, meta: { ip?: string | null; userAgent?: string | null; via: 'detail' | 'playback' }): Promise<{ counted: boolean; shareId?: string; viewCount?: number }> {
  if (!p.userId) return { counted: false };
  const uid = p.userId;
  // Visible without shares (jurisdiction / own / case)? Then shares are not the reason and nothing is counted.
  const other = await db.selectFrom('evidence').select('id').where('id', '=', ev.id).where(evidenceVisibleSql(p, 'evidence', { shares: false })).executeTakeFirst();
  if (other) return { counted: false };
  const shares = await db
    .selectFrom('share_items as si')
    .innerJoin('shares as s', 's.id', 'si.share_id')
    .select(['s.id', 's.max_views', 's.view_count', 's.case_id', 's.expires_at', 's.last_accessed_at'])
    .where('si.evidence_id', '=', ev.id)
    .where('s.recipient_user_id', '=', uid)
    .where('s.status', '=', 'ACTIVE')
    .where('s.expires_at', '>', new Date())
    .orderBy('s.expires_at')
    .execute();
  if (!shares.length || shares.some((s) => s.max_views === null)) return { counted: false }; // an unlimited share covers it
  // Same viewing session of this item (any of the user's shares) → not a new open.
  const recent = await db.selectFrom('share_access_log').select('id')
    .where('share_id', 'in', shares.map((s) => s.id)).where('evidence_id', '=', ev.id).where('action', '=', 'VIEW').where('detail', '=', `internal:${uid}`)
    .where('created_at', '>', sql<Date>`now() - make_interval(mins => ${OPEN_WINDOW_MINUTES})`).executeTakeFirst();
  if (recent) return { counted: false };
  for (const s of shares) {
    const upd = await db.transaction().execute(async (tx) => {
      const row = await tx.updateTable('shares')
        .set((eb) => ({ view_count: eb('view_count', '+', 1), last_accessed_at: new Date() }))
        .where('id', '=', s.id).where('status', '=', 'ACTIVE').where('view_count', '<', eb => eb.ref('max_views'))
        .returning(['view_count', 'max_views']).executeTakeFirst();
      if (!row) return null;
      await tx.insertInto('share_access_log').values({ share_id: s.id, evidence_id: ev.id, action: 'VIEW', ip: meta.ip ?? null, user_agent: meta.userAgent?.slice(0, 512) ?? null, detail: `internal:${uid}` }).execute();
      await appendAudit(tx, actor, {
        action: 'SHARE_ACCESSED', resourceType: 'share', resourceId: s.id, evidenceId: ev.id, caseId: s.case_id, orgUnitId: ev.org_unit_id,
        details: { via: 'internal', open: meta.via, view: row.view_count, maxViews: row.max_views },
      });
      return row;
    });
    if (upd) return { counted: true, shareId: s.id, viewCount: upd.view_count };
  }
  // Every covering share is used up (the list query saw it within the last open window only).
  throw notFound('Evidence');
}
