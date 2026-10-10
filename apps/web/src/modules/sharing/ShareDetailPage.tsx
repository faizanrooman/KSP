/** Share detail: recipient, permissions, items, access log, revoke. */
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatDateTime, titleCase } from '@/lib/format';
import { Alert, Badge, Button, Card, ConfirmDialog, DataTable, EmptyState, ErrorState, KeyValue, PageHeader, Spinner, StatusBadge, useToast, type Column } from '@/components/ui';
import type { ShareDetail } from './types';
import { ShareManageActions } from './ShareManageActions';

import { t } from '@/lib/i18n';
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
    { key: 'at', header: t('Time'), render: (l) => <span className="whitespace-nowrap">{formatDateTime(l.at)}</span> },
    { key: 'a', header: t('Action'), render: (l) => (['DENIED', 'CODE_FAILED'].includes(l.action) ? <Badge tone="red">{titleCase(l.action)}</Badge> : <Badge tone="blue">{titleCase(l.action)}</Badge>) },
    { key: 'e', header: t('Item'), render: (l) => <span className="mono whitespace-nowrap text-xs">{itemNo(l.evidenceId)}</span> },
    { key: 'd', header: t('Detail'), render: (l) => l.detail ?? '—' },
    { key: 'ip', header: t('IP'), render: (l) => l.ip ?? '—' },
    { key: 'ua', header: t('Browser'), render: (l) => <span className="block max-w-[14rem] truncate text-xs" title={l.userAgent ?? ''}>{l.userAgent ?? '—'}</span> },
  ];
  return (
    <div className="space-y-4">
      <PageHeader
        title={t('Share with {value}', { value: s.recipient.name ?? t('recipient') })}
        subtitle={s.purpose}
        breadcrumb={<Link to="/shares" className="text-brand-700 hover:underline">{t('Shares')}</Link>}
        actions={<div className="flex flex-wrap gap-2"><ShareManageActions share={s} />{s.canRevoke && <Button variant="danger" onClick={() => { revoke.reset(); setRevoking(true); }}>{t('Revoke')}</Button>}</div>}
      />
      {s.status === 'LOCKED' && <Alert tone="red" title={t('Locked')}>{t('Too many wrong access codes were entered (')}{s.failedCodeAttempts}). {s.canUnlock ? t('Confirm with the recipient, then unlock it — or revoke it.') : t('Ask the sender to unlock or revoke it.')}</Alert>}
      {s.items.some((i) => i.recipientHasOwnAccess) && (
        <Alert tone="amber" title={t('This share does not limit the recipient’s access')}>
          {t('{name} can open the items marked “own access” through their own jurisdiction or case access, so this share’s expiry, view limit and download setting do not restrict them. New shares to such recipients are refused.', { name: s.recipient.name ?? '' })}
        </Alert>
      )}
      <Card title={t('Share')}>
        <KeyValue items={[
          { label: t('Status'), value: <StatusBadge status={s.status} /> },
          { label: t('Recipient'), value: s.recipientType === 'EXTERNAL' ? `${s.recipient.name} <${s.recipient.email}>${s.recipient.organisation ? ` · ${s.recipient.organisation}` : ''}` : `${s.recipient.name} (KSP user)` },
          { label: t('Permissions'), value: [s.permissions.watermark && s.recipientType === 'EXTERNAL' ? 'watermarked playback' : 'playback', s.permissions.allowDownload && (s.permissions.allowOriginal ? 'download incl. original' : s.recipientType === 'EXTERNAL' ? 'download (watermarked)' : 'download original'), s.permissions.allowPrint && 'print'].filter(Boolean).join(', ') },
          { label: t('Expires'), value: formatDateTime(s.expiresAt) },
          { label: t('Views'), value: s.recipientType === 'EXTERNAL' || s.maxViews ? `${s.viewCount}${s.maxViews ? ` of ${s.maxViews}` : ''}` : '—' },
          { label: t('Downloads'), value: s.downloadCount },
          { label: t('Shared by'), value: `${s.createdBy.name} · ${formatDateTime(s.createdAt)}` },
          { label: t('Last accessed'), value: formatDateTime(s.lastAccessedAt) },
          !!s.revokedAt && { label: t('Revoked'), value: `${s.revokedBy?.name ?? '—'} · ${formatDateTime(s.revokedAt)} — ${s.revokeReason ?? ''}` },
        ]} />
      </Card>
      <Card title={t('Items ({count})', { count: s.items.length })}>
        <ul className="divide-y divide-ink-100 text-sm">
          {s.items.map((i) => <li key={i.evidenceId} className="py-1.5"><Link className="mono text-brand-700 hover:underline" to={`/evidence/${i.evidenceId}`}>{i.evidenceNumber}</Link> {i.title && <span className="text-ink-600">— {i.title}</span>}{i.recipientHasOwnAccess && <> <Badge tone="amber">{t('own access')}</Badge></>}</li>)}
        </ul>
      </Card>
      <Card title={t('Access log')} bodyClassName="p-0">
        <DataTable caption={t('Share access log')} columns={logCols} rows={s.accessLog} rowKey={(l) => String(l.id)} empty={<EmptyState title={s.recipientType === 'EXTERNAL' ? t('Not opened yet') : t('Internal shares are logged in the chain of custody of each item')} />} />
      </Card>
      <ConfirmDialog
        open={revoking}
        title={t('Revoke share')}
        message={t('The recipient loses access immediately, including any open viewing session.')}
        confirmLabel={t('Revoke')}
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
