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

// ---- scheduled reports ----------------------------------------------------------------------------
export const REPORT_FREQUENCIES = ['DAILY', 'WEEKLY', 'MONTHLY', 'CRON'] as const;
export type ReportFrequency = (typeof REPORT_FREQUENCIES)[number];

export interface ReportScheduleTiming {
  frequency: ReportFrequency;
  /** Local time of day (schedule timezone) for DAILY / WEEKLY / MONTHLY. */
  hour?: number;
  minute?: number;
  /** 0 = Sunday … 6 = Saturday (WEEKLY). */
  dayOfWeek?: number;
  /** 1 … 28 (MONTHLY; capped at 28 so every month has the day). */
  dayOfMonth?: number;
  /** 5-field cron expression (CRON). */
  cron?: string;
}

/** Effective 5-field cron expression for a schedule's timing. */
export function scheduleCron(t: ReportScheduleTiming): string {
  const m = t.minute ?? 0;
  const h = t.hour ?? 6;
  switch (t.frequency) {
    case 'DAILY': return `${m} ${h} * * *`;
    case 'WEEKLY': return `${m} ${h} * * ${t.dayOfWeek ?? 1}`;
    case 'MONTHLY': return `${m} ${h} ${t.dayOfMonth ?? 1} * *`;
    default: return (t.cron ?? '').trim().replace(/\s+/g, ' ');
  }
}

/** Default look-back period (days) of a frequency: the report covers [slot - lookback, slot). */
export const DEFAULT_LOOKBACK_DAYS: Record<ReportFrequency, number> = { DAILY: 1, WEEKLY: 7, MONTHLY: 31, CRON: 1 };

// ---- jurisdiction from grants (shared by the API and the scheduled-report cron) --------------------
export interface ScopeGrant {
  orgPath: string;
  permissions: ReadonlySet<string> | readonly string[];
}

export function pathCoversPath(ancestor: string, path: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}.`);
}

function minimalPaths(paths: string[]): string[] {
  const sorted = [...new Set(paths)].sort((a, b) => a.length - b.length);
  const out: string[] = [];
  for (const x of sorted) if (!out.some((o) => pathCoversPath(o, x))) out.push(x);
  return out;
}

const hasPerm = (g: ScopeGrant, perm: string) => (Array.isArray(g.permissions) ? (g.permissions as readonly string[]).includes(perm) : (g.permissions as ReadonlySet<string>).has(perm));

/** Minimal set of org paths where the grants hold ALL of `perms` (intersection of grant scopes). */
export function intersectGrantScopes(grants: readonly ScopeGrant[], perms: readonly string[]): string[] {
  const scope = (perm: string) => minimalPaths(grants.filter((g) => hasPerm(g, perm)).map((g) => g.orgPath));
  let acc = scope(perms[0]!);
  for (const perm of perms.slice(1)) {
    const other = scope(perm);
    const next = new Set<string>();
    for (const a of acc) for (const b of other) {
      if (pathCoversPath(a, b)) next.add(b);
      else if (pathCoversPath(b, a)) next.add(a);
    }
    acc = [...next];
  }
  return minimalPaths(acc);
}

export function reportScopeFromGrants(grants: readonly ScopeGrant[], type: ReportType): string[] {
  return intersectGrantScopes(grants, ['reports:generate', ...(REPORT_TYPES[type].requires as readonly string[])]);
}

/** True when every path of `inner` lies inside some path of `outer`. */
export function scopeCovered(inner: readonly string[], outer: readonly string[]): boolean {
  return inner.every((i) => outer.some((o) => pathCoversPath(o, i)));
}
