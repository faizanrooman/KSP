/** Share detail: recipient, permissions, items, access log, revoke. */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatDateTime, titleCase } from '@/lib/format';
import { Alert, Badge, Button, Card, ConfirmDialog, DataTable, EmptyState, ErrorState, KeyValue, PageHeader, Spinner, StatusBadge, useToast, type Column } from '@/components/ui';
import type { ShareDetail } from './types';

export function ShareDetailPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const toast = useToast();
  const [revoking, setRevoking] = useState(false);
  const q = useQuery({ queryKey: ['shares', 'detail', id], queryFn: () => api.get<ShareDetail>(`/shares/${id}`) });
  const revoke = useMutation({
    mutationFn: (reason: string) => api.post(`/shares/${id}/revoke`, { reason }),
    onSuccess: () => {
      setRevoking(false);
      toast.success('Share revoked — access stopped immediately');
      void qc.invalidateQueries({ queryKey: ['shares'] });
    },
  });
  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const s = q.data;
  const itemNo = (eid: string | null) => s.items.find((i) => i.evidenceId === eid)?.evidenceNumber ?? '—';
  const logCols: Column<ShareDetail['accessLog'][number]>[] = [
    { key: 'at', header: 'Time', render: (l) => <span className="whitespace-nowrap">{formatDateTime(l.at)}</span> },
    { key: 'a', header: 'Action', render: (l) => (['DENIED', 'CODE_FAILED'].includes(l.action) ? <Badge tone="red">{titleCase(l.action)}</Badge> : <Badge tone="blue">{titleCase(l.action)}</Badge>) },
    { key: 'e', header: 'Item', render: (l) => <span className="mono text-xs">{itemNo(l.evidenceId)}</span> },
    { key: 'd', header: 'Detail', render: (l) => l.detail ?? '—' },
    { key: 'ip', header: 'IP', render: (l) => l.ip ?? '—' },
    { key: 'ua', header: 'Browser', render: (l) => <span className="line-clamp-1 text-xs" title={l.userAgent ?? ''}>{l.userAgent ?? '—'}</span> },
  ];
  return (
    <div className="space-y-4">
      <PageHeader
        title={`Share with ${s.recipient.name ?? 'recipient'}`}
        subtitle={s.purpose}
        breadcrumb={<Link to="/shares" className="text-brand-700 hover:underline">Shares</Link>}
        actions={s.canRevoke ? <Button variant="danger" onClick={() => { revoke.reset(); setRevoking(true); }}>Revoke</Button> : undefined}
      />
      {s.status === 'LOCKED' && <Alert tone="red" title="Locked">Too many wrong access codes were entered ({s.failedCodeAttempts}). Revoke this share and create a new one if the recipient still needs access.</Alert>}
      <Card title="Share">
        <KeyValue items={[
          { label: 'Status', value: <StatusBadge status={s.status} /> },
          { label: 'Recipient', value: s.recipientType === 'EXTERNAL' ? `${s.recipient.name} <${s.recipient.email}>${s.recipient.organisation ? ` · ${s.recipient.organisation}` : ''}` : `${s.recipient.name} (KSP user)` },
          { label: 'Permissions', value: [s.permissions.watermark && s.recipientType === 'EXTERNAL' ? 'watermarked playback' : 'playback', s.permissions.allowDownload && (s.permissions.allowOriginal ? 'download incl. original' : s.recipientType === 'EXTERNAL' ? 'download (watermarked)' : 'download original'), s.permissions.allowPrint && 'print'].filter(Boolean).join(', ') },
          { label: 'Expires', value: formatDateTime(s.expiresAt) },
          { label: 'Views', value: s.recipientType === 'EXTERNAL' ? `${s.viewCount}${s.maxViews ? ` of ${s.maxViews}` : ''}` : '—' },
          { label: 'Downloads', value: s.downloadCount },
          { label: 'Shared by', value: `${s.createdBy.name} · ${formatDateTime(s.createdAt)}` },
          { label: 'Last accessed', value: formatDateTime(s.lastAccessedAt) },
          !!s.revokedAt && { label: 'Revoked', value: `${s.revokedBy?.name ?? '—'} · ${formatDateTime(s.revokedAt)} — ${s.revokeReason ?? ''}` },
        ]} />
      </Card>
      <Card title={`Items (${s.items.length})`}>
        <ul className="divide-y divide-ink-100 text-sm">
          {s.items.map((i) => <li key={i.evidenceId} className="py-1.5"><Link className="mono text-brand-700 hover:underline" to={`/evidence/${i.evidenceId}`}>{i.evidenceNumber}</Link> {i.title && <span className="text-ink-600">— {i.title}</span>}</li>)}
        </ul>
      </Card>
      <Card title="Access log" bodyClassName="p-0">
        <DataTable caption="Share access log" columns={logCols} rows={s.accessLog} rowKey={(l) => String(l.id)} empty={<EmptyState title={s.recipientType === 'EXTERNAL' ? 'Not opened yet' : 'Internal shares are logged in the chain of custody of each item'} />} />
      </Card>
      <ConfirmDialog
        open={revoking}
        title="Revoke share"
        message="The recipient loses access immediately, including any open viewing session."
        confirmLabel="Revoke"
        variant="danger"
        requireReason
        loading={revoke.isPending}
        error={revoke.error}
        onConfirm={(r) => revoke.mutate(r)}
        onCancel={() => setRevoking(false)}
      />
    </div>
  );
}
