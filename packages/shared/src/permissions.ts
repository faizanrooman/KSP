/**
 * Permission catalogue — the single source of truth for RBAC.
 * Roles (DB table `roles`) hold arrays of these codes; a role is granted to a user AT an org unit and
 * applies to that unit's subtree (jurisdiction-based access). See docs/AUTHORIZATION.md.
 */
export const PERMISSIONS = {
  // Administration
  'users:read': 'View user accounts',
  'users:manage': 'Create, edit, lock, disable users and reset credentials',
  'roles:read': 'View roles and permissions',
  'roles:manage': 'Create and edit roles; grant/revoke role assignments',
  'org:read': 'View organisation hierarchy (zones, districts, stations)',
  'org:manage': 'Create and edit organisation units',
  'devices:read': 'View body-worn cameras and other capture devices',
  'devices:manage': 'Register, assign and retire devices',
  'settings:manage': 'Change system settings (password policy, session limits, thresholds)',
  'integrations:manage': 'Configure external integrations and API clients',
  // Evidence
  'evidence:upload': 'Upload video evidence (individual and bulk)',
  'evidence:read': 'View evidence records within jurisdiction',
  'evidence:read_own': 'View only evidence the user uploaded or recorded',
  'evidence:play': 'Play/stream evidence media and view derived frames',
  'evidence:download_original': 'Download the original evidence file',
  'evidence:edit_metadata': 'Edit descriptive metadata (title, description, category, tags)',
  'evidence:legal_hold': 'Place or release legal holds',
  'evidence:verify': 'Run on-demand integrity (hash) verification',
  'evidence:snapshot': 'Create frame snapshots',
  'evidence:dispose_request': 'Request authorised disposal of evidence',
  'evidence:dispose_approve': 'Approve or reject disposal requests (cannot approve own request)',
  'evidence:quarantine_manage': 'Release or reject quarantined uploads',
  'retention:manage': 'Configure retention policies and storage tiers',
  // AI
  'ai:request': 'Run on-demand AI analysis on evidence',
  'ai:review': 'Review, approve or reject AI-generated results',
  'ai:models_manage': 'Register, activate and retire AI model versions; export training datasets',
  'ai:watchlist_manage': 'Manage face/vehicle watchlists',
  // Search & investigation
  'search:use': 'Search evidence (results limited to jurisdiction/permissions)',
  'workspace:use': 'Use investigation workspaces, bookmarks, annotations and timelines',
  // Cases
  'cases:read': 'View cases and FIRs within jurisdiction',
  'cases:manage': 'Create and edit cases and FIRs',
  'cases:link_evidence': 'Link and unlink evidence to/from cases',
  // Custody & audit
  'custody:read': 'View chain of custody for evidence',
  'audit:read': 'View system-wide audit logs',
  'audit:export': 'Export audit logs',
  'audit:verify': 'Verify the audit ledger hash chain',
  // Export & sharing
  'export:create': 'Request court evidence exports',
  'export:approve': 'Approve or reject court exports (cannot approve own request)',
  'export:download': 'Download completed court exports',
  'share:create': 'Share evidence with authorised internal/external recipients',
  'share:manage_all': 'View and revoke all shares within jurisdiction',
  // Operations
  'dashboard:view': 'View operational dashboards',
  'reports:generate': 'Generate evidence and compliance reports',
  'alerts:read': 'View alerts',
  'alerts:manage': 'Acknowledge/resolve alerts and configure alert rules',
  'system:monitor': 'View system health, metrics and processing queues',
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

/**
 * Administrative, approval and oversight rights. With sessionPolicy.mfaForPrivilegedPermissions (default true, always
 * true in production) any role holding one of them requires MFA — whatever the role is called (custom roles included).
 * The default roles holding them are System Administrator, Supervisor, Evidence Custodian and Compliance Auditor.
 */
export const MFA_REQUIRED_PERMISSIONS: readonly Permission[] = [
  'users:manage', 'roles:manage', 'org:manage', 'devices:manage', 'settings:manage', 'integrations:manage', 'retention:manage',
  'ai:models_manage', 'evidence:legal_hold', 'evidence:dispose_request', 'evidence:dispose_approve', 'evidence:quarantine_manage',
  'evidence:download_original', 'export:approve', 'share:manage_all', 'alerts:manage', 'audit:read', 'audit:export', 'audit:verify',
];

export function isPermission(value: string): value is Permission {
  return Object.prototype.hasOwnProperty.call(PERMISSIONS, value);
}

/**
 * Separation-of-duties constraints enforced when roles are edited or assigned: no single role may hold
 * both sides of a conflicting pair, and (in addition) runtime checks stop the same user approving their
 * own disposal/export request.
 */
export const SOD_CONFLICTS: ReadonlyArray<readonly [Permission, Permission, string]> = [
  ['evidence:dispose_request', 'evidence:dispose_approve', 'Requesting and approving disposal must be separate roles'],
  ['audit:read', 'roles:manage', 'Audit reviewers must not administer roles (and so their own access)'],
];

export function sodViolations(perms: readonly string[]): string[] {
  const set = new Set(perms);
  return SOD_CONFLICTS.filter(([a, b]) => set.has(a) && set.has(b)).map(([, , msg]) => msg);
}

export interface DefaultRole {
  code: string;
  name: string;
  description: string;
  permissions: Permission[];
}

/** Seeded system roles (spec: Field Officers, IOs, Supervisors, Forensic Analysts, System Administrators). */
export const DEFAULT_ROLES: DefaultRole[] = [
  {
    code: 'FIELD_OFFICER',
    name: 'Field Officer',
    description: 'Captures and uploads body-worn camera footage; sees own evidence.',
    permissions: ['evidence:upload', 'evidence:read_own', 'evidence:play', 'devices:read', 'dashboard:view'],
  },
  {
    code: 'STATION_OPERATOR',
    name: 'Station Upload Operator',
    description: 'Operates the police-station upload client for bulk ingestion.',
    permissions: ['evidence:upload', 'evidence:read', 'devices:read', 'users:read', 'dashboard:view', 'org:read'],
  },
  {
    code: 'INVESTIGATING_OFFICER',
    name: 'Investigating Officer',
    description: 'Investigates cases: searches, analyses, annotates, links evidence and requests exports.',
    permissions: [
      'evidence:upload', 'evidence:read', 'evidence:play', 'evidence:edit_metadata', 'evidence:snapshot',
      'evidence:verify', 'ai:request', 'search:use', 'workspace:use', 'cases:read', 'cases:manage',
      'cases:link_evidence', 'custody:read', 'export:create', 'export:download', 'share:create',
      'dashboard:view', 'devices:read', 'users:read', 'org:read', 'alerts:read',
    ],
  },
  {
    code: 'SUPERVISOR',
    name: 'Supervisor',
    description: 'Supervises investigations; approves exports and disposals; places legal holds.',
    permissions: [
      'evidence:read', 'evidence:play', 'evidence:edit_metadata', 'evidence:legal_hold', 'evidence:verify',
      'evidence:dispose_approve', 'evidence:quarantine_manage', 'evidence:download_original', 'evidence:snapshot',
      'ai:request', 'ai:review', 'search:use', 'workspace:use', 'cases:read', 'cases:manage',
      'cases:link_evidence', 'custody:read', 'export:approve', 'export:download', 'share:create',
      'share:manage_all', 'dashboard:view', 'reports:generate', 'alerts:read', 'alerts:manage',
      'devices:read', 'users:read', 'org:read',
    ],
  },
  {
    code: 'FORENSIC_ANALYST',
    name: 'Forensic Analyst',
    description: 'Performs AI-assisted analysis and human review of AI results.',
    permissions: [
      'evidence:read', 'evidence:play', 'evidence:snapshot', 'evidence:verify', 'ai:request', 'ai:review',
      'ai:watchlist_manage', 'search:use', 'workspace:use', 'cases:read', 'custody:read', 'dashboard:view',
      'org:read',
    ],
  },
  {
    code: 'EVIDENCE_CUSTODIAN',
    name: 'Evidence Custodian',
    description: 'Manages retention and initiates authorised disposal; does not approve it.',
    permissions: [
      'evidence:read', 'evidence:verify', 'evidence:dispose_request', 'evidence:legal_hold', 'retention:manage',
      'custody:read', 'dashboard:view', 'reports:generate', 'org:read',
    ],
  },
  {
    code: 'SYSTEM_ADMINISTRATOR',
    name: 'System Administrator',
    description: 'Administers users, roles, stations, devices, settings and integrations. No evidence media access by default.',
    permissions: [
      'users:read', 'users:manage', 'roles:read', 'roles:manage', 'org:read', 'org:manage', 'devices:read',
      'devices:manage', 'settings:manage', 'integrations:manage', 'retention:manage', 'ai:models_manage',
      'dashboard:view', 'alerts:read', 'alerts:manage', 'system:monitor', 'reports:generate',
    ],
  },
  {
    code: 'AUDITOR',
    name: 'Compliance Auditor',
    description: 'Read-only oversight of audit trail and chain of custody.',
    permissions: ['audit:read', 'audit:export', 'audit:verify', 'custody:read', 'evidence:read', 'reports:generate', 'dashboard:view', 'org:read', 'users:read'],
  },
];
