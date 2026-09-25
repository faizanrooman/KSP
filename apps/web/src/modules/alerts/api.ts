export interface AlertView {
  id: string; ruleCode: string; severity: 'INFO' | 'WARNING' | 'CRITICAL'; title: string; message: string; status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';
  resourceType: string | null; resourceId: string | null; occurrences: number;
  orgUnit: { id: string; name: string; code: string } | null;
  firstSeenAt: string; lastSeenAt: string; notifiedAt: string | null;
  acknowledgedAt: string | null; acknowledgedBy: string | null; resolvedAt: string | null; resolvedBy: string | null;
  resolutionNote: string | null; autoResolved: boolean; link: string | null; canManage: boolean;
  deliveries?: Array<{ channel: string; status: string; recipients: number | null; detail: string | null; at: string }>;
}
export interface AlertRule { code: string; name: string; enabled: boolean; severity: 'INFO' | 'WARNING' | 'CRITICAL'; config: Record<string, number>; updatedAt: string; updatedBy: string | null; lastEvaluatedAt: string | null }
export interface NotificationView { id: string; kind: string; title: string; body: string | null; link: string | null; readAt: string | null; createdAt: string }
export interface NotificationPage { items: NotificationView[]; total: number; unread: number; page: number; pageSize: number }

export const RULE_FIELDS: Record<string, Array<{ key: string; label: string; hint?: string }>> = {
  STORAGE_THRESHOLD: [
    { key: 'warnPercent', label: 'Warning at % used', hint: 'Defaults to settings storagePolicy.warnThresholdPercent' },
    { key: 'criticalPercent', label: 'Critical at % used', hint: 'Defaults to storagePolicy.criticalThresholdPercent' },
    { key: 'capacityBytes', label: 'Capacity override (bytes)', hint: 'Defaults to storagePolicy.capacityBytes' },
  ],
  EXCESSIVE_DOWNLOADS: [{ key: 'perHour', label: 'Downloads per actor per hour (more than)' }],
  AUTH_BRUTE_FORCE: [{ key: 'failuresPer15Min', label: 'Failed logins per IP/account per 15 min (more than)' }],
  POLICY_VIOLATION: [{ key: 'deniedPer15Min', label: 'Denied accesses per user per 15 min (more than)' }],
  QUEUE_BACKLOG: [{ key: 'maxQueued', label: 'Max waiting jobs per queue' }, { key: 'maxAgeMinutes', label: 'Max age of oldest waiting job (min)' }],
  AUDIT_CHAIN_BROKEN: [{ key: 'fullVerifyEveryHours', label: 'Full ledger verification every (hours)' }],
};
