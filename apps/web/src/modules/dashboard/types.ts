export interface DashboardSummary {
  meta: {
    from: string; to: string; generatedAt: string; scope: 'JURISDICTION' | 'OWN' | 'RELATIONSHIP';
    orgUnit: { id: string; name: string; code: string } | null;
    sections: { uploads: boolean; evidence: boolean; analytics: boolean; alerts: boolean; storage: boolean; system: boolean };
    timingsMs: Record<string, number>;
  };
  uploads: { total: number; failed: number; inProgress: number; byStatus: Array<{ status: string; n: number }>; perDay: Array<{ day: string; sessions: number; failed: number; bytes: number }> };
  evidence: {
    total: number; totalBytes: number; registeredInPeriod: number; pendingMediaProcessing: number; mediaFailed: number; quarantined: number;
    legalHolds: number; disposalPending: number; retentionOverdue: number; disposedInPeriod: number;
    perDay: Array<{ day: string; registered: number; bytes: number }>;
    byStation: Array<{ orgUnitId: string; code: string; name: string; items: number; bytes: number; registeredInPeriod: number; legalHolds: number; mediaFailed: number; quarantined: number }>;
    byCategory: Array<{ category: string; items: number }>;
  };
  analytics: null | {
    jobs: { queued: number; running: number; completed: number; failed: number; cancelled: number };
    reviewQueue: { pending: number; needsSecondReview: number };
    reviewOutcomes: { approved: number; rejected: number; escalated: number; approvalRate: number | null; rejectionRate: number | null };
  };
  alerts: null | { open: number; bySeverity: Record<'CRITICAL' | 'WARNING' | 'INFO', number>; recent: Array<{ id: string; severity: string; title: string; ruleCode: string; lastSeenAt: string; status: string }> };
  recentFailures: Array<{ kind: string; id: string; title: string; reason: string | null; at: string; link: string | null }>;
  storage: null | StorageUtilisation;
  system: null | {
    database: { ok: boolean; ms: number; version: string | null; connections: { total: number; active: number; max: number } | null };
    objectStorage: { ok: boolean; ms: number };
    queues: { summary: QueueSummary; items: QueueStat[] };
    workers: { alive: number; services: Array<{ service: string; alive: number; stale: number }>; staleAfterSeconds: number };
  };
}

export interface StorageUtilisation {
  capturedAt: string | null; usedBytes: number; capacityBytes: number | null; percentUsed: number | null;
  warnThresholdPercent: number; criticalThresholdPercent: number;
  byTier: Array<{ tier: string; bytes: number; objects: number }>;
  byBucket: Array<{ bucket: string; tier: string; objects: number; bytes: number; source: string; dbBytes: number | null; capturedAt: string }>;
  trend: Array<{ day: string; bytes: number }>;
  growthBytesPerDay: number | null;
}
export interface QueueSummary { totalQueued: number; totalActive: number; failed24h: number; deadLettered: number; oldestQueuedSeconds: number | null }
export interface QueueStat { queue: string; queued: number; active: number; failed24h: number; completed24h: number; oldestQueuedSeconds: number | null; deadLetter: boolean }
