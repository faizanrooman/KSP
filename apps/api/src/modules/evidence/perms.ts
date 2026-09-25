/**
 * Per-evidence action permissions for the detail response (mirrors the rules in lib/access.ts
 * loadEvidenceFor so the UI never offers an action the API would refuse).
 */
import type { Permission } from '@ksp/shared';
import type { Database } from '@ksp/core';
import { evidenceVisibleSql } from '../../lib/access.js';
import { hasPermission, hasPermissionAt, type Principal } from '../../lib/principal.js';

export interface EvidencePermissions {
  canPlay: boolean;
  canDownloadOriginal: boolean;
  canEdit: boolean;
  canLegalHold: boolean;
  canVerify: boolean;
  canRequestDisposal: boolean;
  canApproveDisposal: boolean;
  canManageRetention: boolean;
  canSnapshot: boolean;
  canRequestAi: boolean;
  canExport: boolean;
  canShare: boolean;
  canLinkCase: boolean;
  canViewCustody: boolean;
}

export async function evidencePermissions(
  db: Database,
  p: Principal,
  ev: { id: string; org_path: string; status: string; legal_hold: boolean },
): Promise<EvidencePermissions> {
  const rel = !!(await db
    .selectFrom('evidence')
    .select('id')
    .where('id', '=', ev.id)
    .where(evidenceVisibleSql(p, 'evidence', { jurisdiction: false }))
    .executeTakeFirst());
  const can = (perm: Permission) => hasPermissionAt(p, perm, ev.org_path) || (rel && hasPermission(p, perm) && perm !== 'evidence:download_original');
  let download = hasPermissionAt(p, 'evidence:download_original', ev.org_path);
  if (!download && p.userId) {
    download = !!(await db
      .selectFrom('share_items as si')
      .innerJoin('shares as s', 's.id', 'si.share_id')
      .select('s.id')
      .where('si.evidence_id', '=', ev.id)
      .where('s.recipient_user_id', '=', p.userId)
      .where('s.status', '=', 'ACTIVE')
      .where('s.allow_download', '=', true)
      .where('s.expires_at', '>', new Date())
      .executeTakeFirst());
  }
  const stored = ev.status === 'REGISTERED' || ev.status === 'DISPOSAL_PENDING';
  const live = ev.status !== 'DISPOSED' && ev.status !== 'REJECTED';
  return {
    canPlay: stored && can('evidence:play'),
    canDownloadOriginal: stored && download,
    canEdit: live && can('evidence:edit_metadata'),
    canLegalHold: ev.status !== 'DISPOSED' && can('evidence:legal_hold'),
    canVerify: stored && can('evidence:verify'),
    canRequestDisposal: ev.status === 'REGISTERED' && !ev.legal_hold && can('evidence:dispose_request'),
    canApproveDisposal: ev.status === 'DISPOSAL_PENDING' && can('evidence:dispose_approve'),
    canManageRetention: stored && can('retention:manage'),
    canSnapshot: stored && can('evidence:snapshot'),
    canRequestAi: stored && can('ai:request'),
    canExport: stored && can('export:create'),
    canShare: stored && can('share:create'),
    canLinkCase: live && can('cases:link_evidence'),
    canViewCustody: can('custody:read'),
  };
}

