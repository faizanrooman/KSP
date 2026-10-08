import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatDate, formatDateTime, titleCase } from '@/lib/format';
import type { EvidenceSummary } from '@/lib/extensions';
import { Alert, Badge, Card, DataTable, EmptyState, ErrorState, KeyValue, ProgressBar, Spinner, StatusBadge, type Column } from '@/components/ui';
import type { DisposalRequest, EvidenceDetail } from './types';
import { RetentionAssignControl, TierChangeControl } from './actions';
import { DisposalDecision } from './DisposalApprovalsPage';

import { t } from '@/lib/i18n';
interface Lifecycle {
  storageTier: string;
  objectLockUntil: string | null;
  archivedAt: string | null;
  retainUntil: string | null;
  retentionPolicy: { id: string; name: string; retentionDays: number | null; archiveAfterDays: number | null; longTermAfterDays: number | null } | null;
  legalHold: boolean;
  openCaseCount: number;
  storageCopies: Array<{ id: number; tier: string; status: string; note: string | null; objectLockUntil: string | null; createdAt: string; updatedAt: string }>;
  legalHoldHistory: Array<{ id: number; action: string; reason: string; storageHold: string; storageNote: string | null; at: string; by: { id: string; fullName: string } }>;
  disposalRequests: DisposalRequest[];
}
interface Job {
  id: string;
  kind: string;
  status: string;
  progress: number;
  attempts: number;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export function LifecycleTab({ evidence }: { evidence: EvidenceSummary }) {
  const ev = evidence as EvidenceDetail;
  const q = useQuery({ queryKey: ['evidence', 'lifecycle', ev.id], queryFn: () => api.get<Lifecycle>(`/evidence/${ev.id}/lifecycle`) });
  const jobs = useQuery({
    queryKey: ['evidence', 'jobs', ev.id],
    queryFn: () => api.get<{ items: Job[] }>(`/evidence/${ev.id}/jobs`),
    refetchInterval: (query) => (query.state.data?.items.some((j) => j.status === 'QUEUED' || j.status === 'RUNNING') ? 3000 : false),
  });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const l = q.data!;
  const p = l.retentionPolicy;
  const days = (n: number | null | undefined) => (n == null ? 'Never' : `${n} days`);

  const jobCols: Column<Job>[] = [
    { key: 'kind', header: t('Job'), render: (r) => titleCase(r.kind) },
    { key: 'status', header: t('Status'), render: (r) => <StatusBadge status={r.status} /> },
    { key: 'progress', header: t('Progress'), render: (r) => (r.status === 'RUNNING' ? <ProgressBar value={r.progress} label={`${r.kind} progress`} /> : `${Math.round(r.progress * 100)}%`) },
    { key: 'attempts', header: t('Attempts'), render: (r) => r.attempts },
    { key: 'created', header: t('Queued'), render: (r) => <span className="whitespace-nowrap">{formatDateTime(r.createdAt)}</span> },
    { key: 'error', header: t('Error'), render: (r) => (r.error ? <span className="text-red-700">{r.error}</span> : '—') },
  ];
  const drCols: Column<DisposalRequest>[] = [
    { key: 'status', header: t('Status'), render: (r) => <StatusBadge status={r.status} /> },
    { key: 'req', header: t('Requested'), render: (r) => (<div><p>{r.requestedBy.fullName}</p><p className="text-xs text-ink-500">{formatDateTime(r.createdAt)}</p></div>) },
    { key: 'reason', header: t('Reason / authority'), render: (r) => (<div><p>{r.reason}</p><p className="text-xs text-ink-500">{r.authorityRef}</p></div>) },
    { key: 'dec', header: t('Decision'), render: (r) => (r.decidedBy ? <div><p>{r.decidedBy.fullName}</p><p className="text-xs text-ink-500">{r.decisionNote}</p></div> : '—') },
    { key: 'exec', header: t('Execution'), render: (r) => (r.executedAt ? formatDateTime(r.executedAt) : r.executionError ? <span className="text-red-700">{r.executionError}</span> : '—') },
    { key: 'act', header: <span className="sr-only">{t('Actions')}</span>, render: (r) => <DisposalDecision request={r} /> },
  ];

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={t('Storage tier')}>
          <KeyValue
            items={[
              { label: t('Current tier'), value: titleCase(l.storageTier) },
              { label: t('Object lock until'), value: formatDate(l.objectLockUntil) },
              { label: t('Archived'), value: formatDateTime(l.archivedAt) },
            ]}
          />
          {ev.permissions.canManageRetention && <div className="mt-4"><TierChangeControl ev={ev} /></div>}
          {l.storageCopies.length > 0 && (
            <ul className="mt-4 space-y-1 text-sm" aria-label={t('Stored copies')}>
              {l.storageCopies.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-2">
                  <Badge tone={c.status === 'CURRENT' ? 'green' : c.status === 'RETAINED' ? 'amber' : 'gray'}>{titleCase(c.status)}</Badge>
                  <span>{titleCase(c.tier)}{' '}{t('copy ·')}{' '}{formatDateTime(c.createdAt)}</span>
                  {c.note && <span className="text-xs text-ink-500">{c.note}</span>}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title={t('Retention')}>
          <KeyValue
            items={[
              { label: t('Policy'), value: p?.name ?? 'Not assigned (default applied by the lifecycle scan)' },
              { label: t('Retain until'), value: l.retainUntil ? formatDate(l.retainUntil) : p ? 'Indefinitely' : '—' },
              { label: t('Archive after'), value: p ? days(p.archiveAfterDays) : '—' },
              { label: t('Long-term after'), value: p ? days(p.longTermAfterDays) : '—' },
              { label: t('Open linked cases'), value: l.openCaseCount },
              { label: t('Legal hold'), value: l.legalHold ? <Badge tone="red">{t('On hold')}</Badge> : 'None' },
            ]}
          />
          {ev.permissions.canManageRetention && <div className="mt-4"><RetentionAssignControl ev={ev} currentId={p?.id ?? null} /></div>}
          {l.retainUntil && new Date(l.retainUntil) < new Date() && !l.legalHold && ev.status === 'REGISTERED' && (
            <div className="mt-3"><Alert tone="amber">{t('Retention period has ended. The item is a disposal candidate; it is never disposed automatically.')}</Alert></div>
          )}
        </Card>
      </div>
      <Card title={t('Legal hold history')}>
        {l.legalHoldHistory.length === 0 ? (
          <p className="text-sm text-ink-500">{t('No legal holds have been placed on this evidence.')}</p>
        ) : (
          <ol className="space-y-2 text-sm">
            {l.legalHoldHistory.map((h) => (
              <li key={h.id} className="flex flex-wrap gap-2">
                <Badge tone={h.action === 'SET' ? 'red' : 'green'}>{h.action === 'SET' ? 'Placed' : 'Released'}</Badge>
                <span>{formatDateTime(h.at)}{' '}{t('by')}{' '}{h.by.fullName}:</span>
                <span className="text-ink-700">{h.reason}</span>
                <span className="text-xs text-ink-500">{t('storage lock')}{' '}{titleCase(h.storageHold)}</span>
              </li>
            ))}
          </ol>
        )}
      </Card>
      <Card title={t('Disposal requests')} bodyClassName="p-0">
        <DataTable caption={t('Disposal requests')} columns={drCols} rows={l.disposalRequests} rowKey={(r) => r.id} empty={<EmptyState title={t('No disposal requests')} />} />
      </Card>
      <Card title={t('Processing jobs')} bodyClassName="p-0">
        <DataTable caption={t('Processing jobs')} columns={jobCols} rows={jobs.data?.items} rowKey={(r) => r.id} loading={jobs.isFetching} error={jobs.error} onRetry={() => void jobs.refetch()} empty={<EmptyState title={t('No background jobs recorded')} />} />
      </Card>
    </div>
  );
}
