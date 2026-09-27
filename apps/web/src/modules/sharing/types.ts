/** Response shapes of /api/v1/shares and /api/v1/share-portal. */
export interface ShareSummary {
  id: string;
  status: string;
  recipientType: 'INTERNAL_USER' | 'EXTERNAL';
  recipient: { userId?: string | null; name: string | null; email?: string | null; organisation?: string | null };
  purpose: string;
  permissions: { allowDownload: boolean; allowOriginal: boolean; allowPrint: boolean; watermark: boolean };
  maxViews: number | null;
  viewCount: number;
  downloadCount: number;
  failedCodeAttempts: number;
  expiresAt: string;
  createdAt: string;
  createdBy: { id: string; name: string; username: string };
  orgUnit: { id: string; name: string };
  case: { id: string; caseNumber: string | null } | null;
  lastAccessedAt: string | null;
  lockedAt: string | null;
  revokedAt: string | null;
  revokedBy: { id: string; name: string | null } | null;
  revokeReason: string | null;
  itemCount: number;
  canRevoke: boolean;
  canUnlock?: boolean;
  canExtend?: boolean;
  canReissue?: boolean;
}

export interface ShareDetail extends ShareSummary {
  items: Array<{ evidenceId: string; evidenceNumber: string | null; title: string | null; durationMs: number | null; recordedAt: string | null }>;
  accessLog: Array<{ id: number; evidenceId: string | null; action: string; ip: string | null; userAgent: string | null; detail: string | null; at: string }>;
}

export interface CreatedShare {
  share: ShareSummary;
  link?: string;
  token?: string;
  accessCode?: string;
  delivery?: { link: 'SENT' | 'FAILED' | 'NOT_REQUESTED'; accessCode: 'SENT' | 'FAILED' | 'NOT_REQUESTED' };
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PortalShare {
  id: string;
  recipient: { name: string | null; email: string | null; organisation: string | null };
  purpose: string;
  sharedBy: { name: string; rank: string | null; unit: string };
  permissions: { allowDownload: boolean; allowOriginal: boolean; allowPrint: boolean; watermark: boolean };
  expiresAt: string;
  maxViews: number | null;
  viewCount: number;
}
export interface PortalItem {
  evidenceId: string;
  evidenceNumber: string | null;
  title: string | null;
  durationMs: number | null;
  recordedAt: string | null;
}
export interface PortalSession {
  sessionToken: string;
  sessionExpiresAt: string;
  share: PortalShare;
  items: PortalItem[];
}
