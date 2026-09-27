/** Response shapes of /api/v1/evidence (list, detail, lifecycle). Other modules may import EvidenceDetail. */
import type { Permission } from '@ksp/shared';
import type { EvidenceSummary } from '@/lib/extensions';

export interface Ref {
  id: string;
  fullName: string;
}

export interface EvidenceListItem {
  id: string;
  evidenceNumber: string | null;
  status: string;
  statusReason: string | null;
  mediaStatus: string;
  title: string | null;
  category: string | null;
  orgUnit: { id: string; name: string; code: string };
  officer: { id: string; fullName: string; badgeNumber: string | null } | null;
  device: { id: string; serialNumber: string } | null;
  uploadedBy: Ref;
  recordedAt: string | null;
  durationMs: number | null;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  storageTier: string;
  legalHold: boolean;
  tags: string[];
  thumbnailUrl: string | null;
  createdAt: string;
  registeredAt: string | null;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

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

/** GET /evidence/:id — a superset of EvidenceSummary. Never contains storage locations. */
export interface EvidenceDetail extends EvidenceSummary {
  statusReason: string | null;
  mediaError: string | null;
  orgUnit: { id: string; name: string; code: string };
  description: string | null;
  category: string | null;
  incidentAt: string | null;
  locationText: string | null;
  originalFilename: string;
  mimeType: string | null;
  sizeBytes: number;
  sha512: string | null;
  storageTier: string;
  objectLockUntil: string | null;
  recordedEndAt: string | null;
  declaredRecordedAt?: string | null;
  recordedAtSource?: 'CONTAINER_TAG' | 'DECLARED' | null;
  recordedAtDiscrepancySeconds?: number | null;
  recordedAtFlagged?: boolean;
  containerFormat: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  bitRate: number | null;
  gpsLatitude: number | null;
  gpsLongitude: number | null;
  gpsSource: string | null;
  deviceMetadata: Record<string, unknown>;
  officer: { id: string; fullName: string; badgeNumber: string | null } | null;
  device: { id: string; serialNumber: string; deviceType: string; make: string | null; model: string | null } | null;
  uploadedBy: Ref;
  retentionPolicy: { id: string; name: string } | null;
  retainUntil: string | null;
  legalHoldReason: string | null;
  legalHoldBy: Ref | null;
  legalHoldAt: string | null;
  registeredAt: string | null;
  archivedAt: string | null;
  disposedAt: string | null;
  lastVerifiedAt: string | null;
  duplicateOf: { id: string; evidenceNumber: string | null } | null;
  thumbnailUrl: string | null;
  tags: Array<{ tag: string; source: string }>;
  cases: Array<{ id: string; caseNumber: string; title: string; status: string }>;
  hiddenCaseCount: number;
  createdAt: string;
  permissions: EvidencePermissions;
}

export interface DisposalRequest {
  id: string;
  evidence: { id: string; evidenceNumber: string | null; title: string | null; status: string; legalHold: boolean; orgUnit: { id: string; name: string } };
  requestedBy: Ref;
  reason: string;
  authorityRef: string | null;
  status: string;
  decidedBy: Ref | null;
  decidedAt: string | null;
  decisionNote: string | null;
  executedAt: string | null;
  executionAttempts: number;
  executionError: string | null;
  createdAt: string;
  canDecide: boolean;
  canCancel: boolean;
  canRetry: boolean;
}

export interface RetentionPolicy {
  id: string;
  code: string;
  name: string;
  description: string | null;
  retentionDays: number | null;
  archiveAfterDays: number | null;
  longTermAfterDays: number | null;
  isDefault: boolean;
  evidenceCount: number;
}

/** Maps a coarse permission to the per-evidence flag computed by the API (jurisdiction + status aware). */
export const PERMISSION_FLAGS: Partial<Record<Permission, keyof EvidencePermissions>> = {
  'evidence:play': 'canPlay',
  'evidence:download_original': 'canDownloadOriginal',
  'evidence:edit_metadata': 'canEdit',
  'evidence:legal_hold': 'canLegalHold',
  'evidence:verify': 'canVerify',
  'evidence:dispose_request': 'canRequestDisposal',
  'evidence:dispose_approve': 'canApproveDisposal',
  'retention:manage': 'canManageRetention',
  'evidence:snapshot': 'canSnapshot',
  'ai:request': 'canRequestAi',
  'export:create': 'canExport',
  'share:create': 'canShare',
  'cases:link_evidence': 'canLinkCase',
  'custody:read': 'canViewCustody',
};

export const evidenceKey = (id: string) => ['evidence', 'detail', id] as const;
