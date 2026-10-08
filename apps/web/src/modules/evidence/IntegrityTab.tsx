import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatBytes, formatDateTime, shortHash, titleCase } from '@/lib/format';
import type { EvidenceSummary } from '@/lib/extensions';
import { Alert, Badge, Card, DataTable, EmptyState, KeyValue, type Column } from '@/components/ui';
import type { EvidenceDetail } from './types';
import { VerifyButton } from './actions';

import { t } from '@/lib/i18n';
interface IntegrityItem {
  id: number;
  trigger: string;
  expectedSha256: string;
  actualSha256: string | null;
  ok: boolean;
  error: string | null;
  checkedAt: string;
  requestedBy: { id: string; fullName: string } | null;
}
interface IntegrityResponse {
  sha256: string | null;
  sha512: string | null;
  sizeBytes: number;
  lastVerifiedAt: string | null;
  lastResult: 'OK' | 'FAILED' | null;
  pendingJob: { id: string; status: string } | null;
  items: IntegrityItem[];
}

export function IntegrityTab({ evidence }: { evidence: EvidenceSummary }) {
  const ev = evidence as EvidenceDetail;
  const q = useQuery({
    queryKey: ['evidence', 'integrity', ev.id],
    queryFn: () => api.get<IntegrityResponse>(`/evidence/${ev.id}/integrity`),
    refetchInterval: (query) => (query.state.data?.pendingJob ? 3000 : false),
  });
  const cols: Column<IntegrityItem>[] = [
    { key: 'at', header: t('Checked'), render: (r) => <span className="whitespace-nowrap">{formatDateTime(r.checkedAt)}</span> },
    { key: 'trigger', header: t('Trigger'), render: (r) => titleCase(r.trigger) },
    { key: 'result', header: t('Result'), render: (r) => (r.ok ? <Badge tone="green">{t('Match')}</Badge> : <Badge tone="red">{t('Failed')}</Badge>) },
    { key: 'actual', header: t('Computed SHA-256'), render: (r) => <code className="mono text-xs" title={r.actualSha256 ?? ''}>{shortHash(r.actualSha256, 16)}</code> },
    { key: 'error', header: t('Detail'), render: (r) => r.error ?? '—' },
    { key: 'by', header: t('Requested by'), render: (r) => r.requestedBy?.fullName ?? 'System' },
  ];
  const d = q.data;
  return (
    <div className="space-y-4">
      {d?.lastResult === 'FAILED' && (
        <Alert tone="red" title={t('Integrity failure')}>
          {t('The most recent check did not match the registered hash. A critical alert has been raised; treat this item as potentially compromised until investigated.')}
        </Alert>
      )}
      <Card title={t('Fixity')} actions={ev.permissions.canVerify ? <VerifyButton evidence={ev} /> : undefined}>
        <KeyValue
          items={[
            { label: t('Registered SHA-256'), value: ev.sha256, mono: true },
            { label: t('Registered SHA-512'), value: ev.sha512, mono: true },
            { label: t('Size'), value: formatBytes(ev.sizeBytes) },
            { label: t('Last verified'), value: d?.lastVerifiedAt ? formatDateTime(d.lastVerifiedAt) : 'Never re-verified' },
            { label: t('Last result'), value: d?.lastResult ? (d.lastResult === 'OK' ? <Badge tone="green">{t('Match')}</Badge> : <Badge tone="red">{t('Failed')}</Badge>) : '—' },
            { label: t('Pending check'), value: d?.pendingJob ? titleCase(d.pendingJob.status) : 'None' },
          ]}
        />
      </Card>
      <Card title={t('Verification history')} bodyClassName="p-0">
        <DataTable
          caption={t('Integrity checks')}
          columns={cols}
          rows={d?.items}
          rowKey={(r) => String(r.id)}
          loading={q.isFetching}
          error={q.error}
          onRetry={() => void q.refetch()}
          empty={<EmptyState title={t('No integrity checks yet')} description={t('Checks run nightly, on demand, on export and whenever the original changes storage tier.')} />}
        />
      </Card>
    </div>
  );
}
