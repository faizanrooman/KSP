/**
 * Related-evidence suggestions for one (already authorised) evidence item. Every candidate query applies
 * evidenceVisibleSql, so suggestions never reveal items the caller cannot see.
 *
 *   SAME_CASE        linked to the same active case (case readable by the caller)
 *   SAME_OFFICER     same recording officer, recorded within ±1 h of the source recording
 *   SAME_DEVICE      same device, within ±1 h
 *   NEARBY           GPS within 200 m AND recording time ranges overlap
 *   SHARED_PLATE     both have an APPROVED detection with the same normalised plate
 *   SHARED_WATCHLIST both have an APPROVED detection of the same watchlist entry
 *   RELATION         explicit evidence_relations row (either direction)
 */
import { sql, type RawBuilder } from 'kysely';
import type { Database } from '@ksp/core';
import { evidenceVisibleSql } from '../../lib/access.js';
import type { Principal } from '../../lib/principal.js';
import { loadListItems } from '../evidence/queries.js';
import { caseVisibleSql, haversineKm, radiusBox } from './criteria.js';

export const RELATED_WINDOW_MS = 3_600_000;
export const NEARBY_RADIUS_KM = 0.2;
const PER_REASON = 50;

export interface RelatedReason {
  kind: 'SAME_CASE' | 'SAME_OFFICER' | 'SAME_DEVICE' | 'NEARBY' | 'SHARED_PLATE' | 'SHARED_WATCHLIST' | 'RELATION';
  detail: string;
  relationId?: string;
  relation?: string;
}

const spanEnd = (a: string) => sql.raw(`coalesce(${a}.recorded_end_at, ${a}.recorded_at + make_interval(secs => coalesce(${a}.duration_ms, 0) / 1000.0))`);

export async function relatedEvidence(db: Database, p: Principal, evidenceId: string) {
  const src = await db
    .selectFrom('evidence')
    .select(['id', 'officer_id', 'device_id', 'recorded_at', 'recorded_end_at', 'duration_ms', 'gps_latitude', 'gps_longitude'])
    .where('id', '=', evidenceId)
    .executeTakeFirstOrThrow();
  const visible = evidenceVisibleSql(p, 'e');
  const reasons = new Map<string, RelatedReason[]>();
  const add = (id: string, r: RelatedReason) => reasons.set(id, [...(reasons.get(id) ?? []), r]);
  const run = async <T extends { id: string }>(q: RawBuilder<T>) => (await q.execute(db)).rows;

  const jobs: Promise<void>[] = [];
  jobs.push(
    run(sql<{ id: string; case_number: string }>`SELECT DISTINCT ON (e.id) e.id, c.case_number FROM case_evidence s
      JOIN cases c ON c.id = s.case_id AND ${caseVisibleSql(p, 'c')}
      JOIN case_evidence ce ON ce.case_id = s.case_id AND ce.unlinked_at IS NULL AND ce.evidence_id <> s.evidence_id
      JOIN evidence e ON e.id = ce.evidence_id
      WHERE s.evidence_id = ${src.id}::uuid AND s.unlinked_at IS NULL AND ${visible} LIMIT ${PER_REASON}`).then((rows) =>
      rows.forEach((r) => add(r.id, { kind: 'SAME_CASE', detail: `Linked to case ${r.case_number}` })),
    ),
  );
  if (src.recorded_at) {
    const from = new Date(src.recorded_at.getTime() - RELATED_WINDOW_MS);
    const srcEnd = src.recorded_end_at ?? new Date(src.recorded_at.getTime() + Number(src.duration_ms ?? 0));
    const to = new Date(srcEnd.getTime() + RELATED_WINDOW_MS);
    if (src.officer_id) {
      jobs.push(
        run(sql<{ id: string }>`SELECT e.id FROM evidence e WHERE e.officer_id = ${src.officer_id}::uuid AND e.id <> ${src.id}::uuid
          AND e.recorded_at BETWEEN ${from} AND ${to} AND ${visible} ORDER BY abs(extract(epoch FROM e.recorded_at - ${src.recorded_at}::timestamptz)) LIMIT ${PER_REASON}`).then((rows) =>
          rows.forEach((r) => add(r.id, { kind: 'SAME_OFFICER', detail: 'Same officer within ±1 h' })),
        ),
      );
    }
    if (src.device_id) {
      jobs.push(
        run(sql<{ id: string }>`SELECT e.id FROM evidence e WHERE e.device_id = ${src.device_id}::uuid AND e.id <> ${src.id}::uuid
          AND e.recorded_at BETWEEN ${from} AND ${to} AND ${visible} ORDER BY abs(extract(epoch FROM e.recorded_at - ${src.recorded_at}::timestamptz)) LIMIT ${PER_REASON}`).then((rows) =>
          rows.forEach((r) => add(r.id, { kind: 'SAME_DEVICE', detail: 'Same device within ±1 h' })),
        ),
      );
    }
    if (src.gps_latitude !== null && src.gps_longitude !== null) {
      const lat = src.gps_latitude;
      const lon = src.gps_longitude;
      const b = radiusBox(lat, lon, NEARBY_RADIUS_KM);
      jobs.push(
        run(sql<{ id: string; km: number }>`SELECT e.id, ${haversineKm('e', lat, lon)} AS km FROM evidence e
          WHERE e.id <> ${src.id}::uuid AND e.gps_latitude BETWEEN ${b.minLat} AND ${b.maxLat} AND e.gps_longitude BETWEEN ${b.minLon} AND ${b.maxLon}
            AND ${haversineKm('e', lat, lon)} <= ${NEARBY_RADIUS_KM}
            AND e.recorded_at IS NOT NULL AND e.recorded_at <= ${srcEnd} AND ${spanEnd('e')} >= ${src.recorded_at}::timestamptz
            AND ${visible} ORDER BY km LIMIT ${PER_REASON}`).then((rows) =>
          rows.forEach((r) => add(r.id, { kind: 'NEARBY', detail: `${Math.round(Number(r.km) * 1000)} m away, overlapping in time` })),
        ),
      );
    }
  }
  jobs.push(
    run(sql<{ id: string; plate: string }>`SELECT DISTINCT ON (e.id) e.id, ksp_plate_norm(s.attributes->>'plateText') AS plate
      FROM ai_detections s JOIN ai_detections d ON d.attributes ? 'plateText' AND ksp_plate_norm(d.attributes->>'plateText') = ksp_plate_norm(s.attributes->>'plateText')
        AND d.review_status = 'APPROVED' AND d.evidence_id <> s.evidence_id
      JOIN evidence e ON e.id = d.evidence_id
      WHERE s.evidence_id = ${src.id}::uuid AND s.review_status = 'APPROVED' AND s.attributes ? 'plateText' AND ksp_plate_norm(s.attributes->>'plateText') IS NOT NULL
        AND ${visible} LIMIT ${PER_REASON}`).then((rows) => rows.forEach((r) => add(r.id, { kind: 'SHARED_PLATE', detail: `Plate ${r.plate} (approved)` }))),
  );
  jobs.push(
    run(sql<{ id: string; label: string }>`SELECT DISTINCT ON (e.id) e.id, coalesce(we.label, 'watchlist entry') AS label
      FROM ai_detections s JOIN ai_detections d ON d.attributes ? 'watchlistEntryId' AND (d.attributes->>'watchlistEntryId') = (s.attributes->>'watchlistEntryId')
        AND d.review_status = 'APPROVED' AND d.evidence_id <> s.evidence_id
      JOIN evidence e ON e.id = d.evidence_id
      LEFT JOIN ai_watchlist_entries we ON we.id::text = s.attributes->>'watchlistEntryId'
      WHERE s.evidence_id = ${src.id}::uuid AND s.review_status = 'APPROVED' AND s.attributes ? 'watchlistEntryId'
        AND ${visible} LIMIT ${PER_REASON}`).then((rows) => rows.forEach((r) => add(r.id, { kind: 'SHARED_WATCHLIST', detail: `Watchlist hit: ${r.label} (approved)` }))),
  );
  jobs.push(
    run(sql<{ id: string; rel_id: string; relation: string; note: string | null; outgoing: boolean }>`SELECT e.id, r.id AS rel_id, r.relation, r.note, (r.evidence_a = ${src.id}::uuid) AS outgoing
      FROM evidence_relations r JOIN evidence e ON e.id = CASE WHEN r.evidence_a = ${src.id}::uuid THEN r.evidence_b ELSE r.evidence_a END
      WHERE (r.evidence_a = ${src.id}::uuid OR r.evidence_b = ${src.id}::uuid) AND ${visible} LIMIT 200`).then((rows) =>
      rows.forEach((r) =>
        add(r.id, {
          kind: 'RELATION',
          relationId: r.rel_id,
          relation: r.relation,
          detail: r.relation === 'CONTINUATION' ? (r.outgoing ? 'Continues in this item' : 'This item continues from it') : r.relation.replace(/_/g, ' ').toLowerCase(),
        }),
      ),
    ),
  );
  await Promise.all(jobs);
  reasons.delete(src.id);
  const weight: Record<RelatedReason['kind'], number> = { RELATION: 100, SAME_CASE: 50, SHARED_WATCHLIST: 40, SHARED_PLATE: 40, NEARBY: 30, SAME_DEVICE: 20, SAME_OFFICER: 10 };
  const ordered = [...reasons.entries()].map(([id, rs]) => ({ id, rs, score: rs.reduce((s, r) => s + weight[r.kind], 0) })).sort((a, b) => b.score - a.score).slice(0, 100);
  const items = await loadListItems(db, p, ordered.map((o) => o.id));
  const byId = new Map(ordered.map((o) => [o.id, o]));
  return { items: items.map((it) => ({ ...it, reasons: byId.get(it.id)?.rs ?? [], score: byId.get(it.id)?.score ?? 0 })), total: items.length };
}
