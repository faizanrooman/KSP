export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PersonRef {
  id: string;
  fullName: string | null;
  badgeNumber: string | null;
}

export interface FirRef {
  id: string;
  firNumber: string;
  firYear: number;
  displayNumber: string;
}

export interface CaseListItem {
  id: string;
  caseNumber: string;
  title: string;
  status: string;
  priority: string;
  orgUnit: { id: string; name: string; code: string };
  fir: FirRef | null;
  investigatingOfficer: PersonRef | null;
  supervisor: PersonRef | null;
  evidenceCount: number;
  openedAt: string;
  closedAt: string | null;
  updatedAt: string;
}

export interface CaseMember {
  id: string;
  fullName: string;
  username: string;
  badgeNumber: string | null;
  userStatus: string;
  orgUnitName: string;
  role: string;
  addedAt: string;
  addedByName: string | null;
}

export interface CaseDetail extends Omit<CaseListItem, 'fir'> {
  description: string | null;
  orgUnitId: string;
  fir: (FirRef & { status: string; actsSections: string[]; registeredAt: string; source: string }) | null;
  members: CaseMember[];
  court: { name: string | null; caseNumber: string | null };
  external: { system: string | null; ref: string | null };
  hiddenEvidenceCount: number;
  createdBy: { id: string; fullName: string } | null;
  createdAt: string;
  permissions: { canManage: boolean; canLinkEvidence: boolean; canAddNote: boolean; onTeam: boolean };
  allowedTransitions: string[];
}

export interface CaseEvidenceItem {
  linkId: string;
  linkedAt: string;
  linkedByName: string;
  note: string | null;
  unlinkedAt: string | null;
  unlinkedByName: string | null;
  unlinkReason: string | null;
  evidence: {
    id: string;
    evidenceNumber: string | null;
    title: string | null;
    status: string;
    mediaStatus: string;
    recordedAt: string | null;
    durationMs: number | null;
    sha256: string | null;
    legalHold: boolean;
    orgUnitName: string;
    officer: { fullName: string; badgeNumber: string | null } | null;
    thumbnailUrl: string | null;
  };
}

export interface CaseNote {
  id: string;
  body: string;
  createdAt: string;
  author: { id: string; fullName: string; badgeNumber?: string | null };
}

export interface TimelineItem {
  at: string;
  type: string;
  category: 'CASE' | 'STATUS' | 'EVIDENCE' | 'DIARY';
  actor: { type: string; name: string | null };
  outcome: string;
  summary: string;
  evidenceId: string | null;
}

export interface Fir {
  id: string;
  firNumber: string;
  firYear: number;
  displayNumber: string;
  orgUnit: { id: string; name: string; code: string };
  registeredAt: string;
  actsSections: string[];
  complainant: string | null;
  briefFacts: string | null;
  placeOfOccurrence: string | null;
  occurredFrom: string | null;
  occurredTo: string | null;
  status: string;
  source: string;
  externalRef: string | null;
  createdAt: string;
  updatedAt: string;
  caseCount?: number;
}

export interface FirDetail extends Fir {
  cases: Array<{ id: string; caseNumber: string; title: string; status: string; priority: string }>;
  permissions: { canManage: boolean };
  allowedTransitions: string[];
}

export interface IntegrationSystem {
  id: string;
  code: string;
  name: string;
  systemType: string;
  adapter: string;
  baseUrl: string | null;
  config: { authType: string; timeoutMs: number; retries: number; stationCodeMap: Record<string, string>; fixtureMode: string } | null;
  credentialsRef: string | null;
  credentialsPresent: boolean;
  enabled: boolean;
  verified: boolean;
  verifiedAt: string | null;
  verificationStatus: 'VERIFIED' | 'UNVERIFIED' | 'FIXTURE';
  lastSyncAt: string | null;
  lastStatus: string | null;
}

export interface SyncLogItem {
  id: number;
  direction: string;
  operation: string;
  status: string;
  requestRef: string | null;
  summary: Record<string, unknown>;
  error: string | null;
  createdAt: string;
  createdByName: string | null;
}

export interface ApiClient {
  id: string;
  name: string;
  description: string | null;
  clientId: string;
  scopes: string[];
  orgUnit: { id: string; name: string };
  allowedIps: string[];
  rateLimitPerMinute: number;
  status: 'ACTIVE' | 'EXPIRED' | 'REVOKED';
  createdAt: string;
  createdByName: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  lastUsedAt: string | null;
  secretRotatedAt: string | null;
}

export const ACTIVE_CASE_STATUSES = ['OPEN', 'UNDER_INVESTIGATION', 'PENDING_TRIAL', 'IN_TRIAL'];
export const caseKey = (id: string) => ['cases', 'detail', id] as const;
