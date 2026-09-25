/** Evidence list/detail queries and camelCase mapping. Never selects or returns storage bucket/key/version. */
import { sql } from 'kysely';
import { signMediaToken, type Database } from '@ksp/core';
import { evidenceVisibleSql, orgScopeSql } from '../../lib/access.js';
import type { Principal } from '../../lib/principal.js';

export const LIST_SORTS = ['created_at', 'recorded_at', 'evidence_number', 'size_bytes', 'duration_ms'] as const;

export interface ListFilters {
  q?: string;
  status?: string[];
  mediaStatus?: string[];
  orgUnitId?: string;
  officerId?: string;
  deviceId?: string;
  uploadedBy?: string;
  category?: string;
  tag?: string;
  recordedFrom?: Date;
  recordedTo?: Date;
  createdFrom?: Date;
  createdTo?: Date;
  legalHold?: boolean;
  storageTier?: string[];
  hasGps?: boolean;
  caseId?: string;
}

export function thumbnailUrl(p: Principal, evidenceId: string, derivativeId: string | null): string | null {
  if (!derivativeId || !p.userId) return null;
  const t = signMediaToken({ typ: 'USER', sub: p.userId, sid: p.sessionId ?? undefined, eid: evidenceId, scope: 'image', ref: derivativeId });
  return `/api/v1/media/image/${derivativeId}?t=${encodeURIComponent(t)}`;
}

const thumbSql = sql<string | null>`(SELECT dv.id FROM evidence_derivatives dv WHERE dv.evidence_id = e.id AND dv.kind IN ('THUMBNAIL','POSTER')
  ORDER BY (dv.kind = 'THUMBNAIL') DESC, dv.created_at DESC LIMIT 1)`;
const tagsSql = sql<string[]>`ARRAY(SELECT t.tag FROM evidence_tags t WHERE t.evidence_id = e.id ORDER BY t.tag)`;

function baseList(db: Database, p: Principal, f: ListFilters) {
  let q = db
    .selectFrom('evidence as e')
    .innerJoin('org_units as o', 'o.id', 'e.org_unit_id')
    .innerJoin('users as up', 'up.id', 'e.uploaded_by')
    .leftJoin('users as off', 'off.id', 'e.officer_id')
    .leftJoin('devices as d', 'd.id', 'e.device_id')
    .where(evidenceVisibleSql(p, 'e'));
  if (f.q) {
    const like = `%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    q = q.where(
      sql<boolean>`(e.search_text @@ plainto_tsquery('english', ${f.q}) OR e.search_text @@ plainto_tsquery('simple', ${f.q})
        OR e.evidence_number ILIKE ${like} OR e.title ILIKE ${like})`,
    );
  }
  if (f.status?.length) q = q.where('e.status', 'in', f.status);
  if (f.mediaStatus?.length) q = q.where('e.media_status', 'in', f.mediaStatus);
  if (f.storageTier?.length) q = q.where('e.storage_tier', 'in', f.storageTier);
  if (f.orgUnitId) q = q.where(sql<boolean>`e.org_path <@ (SELECT path FROM org_units WHERE id = ${f.orgUnitId}::uuid)`);
  if (f.officerId) q = q.where('e.officer_id', '=', f.officerId);
  if (f.deviceId) q = q.where('e.device_id', '=', f.deviceId);
  if (f.uploadedBy) q = q.where('e.uploaded_by', '=', f.uploadedBy);
  if (f.category) q = q.where('e.category', '=', f.category);
  if (f.tag) q = q.where(sql<boolean>`EXISTS (SELECT 1 FROM evidence_tags t WHERE t.evidence_id = e.id AND t.tag = ${f.tag.toLowerCase()})`);
  if (f.recordedFrom) q = q.where('e.recorded_at', '>=', f.recordedFrom);
  if (f.recordedTo) q = q.where('e.recorded_at', '<=', f.recordedTo);
  if (f.createdFrom) q = q.where('e.created_at', '>=', f.createdFrom);
  if (f.createdTo) q = q.where('e.created_at', '<=', f.createdTo);
  if (f.legalHold !== undefined) q = q.where('e.legal_hold', '=', f.legalHold);
  if (f.hasGps !== undefined) q = q.where(f.hasGps ? sql<boolean>`e.gps_latitude IS NOT NULL` : sql<boolean>`e.gps_latitude IS NULL`);
  if (f.caseId) q = q.where(sql<boolean>`EXISTS (SELECT 1 FROM case_evidence ce WHERE ce.evidence_id = e.id AND ce.case_id = ${f.caseId}::uuid AND ce.unlinked_at IS NULL)`);
  return q;
}

export async function listEvidence(db: Database, p: Principal, f: ListFilters, sort: string, page: number, pageSize: number) {
  const desc = sort.startsWith('-');
  const key = (desc ? sort.slice(1) : sort) as (typeof LIST_SORTS)[number];
  const dir = desc ? sql.raw('DESC NULLS LAST') : sql.raw('ASC NULLS LAST');
  const rows = await baseList(db, p, f)
    .select([
      'e.id', 'e.evidence_number', 'e.status', 'e.status_reason', 'e.media_status', 'e.title', 'e.category', 'e.recorded_at', 'e.duration_ms',
      'e.size_bytes', 'e.width', 'e.height', 'e.storage_tier', 'e.legal_hold', 'e.created_at', 'e.registered_at',
      'o.id as org_id', 'o.name as org_name', 'o.code as org_code',
      'off.id as off_id', 'off.full_name as off_name', 'off.badge_number as off_badge',
      'd.id as dev_id', 'd.serial_number as dev_serial',
      'up.id as up_id', 'up.full_name as up_name',
    ])
    .select([tagsSql.as('tags'), thumbSql.as('thumb_id'), sql<number>`count(*) OVER ()`.as('total')])
    .orderBy(sql`${sql.ref(`e.${key}`)} ${dir}`)
    .orderBy('e.id')
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .execute();
  let total = rows[0]?.total ?? 0;
  if (!rows.length && page > 1) {
    const c = await baseList(db, p, f).select(sql<number>`count(*)`.as('n')).executeTakeFirst();
    total = Number(c?.n ?? 0);
  }
  return {
    items: rows.map((r) => ({
      id: r.id,
      evidenceNumber: r.evidence_number,
      status: r.status,
      statusReason: r.status_reason,
      mediaStatus: r.media_status,
      title: r.title,
      category: r.category,
      orgUnit: { id: r.org_id, name: r.org_name, code: r.org_code },
      officer: r.off_id ? { id: r.off_id, fullName: r.off_name, badgeNumber: r.off_badge } : null,
      device: r.dev_id ? { id: r.dev_id, serialNumber: r.dev_serial } : null,
      uploadedBy: { id: r.up_id, fullName: r.up_name },
      recordedAt: r.recorded_at,
      durationMs: r.duration_ms,
      sizeBytes: r.size_bytes,
      width: r.width,
      height: r.height,
      storageTier: r.storage_tier,
      legalHold: r.legal_hold,
      tags: r.tags ?? [],
      thumbnailUrl: thumbnailUrl(p, r.id, r.thumb_id),
      createdAt: r.created_at,
      registeredAt: r.registered_at,
    })),
    total: Number(total),
    page,
    pageSize,
  };
}

/** Full detail (caller must already have passed loadEvidenceFor). */
export async function loadDetail(db: Database, p: Principal, id: string): Promise<{ row: { id: string; org_path: string; status: string; legal_hold: boolean }; body: Record<string, unknown> }> {
  const r = await db
    .selectFrom('evidence as e')
    .innerJoin('org_units as o', 'o.id', 'e.org_unit_id')
    .innerJoin('users as up', 'up.id', 'e.uploaded_by')
    .leftJoin('users as off', 'off.id', 'e.officer_id')
    .leftJoin('devices as d', 'd.id', 'e.device_id')
    .leftJoin('retention_policies as rp', 'rp.id', 'e.retention_policy_id')
    .leftJoin('users as lh', 'lh.id', 'e.legal_hold_by')
    .leftJoin('evidence as dup', 'dup.id', 'e.duplicate_of')
    .select([
      'e.id', 'e.evidence_number', 'e.status', 'e.status_reason', 'e.media_status', 'e.media_error', 'e.org_unit_id', 'e.org_path', 'e.title',
      'e.description', 'e.category', 'e.incident_at', 'e.location_text', 'e.original_filename', 'e.mime_type', 'e.size_bytes', 'e.sha256',
      'e.sha512', 'e.storage_tier', 'e.object_lock_until', 'e.recorded_at', 'e.recorded_end_at', 'e.duration_ms', 'e.container_format',
      'e.video_codec', 'e.audio_codec', 'e.width', 'e.height', 'e.frame_rate', 'e.bit_rate', 'e.gps_latitude', 'e.gps_longitude',
      'e.gps_source', 'e.device_metadata', 'e.retain_until', 'e.legal_hold', 'e.legal_hold_reason', 'e.legal_hold_at', 'e.registered_at',
      'e.archived_at', 'e.disposed_at', 'e.last_verified_at', 'e.duplicate_of', 'e.created_at', 'e.updated_at',
      'o.name as org_name', 'o.code as org_code',
      'up.id as up_id', 'up.full_name as up_name',
      'off.id as off_id', 'off.full_name as off_name', 'off.badge_number as off_badge',
      'd.id as dev_id', 'd.serial_number as dev_serial', 'd.device_type as dev_type', 'd.make as dev_make', 'd.model as dev_model',
      'rp.id as rp_id', 'rp.name as rp_name',
      'lh.id as lh_id', 'lh.full_name as lh_name',
      'dup.evidence_number as dup_number',
    ])
    .select([thumbSql.as('thumb_id')])
    .where('e.id', '=', id)
    .executeTakeFirstOrThrow();
  const tags = await db.selectFrom('evidence_tags').select(['tag', 'source', 'created_at']).where('evidence_id', '=', id).orderBy('tag').execute();
  const casesVisible = p.userId
    ? sql<boolean>`(${orgScopeSql(p, 'cases:read', 'c.org_path')} OR c.investigating_officer_id = ${p.userId}::uuid OR c.supervisor_id = ${p.userId}::uuid
        OR EXISTS (SELECT 1 FROM case_members cm WHERE cm.case_id = c.id AND cm.user_id = ${p.userId}::uuid))`
    : orgScopeSql(p, 'cases:read', 'c.org_path');
  const cases = await db
    .selectFrom('case_evidence as ce')
    .innerJoin('cases as c', 'c.id', 'ce.case_id')
    .select(['c.id', 'c.case_number', 'c.title', 'c.status', 'ce.linked_at', sql<boolean>`${casesVisible}`.as('visible')])
    .where('ce.evidence_id', '=', id)
    .where('ce.unlinked_at', 'is', null)
    .orderBy('ce.linked_at')
    .execute();
  return {
    row: { id: r.id, org_path: r.org_path, status: r.status, legal_hold: r.legal_hold },
    body: {
      id: r.id,
      evidenceNumber: r.evidence_number,
      status: r.status,
      statusReason: r.status_reason,
      mediaStatus: r.media_status,
      mediaError: r.media_error,
      orgUnitId: r.org_unit_id,
      orgUnit: { id: r.org_unit_id, name: r.org_name, code: r.org_code },
      title: r.title,
      description: r.description,
      category: r.category,
      incidentAt: r.incident_at,
      locationText: r.location_text,
      originalFilename: r.original_filename,
      mimeType: r.mime_type,
      sizeBytes: r.size_bytes,
      sha256: r.sha256,
      sha512: r.sha512,
      storageTier: r.storage_tier,
      objectLockUntil: r.object_lock_until,
      recordedAt: r.recorded_at,
      recordedEndAt: r.recorded_end_at,
      durationMs: r.duration_ms,
      containerFormat: r.container_format,
      videoCodec: r.video_codec,
      audioCodec: r.audio_codec,
      width: r.width,
      height: r.height,
      frameRate: r.frame_rate === null ? null : Number(r.frame_rate),
      bitRate: r.bit_rate,
      gpsLatitude: r.gps_latitude,
      gpsLongitude: r.gps_longitude,
      gpsSource: r.gps_source,
      deviceMetadata: r.device_metadata,
      officer: r.off_id ? { id: r.off_id, fullName: r.off_name, badgeNumber: r.off_badge } : null,
      device: r.dev_id ? { id: r.dev_id, serialNumber: r.dev_serial, deviceType: r.dev_type, make: r.dev_make, model: r.dev_model } : null,
      uploadedBy: { id: r.up_id, fullName: r.up_name },
      retentionPolicy: r.rp_id ? { id: r.rp_id, name: r.rp_name } : null,
      retainUntil: r.retain_until,
      legalHold: r.legal_hold,
      legalHoldReason: r.legal_hold_reason,
      legalHoldBy: r.lh_id ? { id: r.lh_id, fullName: r.lh_name } : null,
      legalHoldAt: r.legal_hold_at,
      registeredAt: r.registered_at,
      archivedAt: r.archived_at,
      disposedAt: r.disposed_at,
      lastVerifiedAt: r.last_verified_at,
      duplicateOf: r.duplicate_of ? { id: r.duplicate_of, evidenceNumber: r.dup_number } : null,
      thumbnailUrl: thumbnailUrl(p, r.id, r.thumb_id),
      tags: tags.map((t) => ({ tag: t.tag, source: t.source, createdAt: t.created_at })),
      cases: cases.filter((c) => c.visible).map((c) => ({ id: c.id, caseNumber: c.case_number, title: c.title, status: c.status, linkedAt: c.linked_at })),
      hiddenCaseCount: cases.filter((c) => !c.visible).length,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    },
  };
}
