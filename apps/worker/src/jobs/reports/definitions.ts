/**
 * Report definitions: columns + an async row generator per report type. Every query is restricted to
 * `scope.paths` (org_path ltree prefixes frozen from the requester's grants when the run was requested;
 * narrowed to a single org unit when the run has an orgUnitId filter). Large row sets are read in keyset
 * pages so memory stays bounded.
 */
import { sql, type RawBuilder } from 'kysely';
import type { Database } from '@ksp/core';
import type { ReportType } from '@ksp/shared';

export type Cell = string | number | boolean | Date | null;
export type Row = Record<string, Cell>;

export interface ReportScope {
  paths: string[];
  from: Date | null;
  to: Date | null;
  actorId: string | null;
  inactiveDays: number;
}

export interface ReportDefinition {
  columns: Array<{ key: string; header: string; width?: number }>;
  rows(db: Database, s: ReportScope): AsyncGenerator<Row>;
}

const PAGE = 2000;

/** `<col> <@ ANY(paths)` — false when the scope is empty. */
export function inScope(col: string, paths: string[]): RawBuilder<boolean> {
  if (!paths.length) return sql<boolean>`false`;
  return sql<boolean>`${sql.raw(col)} <@ ${sql.val(paths)}::ltree[]`;
}
const between = (col: string, s: ReportScope): RawBuilder<boolean> =>
  sql<boolean>`(${s.from}::timestamptz IS NULL OR ${sql.raw(col)} >= ${s.from}::timestamptz) AND (${s.to}::timestamptz IS NULL OR ${sql.raw(col)} < ${s.to}::timestamptz)`;

async function* all<T extends Row>(q: Promise<{ rows: T[] }>): AsyncGenerator<Row> {
  for (const r of (await q).rows) yield r;
}

const ACCESS_ACTIONS = [
  'EVIDENCE_VIEWED', 'EVIDENCE_PLAYED', 'EVIDENCE_DOWNLOADED', 'EVIDENCE_DOWNLOAD_LINK_ISSUED', 'EVIDENCE_SNAPSHOT_CREATED',
  'EVIDENCE_ACCESS_DENIED', 'SHARE_ACCESSED', 'SHARE_DOWNLOADED', 'SHARE_PRINTED', 'SHARE_ACCESS_DENIED', 'EXPORT_DOWNLOADED',
];

export const REPORT_DEFINITIONS: Record<ReportType, ReportDefinition> = {
  EVIDENCE_INVENTORY: {
    columns: [
      { key: 'station_code', header: 'Station code' }, { key: 'station_name', header: 'Station', width: 2 }, { key: 'items', header: 'Items' },
      { key: 'total_bytes', header: 'Total bytes' }, { key: 'active', header: 'Active tier' }, { key: 'archive', header: 'Archive tier' },
      { key: 'long_term', header: 'Long-term tier' }, { key: 'legal_holds', header: 'Legal holds' }, { key: 'quarantined', header: 'Quarantined' },
      { key: 'disposal_pending', header: 'Disposal pending' }, { key: 'disposed', header: 'Disposed' },
    ],
    rows: (db, s) => all(sql<Row>`
      SELECT o.code AS station_code, o.name AS station_name, count(*)::int AS items, coalesce(sum(e.size_bytes), 0)::bigint::text AS total_bytes,
             count(*) FILTER (WHERE e.storage_tier = 'ACTIVE')::int AS active, count(*) FILTER (WHERE e.storage_tier = 'ARCHIVE')::int AS archive,
             count(*) FILTER (WHERE e.storage_tier = 'LONG_TERM')::int AS long_term, count(*) FILTER (WHERE e.legal_hold)::int AS legal_holds,
             count(*) FILTER (WHERE e.status = 'QUARANTINED')::int AS quarantined, count(*) FILTER (WHERE e.status = 'DISPOSAL_PENDING')::int AS disposal_pending,
             count(*) FILTER (WHERE e.status = 'DISPOSED')::int AS disposed
        FROM evidence e JOIN org_units o ON o.id = e.org_unit_id
       WHERE ${inScope('e.org_path', s.paths)} AND ${between('coalesce(e.registered_at, e.created_at)', s)}
       GROUP BY o.code, o.name ORDER BY o.code`.execute(db)),
  },

  UPLOAD_ACTIVITY: {
    columns: [
      { key: 'day', header: 'Day' }, { key: 'station_code', header: 'Station' }, { key: 'uploader', header: 'Uploader', width: 1.5 },
      { key: 'badge', header: 'Badge' }, { key: 'device', header: 'Device' }, { key: 'sessions', header: 'Sessions' },
      { key: 'completed', header: 'Completed' }, { key: 'failed', header: 'Failed' }, { key: 'aborted_expired', header: 'Aborted/expired' },
      { key: 'bytes_received', header: 'Bytes received' }, { key: 'registered', header: 'Registered' }, { key: 'quarantined', header: 'Quarantined' },
      { key: 'quarantine_reasons', header: 'Quarantine/failure reasons', width: 3 },
    ],
    rows: (db, s) => all(sql<Row>`
      SELECT to_char(date_trunc('day', us.created_at), 'YYYY-MM-DD') AS day, o.code AS station_code, u.username AS uploader, u.badge_number AS badge,
             coalesce(d.serial_number, '') AS device, count(*)::int AS sessions,
             count(*) FILTER (WHERE us.status = 'COMPLETED')::int AS completed, count(*) FILTER (WHERE us.status = 'FAILED')::int AS failed,
             count(*) FILTER (WHERE us.status IN ('ABORTED','EXPIRED'))::int AS aborted_expired, coalesce(sum(us.received_bytes), 0)::bigint::text AS bytes_received,
             count(*) FILTER (WHERE e.status IN ('REGISTERED','DISPOSAL_PENDING','DISPOSED'))::int AS registered,
             count(*) FILTER (WHERE e.status = 'QUARANTINED')::int AS quarantined,
             coalesce(string_agg(DISTINCT left(coalesce(CASE WHEN e.status IN ('QUARANTINED','REJECTED') THEN e.status_reason END, us.error), 200), ' | '), '') AS quarantine_reasons
        FROM upload_sessions us
        JOIN org_units o ON o.id = us.org_unit_id
        JOIN users u ON u.id = us.created_by
        LEFT JOIN evidence e ON e.id = us.evidence_id
        LEFT JOIN devices d ON d.id = e.device_id
       WHERE ${inScope('o.path', s.paths)} AND ${between('us.created_at', s)}
       GROUP BY 1, o.code, u.username, u.badge_number, d.serial_number
       ORDER BY 1, o.code, u.username, device`.execute(db)),
  },

  CHAIN_OF_CUSTODY_SUMMARY: {
    columns: [
      { key: 'evidence_number', header: 'Evidence no.' }, { key: 'title', header: 'Title', width: 2 }, { key: 'station_code', header: 'Station' },
      { key: 'views', header: 'Views' }, { key: 'plays', header: 'Plays' }, { key: 'downloads', header: 'Downloads' }, { key: 'exports', header: 'Export events' },
      { key: 'shares', header: 'Share events' }, { key: 'denied', header: 'Denied' }, { key: 'custody_events', header: 'Custody events' },
      { key: 'distinct_actors', header: 'Distinct actors' }, { key: 'last_event_at', header: 'Last event', width: 1.5 },
    ],
    async *rows(db, s) {
      let after = '';
      for (;;) {
        const { rows } = await sql<Row & { id: string }>`
          SELECT e.id, e.evidence_number, coalesce(e.title, e.original_filename) AS title, o.code AS station_code,
                 count(*) FILTER (WHERE a.action = 'EVIDENCE_VIEWED')::int AS views,
                 count(*) FILTER (WHERE a.action = 'EVIDENCE_PLAYED')::int AS plays,
                 count(*) FILTER (WHERE a.action IN ('EVIDENCE_DOWNLOADED','SHARE_DOWNLOADED'))::int AS downloads,
                 count(*) FILTER (WHERE a.action LIKE 'EXPORT\\_%')::int AS exports,
                 count(*) FILTER (WHERE a.action LIKE 'SHARE\\_%')::int AS shares,
                 count(*) FILTER (WHERE a.outcome = 'DENIED')::int AS denied,
                 count(*)::int AS custody_events, count(DISTINCT a.actor_id)::int AS distinct_actors, max(a.occurred_at) AS last_event_at
            FROM audit_events a JOIN evidence e ON e.id = a.evidence_id JOIN org_units o ON o.id = e.org_unit_id
           WHERE a.evidence_id IS NOT NULL AND ${inScope('e.org_path', s.paths)} AND ${between('a.occurred_at', s)}
             AND e.id::text > ${after}
           GROUP BY e.id, e.evidence_number, e.title, e.original_filename, o.code
           ORDER BY e.id::text LIMIT ${PAGE}`.execute(db);
        for (const { id, ...r } of rows) yield r;
        if (rows.length < PAGE) return;
        after = String(rows[rows.length - 1]!.id);
      }
    },
  },

  ACCESS_AUDIT: {
    columns: [
      { key: 'seq', header: 'Ledger seq' }, { key: 'occurred_at', header: 'Time', width: 1.5 }, { key: 'actor_type', header: 'Actor type' },
      { key: 'actor_name', header: 'Actor', width: 1.5 }, { key: 'action', header: 'Action', width: 1.8 }, { key: 'outcome', header: 'Outcome' },
      { key: 'evidence_number', header: 'Evidence no.' }, { key: 'station_code', header: 'Station' }, { key: 'ip', header: 'IP' },
    ],
    async *rows(db, s) {
      let after = 0;
      for (;;) {
        const { rows } = await sql<Row & { seq: string }>`
          SELECT a.seq::text AS seq, a.occurred_at, a.actor_type, coalesce(a.actor_name, a.actor_id) AS actor_name, a.action, a.outcome,
                 e.evidence_number, o.code AS station_code, host(a.actor_ip) AS ip
            FROM audit_events a JOIN evidence e ON e.id = a.evidence_id JOIN org_units o ON o.id = e.org_unit_id
           WHERE a.evidence_id IS NOT NULL AND a.action = ANY(${sql.val(ACCESS_ACTIONS)}::text[])
             AND ${inScope('e.org_path', s.paths)} AND ${between('a.occurred_at', s)}
             AND (${s.actorId}::text IS NULL OR a.actor_id = ${s.actorId}::text)
             AND a.seq > ${after}
           ORDER BY a.seq LIMIT ${PAGE}`.execute(db);
        for (const r of rows) yield r;
        if (rows.length < PAGE) return;
        after = Number(rows[rows.length - 1]!.seq);
      }
    },
  },

  RETENTION_COMPLIANCE: {
    columns: [
      { key: 'category', header: 'Category', width: 1.5 }, { key: 'evidence_number', header: 'Evidence no.' }, { key: 'station_code', header: 'Station' },
      { key: 'status', header: 'Status' }, { key: 'retain_until', header: 'Retain until', width: 1.5 }, { key: 'legal_hold', header: 'Legal hold' },
      { key: 'disposal_status', header: 'Disposal' }, { key: 'requested_at', header: 'Requested', width: 1.5 }, { key: 'decided_at', header: 'Decided', width: 1.5 },
      { key: 'executed_at', header: 'Executed', width: 1.5 }, { key: 'note', header: 'Note', width: 2 },
    ],
    rows: (db, s) => all(sql<Row>`
      WITH scoped AS (SELECT e.*, o.code AS station_code FROM evidence e JOIN org_units o ON o.id = e.org_unit_id WHERE ${inScope('e.org_path', s.paths)}),
      last_dr AS (SELECT DISTINCT ON (dr.evidence_id) dr.* FROM disposal_requests dr JOIN scoped ON scoped.id = dr.evidence_id ORDER BY dr.evidence_id, dr.created_at DESC)
      SELECT * FROM (
        SELECT 'OVERDUE_RETENTION' AS category, sc.evidence_number, sc.station_code, sc.status, sc.retain_until, sc.legal_hold,
               dr.status AS disposal_status, dr.created_at AS requested_at, dr.decided_at, dr.executed_at,
               CASE WHEN sc.legal_hold THEN 'on legal hold — disposal blocked' WHEN dr.id IS NULL THEN 'no disposal requested' ELSE '' END AS note
          FROM scoped sc LEFT JOIN last_dr dr ON dr.evidence_id = sc.id
         WHERE sc.status = 'REGISTERED' AND sc.retain_until IS NOT NULL AND sc.retain_until < now()
        UNION ALL
        SELECT 'LEGAL_HOLD', sc.evidence_number, sc.station_code, sc.status, sc.retain_until, true, dr.status, dr.created_at, dr.decided_at, dr.executed_at,
               left(coalesce(sc.legal_hold_reason, ''), 200)
          FROM scoped sc LEFT JOIN last_dr dr ON dr.evidence_id = sc.id WHERE sc.legal_hold
        UNION ALL
        SELECT 'DISPOSAL_' || dr.status, sc.evidence_number, sc.station_code, sc.status, sc.retain_until, sc.legal_hold, dr.status, dr.created_at, dr.decided_at, dr.executed_at,
               left(coalesce(dr.execution_error, dr.decision_note, ''), 200)
          FROM disposal_requests dr JOIN scoped sc ON sc.id = dr.evidence_id
         WHERE (dr.status IN ('PENDING','APPROVED')) OR (${between('coalesce(dr.executed_at, dr.decided_at, dr.created_at)', s)})
      ) x ORDER BY category, evidence_number`.execute(db)),
  },

  AI_REVIEW: {
    columns: [
      { key: 'section', header: 'Section' }, { key: 'task', header: 'Task' }, { key: 'model', header: 'Model / reviewer', width: 1.5 },
      { key: 'version', header: 'Version' }, { key: 'detections', header: 'Detections' }, { key: 'pending', header: 'Pending' },
      { key: 'approved', header: 'Approved' }, { key: 'rejected', header: 'Rejected' }, { key: 'second_review', header: 'Needs 2nd review' },
      { key: 'reviews', header: 'Review actions' }, { key: 'approval_rate', header: 'Approval rate %' },
    ],
    async *rows(db, s) {
      const models = await sql<Row>`
        SELECT 'MODEL' AS section, d.task, d.model_code AS model, d.model_version AS version, count(*)::int AS detections,
               count(*) FILTER (WHERE d.review_status = 'PENDING')::int AS pending, count(*) FILTER (WHERE d.review_status = 'APPROVED')::int AS approved,
               count(*) FILTER (WHERE d.review_status = 'REJECTED')::int AS rejected, count(*) FILTER (WHERE d.review_status = 'NEEDS_SECOND_REVIEW')::int AS second_review,
               NULL::int AS reviews,
               round(100.0 * count(*) FILTER (WHERE d.review_status = 'APPROVED') / nullif(count(*) FILTER (WHERE d.review_status IN ('APPROVED','REJECTED')), 0), 1)::float8 AS approval_rate
          FROM ai_detections d JOIN evidence e ON e.id = d.evidence_id
         WHERE ${inScope('e.org_path', s.paths)} AND ${between('d.created_at', s)}
         GROUP BY d.task, d.model_code, d.model_version ORDER BY d.task, d.model_code, d.model_version`.execute(db);
      for (const r of models.rows) yield r;
      const reviewers = await sql<Row>`
        SELECT 'REVIEWER' AS section, '' AS task, u.username AS model, '' AS version, count(DISTINCT r.detection_id)::int AS detections,
               NULL::int AS pending, count(*) FILTER (WHERE r.new_status = 'APPROVED')::int AS approved, count(*) FILTER (WHERE r.new_status = 'REJECTED')::int AS rejected,
               count(*) FILTER (WHERE r.new_status = 'NEEDS_SECOND_REVIEW')::int AS second_review, count(*)::int AS reviews,
               round(100.0 * count(*) FILTER (WHERE r.new_status = 'APPROVED') / nullif(count(*) FILTER (WHERE r.new_status IN ('APPROVED','REJECTED')), 0), 1)::float8 AS approval_rate
          FROM ai_review_events r JOIN ai_detections d ON d.id = r.detection_id JOIN evidence e ON e.id = d.evidence_id JOIN users u ON u.id = r.reviewer_id
         WHERE ${inScope('e.org_path', s.paths)} AND ${between('r.created_at', s)}
         GROUP BY u.username ORDER BY u.username`.execute(db);
      for (const r of reviewers.rows) yield r;
    },
  },

  INTEGRITY: {
    columns: [
      { key: 'checked_at', header: 'Checked at', width: 1.5 }, { key: 'evidence_number', header: 'Evidence no.' }, { key: 'station_code', header: 'Station' },
      { key: 'trigger', header: 'Trigger' }, { key: 'ok', header: 'Result' }, { key: 'expected_sha256', header: 'Expected SHA-256', width: 3 },
      { key: 'actual_sha256', header: 'Actual SHA-256', width: 3 }, { key: 'error', header: 'Error', width: 2 },
    ],
    async *rows(db, s) {
      let after = 0;
      for (;;) {
        const { rows } = await sql<Row & { id: string }>`
          SELECT ic.id::text AS id, ic.checked_at, e.evidence_number, o.code AS station_code, ic.trigger, CASE WHEN ic.ok THEN 'OK' ELSE 'FAILED' END AS ok,
                 ic.expected_sha256, ic.actual_sha256, left(coalesce(ic.error, ''), 300) AS error
            FROM integrity_checks ic JOIN evidence e ON e.id = ic.evidence_id JOIN org_units o ON o.id = e.org_unit_id
           WHERE ${inScope('e.org_path', s.paths)} AND ${between('ic.checked_at', s)} AND ic.id > ${after}
           ORDER BY ic.id LIMIT ${PAGE}`.execute(db);
        for (const { id, ...r } of rows) yield r;
        if (rows.length < PAGE) return;
        after = Number(rows[rows.length - 1]!.id);
      }
    },
  },

  USER_ACCESS_REVIEW: {
    columns: [
      { key: 'username', header: 'Username' }, { key: 'full_name', header: 'Name', width: 1.5 }, { key: 'badge', header: 'Badge' },
      { key: 'home_unit', header: 'Home unit' }, { key: 'status', header: 'Status' }, { key: 'roles', header: 'Role grants', width: 3 },
      { key: 'last_login_at', header: 'Last login', width: 1.5 }, { key: 'days_since_login', header: 'Days since login' },
      { key: 'mfa_enabled', header: 'MFA' }, { key: 'password_changed_at', header: 'Password changed', width: 1.5 },
      { key: 'created_at', header: 'Created', width: 1.5 }, { key: 'flags', header: 'Review flags', width: 2 },
    ],
    rows: (db, s) => all(sql<Row>`
      SELECT u.username, u.full_name, u.badge_number AS badge, o.code AS home_unit, u.status,
             coalesce((SELECT string_agg(r.code || '@' || g.code || CASE WHEN ur.expires_at IS NOT NULL THEN ' (until ' || to_char(ur.expires_at, 'YYYY-MM-DD') || ')' ELSE '' END, '; ' ORDER BY r.code, g.code)
                         FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN org_units g ON g.id = ur.org_unit_id
                        WHERE ur.user_id = u.id AND (ur.expires_at IS NULL OR ur.expires_at > now())), '') AS roles,
             u.last_login_at, CASE WHEN u.last_login_at IS NULL THEN NULL ELSE floor(extract(epoch FROM now() - u.last_login_at) / 86400)::int END AS days_since_login,
             u.mfa_enabled, u.password_changed_at, u.created_at,
             concat_ws(', ',
               CASE WHEN u.status = 'ACTIVE' AND (u.last_login_at IS NULL AND u.created_at < now() - make_interval(days => ${s.inactiveDays})) THEN 'NEVER_LOGGED_IN' END,
               CASE WHEN u.status = 'ACTIVE' AND u.last_login_at < now() - make_interval(days => ${s.inactiveDays}) THEN 'INACTIVE_' || ${s.inactiveDays} || 'D' END,
               CASE WHEN u.status = 'ACTIVE' AND NOT u.mfa_enabled THEN 'NO_MFA' END,
               CASE WHEN u.status <> 'ACTIVE' AND EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id) THEN 'DISABLED_WITH_GRANTS' END) AS flags
        FROM users u JOIN org_units o ON o.id = u.home_org_unit_id
       WHERE ${inScope('o.path', s.paths)}
       ORDER BY o.code, u.username`.execute(db)),
  },

  EXPORT_SHARE_ACTIVITY: {
    columns: [
      { key: 'kind', header: 'Kind' }, { key: 'reference', header: 'Reference', width: 1.5 }, { key: 'created_at', header: 'Created', width: 1.5 },
      { key: 'station_code', header: 'Unit' }, { key: 'created_by', header: 'Created by' }, { key: 'purpose', header: 'Purpose', width: 2 },
      { key: 'recipient', header: 'Recipient', width: 1.5 }, { key: 'status', header: 'Status' }, { key: 'approved_by', header: 'Approved by' },
      { key: 'items', header: 'Items' }, { key: 'views', header: 'Views' }, { key: 'downloads', header: 'Downloads' }, { key: 'expires_at', header: 'Expires', width: 1.5 },
    ],
    rows: (db, s) => all(sql<Row>`
      SELECT * FROM (
        SELECT 'EXPORT' AS kind, x.export_number AS reference, x.created_at, o.code AS station_code, cu.username AS created_by, left(x.purpose, 200) AS purpose,
               coalesce(x.recipient, x.court_name, '') AS recipient, x.status, au.username AS approved_by,
               (SELECT count(*)::int FROM export_items i WHERE i.export_id = x.id) AS items, NULL::int AS views, x.download_count AS downloads, x.expires_at
          FROM exports x JOIN org_units o ON o.id = x.org_unit_id JOIN users cu ON cu.id = x.created_by LEFT JOIN users au ON au.id = x.approved_by
         WHERE ${inScope('o.path', s.paths)} AND ${between('x.created_at', s)}
        UNION ALL
        SELECT 'SHARE', sh.id::text, sh.created_at, o.code, cu.username, left(sh.purpose, 200),
               CASE WHEN sh.recipient_type = 'INTERNAL_USER' THEN coalesce(ru.username, '') ELSE concat_ws(' / ', sh.recipient_name, sh.recipient_org) END,
               sh.status, NULL, (SELECT count(*)::int FROM share_items i WHERE i.share_id = sh.id), sh.view_count, sh.download_count, sh.expires_at
          FROM shares sh JOIN org_units o ON o.id = sh.org_unit_id JOIN users cu ON cu.id = sh.created_by LEFT JOIN users ru ON ru.id = sh.recipient_user_id
         WHERE ${inScope('o.path', s.paths)} AND ${between('sh.created_at', s)}
      ) x ORDER BY created_at, kind`.execute(db)),
  },
};
