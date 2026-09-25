/**
 * Report catalogue (spec module 17: configurable evidence & compliance reports). Every report requires
 * reports:generate; some additionally require the permission that would let the requester see the same
 * data interactively. Data is limited to org units where the requester holds ALL required permissions.
 */
import type { Permission } from './permissions.js';

export const REPORT_FORMATS = ['CSV', 'PDF', 'JSON'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export interface ReportTypeInfo {
  title: string;
  description: string;
  /** Permissions required in addition to reports:generate. */
  requires: Permission[];
  /** Optional parameters this report understands beyond from/to/orgUnitId. */
  extraParams?: Array<'actorId' | 'inactiveDays'>;
}

export const REPORT_TYPES = {
  EVIDENCE_INVENTORY: {
    title: 'Evidence inventory',
    description: 'Per station: items, bytes, storage tiers, legal holds, quarantine and disposal state (items registered in the period).',
    requires: ['evidence:read'],
  },
  UPLOAD_ACTIVITY: {
    title: 'Upload activity',
    description: 'Per day, uploader, device and station: sessions, completions, failures, bytes and quarantine reasons.',
    requires: ['evidence:read'],
  },
  CHAIN_OF_CUSTODY_SUMMARY: {
    title: 'Chain of custody summary',
    description: 'Per evidence item: views, plays, downloads, exports, shares and denials recorded in the audit ledger in the period.',
    requires: ['custody:read'],
  },
  ACCESS_AUDIT: {
    title: 'Access audit',
    description: 'Every evidence access event (who accessed what, when, from where) in the period — for compliance review.',
    requires: ['audit:read'],
    extraParams: ['actorId'],
  },
  RETENTION_COMPLIANCE: {
    title: 'Retention compliance',
    description: 'Items past their retention date, legal holds, and disposals pending/approved/executed.',
    requires: ['evidence:read'],
  },
  AI_REVIEW: {
    title: 'AI review',
    description: 'Detections by task and model version with review outcomes, and reviewer throughput in the period.',
    requires: ['evidence:read'],
  },
  INTEGRITY: {
    title: 'Integrity (fixity) checks',
    description: 'Every hash verification in the period with its result.',
    requires: ['evidence:read'],
  },
  USER_ACCESS_REVIEW: {
    title: 'User access review',
    description: 'Users, role grants, last login, MFA status and inactive accounts — for periodic access recertification.',
    requires: ['users:read'],
    extraParams: ['inactiveDays'],
  },
  EXPORT_SHARE_ACTIVITY: {
    title: 'Export & share activity',
    description: 'Court exports and secure shares created in the period with approvals, recipients and download counts.',
    requires: ['evidence:read'],
  },
} as const satisfies Record<string, ReportTypeInfo>;

export type ReportType = keyof typeof REPORT_TYPES;
export const REPORT_TYPE_CODES = Object.keys(REPORT_TYPES) as ReportType[];

/** Parameters stored on report_runs.params. `scopePaths` is frozen from the requester's grants at request time. */
export interface ReportParams {
  from?: string | null;
  to?: string | null;
  orgUnitId?: string | null;
  actorId?: string | null;
  inactiveDays?: number | null;
  scopePaths: string[];
  requestedBy: { id: string; name: string; username: string };
}
