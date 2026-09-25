/**
 * Advanced search criteria (validated body of POST /search/evidence and saved searches) and their
 * translation into parameterised SQL predicates on `evidence e`.
 *
 * Every predicate list starts with evidenceVisibleSql — callers never get a condition set without it.
 * All tiers (ACTIVE / ARCHIVE / LONG_TERM) are searched: the metadata index lives in PostgreSQL and is
 * independent of where the original object is stored (see docs/SEARCH.md "Federated search").
 */
import { sql, type RawBuilder } from 'kysely';
import { z } from 'zod';
import { AI_TASKS, EVIDENCE_STATUSES, MEDIA_STATUSES, STORAGE_TIERS } from '@ksp/shared';
import { evidenceVisibleSql, orgScopeSql } from '../../lib/access.js';
import type { Principal } from '../../lib/principal.js';

const uuids = z.array(z.string().uuid()).min(1).max(50);
const shortText = (max: number) => z.string().trim().min(1).max(max);

export const AI_REVIEW_FILTERS = ['APPROVED', 'ANY_NON_REJECTED'] as const;

export const aiCriteriaSchema = z
  .object({
    tasks: z.array(z.enum(AI_TASKS)).min(1).max(AI_TASKS.length).optional(),
    labels: z.array(shortText(64)).min(1).max(20).optional(),
    colors: z.array(shortText(32)).min(1).max(20).optional(),
    plateText: shortText(20).optional(),
    watchlistEntryIds: uuids.optional(),
    minConfidence: z.number().min(0).max(1).optional(),
    /** APPROVED (default): human-approved results only. ANY_NON_REJECTED: explicitly include unreviewed AI output. */
    reviewStatus: z.enum(AI_REVIEW_FILTERS).default('APPROVED'),
  })
  .strict();

export const criteriaObject = z
  .object({
    text: shortText(200).optional(),
    evidenceNumber: shortText(64).optional(),
    orgUnitIds: uuids.optional(),
    officerIds: uuids.optional(),
    officerBadge: shortText(64).optional(),
    deviceIds: uuids.optional(),
    deviceSerial: shortText(100).optional(),
    uploadedBy: z.string().uuid().optional(),
    recordedFrom: z.coerce.date().optional(),
    recordedTo: z.coerce.date().optional(),
    createdFrom: z.coerce.date().optional(),
    createdTo: z.coerce.date().optional(),
    location: z
      .object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), radiusKm: z.number().positive().max(500) })
      .strict()
      .optional(),
    bbox: z
      .object({ minLat: z.number().min(-90).max(90), maxLat: z.number().min(-90).max(90), minLon: z.number().min(-180).max(180), maxLon: z.number().min(-180).max(180) })
      .strict()
      .refine((b) => b.minLat <= b.maxLat && b.minLon <= b.maxLon, 'bbox min must not exceed max')
      .optional(),
    tags: z.array(shortText(63).transform((t) => t.toLowerCase())).min(1).max(20).optional(),
    tagMode: z.enum(['any', 'all']).default('any'),
    categories: z.array(shortText(100)).min(1).max(20).optional(),
    statuses: z.array(z.enum(EVIDENCE_STATUSES)).min(1).optional(),
    mediaStatuses: z.array(z.enum(MEDIA_STATUSES)).min(1).optional(),
    storageTiers: z.array(z.enum(STORAGE_TIERS)).min(1).optional(),
    legalHold: z.boolean().optional(),
    caseIds: uuids.optional(),
    caseNumber: shortText(64).optional(),
    firNumber: shortText(64).optional(),
    /** Registering police station of the FIR (subtree). */
    firOrgUnitId: z.string().uuid().optional(),
    firYear: z.number().int().min(1950).max(2200).optional(),
    ai: aiCriteriaSchema.optional(),
  })
  .strict();

type CriteriaShape = z.infer<typeof criteriaObject>;
/** Cross-field rules shared by the search body and saved searches. */
export function refineCriteria(c: Partial<CriteriaShape>, ctx: z.RefinementCtx) {
  if (c.recordedFrom && c.recordedTo && c.recordedFrom > c.recordedTo) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'recordedFrom must be before recordedTo', path: ['recordedTo'] });
  if (c.createdFrom && c.createdTo && c.createdFrom > c.createdTo) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'createdFrom must be before createdTo', path: ['createdTo'] });
  if ((c.firOrgUnitId || c.firYear) && !c.firNumber) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'firOrgUnitId / firYear refine a firNumber search', path: ['firNumber'] });
  if (c.location && c.bbox) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Use either location (radius) or bbox, not both', path: ['bbox'] });
}

export const criteriaSchema = criteriaObject.superRefine(refineCriteria);

export type SearchCriteria = CriteriaShape;
export type AiCriteria = z.infer<typeof aiCriteriaSchema>;

export const escapeLike = (v: string) => v.replace(/[\\%_]/g, (m) => `\\${m}`);
export const normPlate = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Cases the principal may read: jurisdiction (cases:read) or IO / supervisor / case member. */
export function caseVisibleSql(p: Principal, alias = 'c'): RawBuilder<boolean> {
  const c = sql.raw(`"${alias.replace(/"/g, '')}"`);
  const scope = orgScopeSql(p, 'cases:read', `${alias}.org_path`);
  if (!p.userId) return scope;
  return sql<boolean>`(${scope} OR ${c}.investigating_officer_id = ${p.userId}::uuid OR ${c}.supervisor_id = ${p.userId}::uuid
    OR EXISTS (SELECT 1 FROM case_members cm WHERE cm.case_id = ${c}.id AND cm.user_id = ${p.userId}::uuid))`;
}

/** The text query as a tsquery (english stemming OR simple tokens, so evidence numbers / codes also match). */
export const tsQuery = (text: string) => sql`(websearch_to_tsquery('english', ${text}) || websearch_to_tsquery('simple', ${text}))`;

/** Effective (reviewer-corrected) detection label. */
export const effLabel = (d: string) => sql.raw(`lower(coalesce(${d}.corrected_label, ${d}.label))`);

/** Predicates on ai_detections alias `d` (NOT correlated with evidence — callers add that). */
export function aiDetectionConds(ai: AiCriteria, d = 'd'): RawBuilder<boolean>[] {
  const t = sql.raw(d);
  const out: RawBuilder<boolean>[] = [
    ai.reviewStatus === 'APPROVED' ? sql<boolean>`${t}.review_status = 'APPROVED'` : sql<boolean>`${t}.review_status <> 'REJECTED'`,
  ];
  if (ai.tasks?.length) out.push(sql<boolean>`${t}.task = ANY(${ai.tasks}::text[])`);
  if (ai.labels?.length) out.push(sql<boolean>`${effLabel(d)} = ANY(${ai.labels.map((l) => l.toLowerCase())}::text[])`);
  if (ai.colors?.length) out.push(sql<boolean>`${t}.attributes ? 'colorName' AND lower(${t}.attributes->>'colorName') = ANY(${ai.colors.map((c) => c.toLowerCase())}::text[])`);
  if (ai.plateText) {
    const n = normPlate(ai.plateText);
    // plate text is A-Z0-9 only after normalisation, so no LIKE escaping is needed
    out.push(n ? sql<boolean>`${t}.attributes ? 'plateText' AND ksp_plate_norm(${t}.attributes->>'plateText') LIKE ${`${n}%`}` : sql<boolean>`false`);
  }
  if (ai.watchlistEntryIds?.length) out.push(sql<boolean>`${t}.attributes ? 'watchlistEntryId' AND (${t}.attributes->>'watchlistEntryId') = ANY(${ai.watchlistEntryIds}::text[])`);
  if (ai.minConfidence !== undefined) out.push(sql<boolean>`${t}.confidence >= ${ai.minConfidence}`);
  return out;
}

const and = (conds: RawBuilder<boolean>[]) => sql<boolean>`(${sql.join(conds, sql` AND `)})`;

/** Great-circle distance in km between evidence e GPS and (lat, lon). */
export const haversineKm = (alias: string, lat: number, lon: number) => {
  const e = sql.raw(alias);
  return sql<number>`(6371.0088 * 2 * asin(least(1, sqrt(
    power(sin(radians(${e}.gps_latitude - ${lat}::float8) / 2), 2)
    + cos(radians(${lat}::float8)) * cos(radians(${e}.gps_latitude)) * power(sin(radians(${e}.gps_longitude - ${lon}::float8) / 2), 2)))))`;
};

/** Bounding box around (lat, lon) that contains the radius circle — lets the (lat, lon) btree index prefilter. */
export function radiusBox(lat: number, lon: number, radiusKm: number) {
  const dLat = radiusKm / 110.574;
  const dLon = radiusKm / (111.32 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
  return { minLat: Math.max(-90, lat - dLat), maxLat: Math.min(90, lat + dLat), minLon: Math.max(-180, lon - dLon), maxLon: Math.min(180, lon + dLon) };
}

/** All SQL predicates for the criteria on alias `e` — the first one is ALWAYS evidenceVisibleSql. */
export function buildConditions(p: Principal, c: SearchCriteria): RawBuilder<boolean>[] {
  const conds: RawBuilder<boolean>[] = [evidenceVisibleSql(p, 'e')];
  if (c.text) {
    const like = `%${escapeLike(c.text)}%`;
    conds.push(sql<boolean>`(e.search_text @@ ${tsQuery(c.text)} OR ${c.text} <<% e.title OR e.evidence_number ILIKE ${like} OR e.original_filename ILIKE ${like})`);
  }
  if (c.evidenceNumber) conds.push(sql<boolean>`e.evidence_number ILIKE ${`${escapeLike(c.evidenceNumber)}%`}`);
  if (c.orgUnitIds?.length) conds.push(sql<boolean>`e.org_path <@ ARRAY(SELECT ou.path FROM org_units ou WHERE ou.id = ANY(${c.orgUnitIds}::uuid[]))`);
  if (c.officerIds?.length) conds.push(sql<boolean>`e.officer_id = ANY(${c.officerIds}::uuid[])`);
  if (c.officerBadge) conds.push(sql<boolean>`e.officer_id IN (SELECT u.id FROM users u WHERE upper(u.badge_number) = upper(${c.officerBadge}))`);
  if (c.deviceIds?.length) conds.push(sql<boolean>`e.device_id = ANY(${c.deviceIds}::uuid[])`);
  if (c.deviceSerial) conds.push(sql<boolean>`e.device_id IN (SELECT dv.id FROM devices dv WHERE upper(dv.serial_number) = upper(${c.deviceSerial}))`);
  if (c.uploadedBy) conds.push(sql<boolean>`e.uploaded_by = ${c.uploadedBy}::uuid`);
  if (c.recordedFrom) conds.push(sql<boolean>`e.recorded_at >= ${c.recordedFrom}`);
  if (c.recordedTo) conds.push(sql<boolean>`e.recorded_at <= ${c.recordedTo}`);
  if (c.createdFrom) conds.push(sql<boolean>`e.created_at >= ${c.createdFrom}`);
  if (c.createdTo) conds.push(sql<boolean>`e.created_at <= ${c.createdTo}`);
  if (c.location) {
    const { lat, lon, radiusKm } = c.location;
    const b = radiusBox(lat, lon, radiusKm);
    conds.push(sql<boolean>`(e.gps_latitude BETWEEN ${b.minLat} AND ${b.maxLat} AND e.gps_longitude BETWEEN ${b.minLon} AND ${b.maxLon}
      AND ${haversineKm('e', lat, lon)} <= ${radiusKm})`);
  }
  if (c.bbox) conds.push(sql<boolean>`(e.gps_latitude BETWEEN ${c.bbox.minLat} AND ${c.bbox.maxLat} AND e.gps_longitude BETWEEN ${c.bbox.minLon} AND ${c.bbox.maxLon})`);
  if (c.tags?.length) {
    const tags = [...new Set(c.tags)];
    conds.push(
      c.tagMode === 'all'
        ? sql<boolean>`(SELECT count(*) FROM evidence_tags t WHERE t.evidence_id = e.id AND t.tag = ANY(${tags}::text[])) = ${tags.length}`
        : sql<boolean>`EXISTS (SELECT 1 FROM evidence_tags t WHERE t.evidence_id = e.id AND t.tag = ANY(${tags}::text[]))`,
    );
  }
  if (c.categories?.length) conds.push(sql<boolean>`e.category = ANY(${c.categories}::text[])`);
  if (c.statuses?.length) conds.push(sql<boolean>`e.status = ANY(${c.statuses}::text[])`);
  if (c.mediaStatuses?.length) conds.push(sql<boolean>`e.media_status = ANY(${c.mediaStatuses}::text[])`);
  if (c.storageTiers?.length) conds.push(sql<boolean>`e.storage_tier = ANY(${c.storageTiers}::text[])`);
  if (c.legalHold !== undefined) conds.push(c.legalHold ? sql<boolean>`e.legal_hold` : sql<boolean>`NOT e.legal_hold`);
  // Case / FIR filters only match cases the caller may read (no leak of links to cases outside their scope).
  const caseLink = (extra: RawBuilder<boolean>) =>
    sql<boolean>`EXISTS (SELECT 1 FROM case_evidence ce JOIN cases c ON c.id = ce.case_id
      WHERE ce.evidence_id = e.id AND ce.unlinked_at IS NULL AND ${caseVisibleSql(p, 'c')} AND ${extra})`;
  if (c.caseIds?.length) conds.push(caseLink(sql<boolean>`c.id = ANY(${c.caseIds}::uuid[])`));
  if (c.caseNumber) conds.push(caseLink(sql<boolean>`c.case_number ILIKE ${`${escapeLike(c.caseNumber)}%`}`));
  if (c.firNumber) {
    const fir: RawBuilder<boolean>[] = [sql<boolean>`upper(f.fir_number) = upper(${c.firNumber})`];
    if (c.firYear) fir.push(sql<boolean>`f.fir_year = ${c.firYear}`);
    if (c.firOrgUnitId) fir.push(sql<boolean>`f.org_path <@ (SELECT ou.path FROM org_units ou WHERE ou.id = ${c.firOrgUnitId}::uuid)`);
    conds.push(caseLink(sql<boolean>`EXISTS (SELECT 1 FROM firs f WHERE f.id = c.fir_id AND ${and(fir)})`));
  }
  if (c.ai) conds.push(sql<boolean>`EXISTS (SELECT 1 FROM ai_detections d WHERE d.evidence_id = e.id AND ${and(aiDetectionConds(c.ai))})`);
  return conds;
}

export const whereSql = (conds: RawBuilder<boolean>[]) => and(conds);

/** Criteria as recorded in the audit trail: structure only, free text truncated, dates as ISO. Never results. */
export function auditCriteria(c: SearchCriteria): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) {
    if (v === undefined) continue;
    if (k === 'tagMode' && !c.tags) continue;
    out[k] = v instanceof Date ? v.toISOString() : typeof v === 'string' ? v.slice(0, 200) : v;
  }
  return out;
}
