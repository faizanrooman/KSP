/** Export detail: status/progress, items with verified hashes, approve/reject, download, revoke. */
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Download, XCircle } from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import { formatBytes, formatDateTime, formatDuration, shortHash, titleCase } from '@/lib/format';
import { Alert, Badge, Button, Card, ConfirmDialog, DataTable, ErrorState, KeyValue, PageHeader, ProgressBar, Spinner, StatusBadge, useToast, type Column } from '@/components/ui';
import type { ExportDetail, ExportItem } from './types';

import { t } from '@/lib/i18n';
type Decision = 'approve' | 'reject' | 'revoke';

export function ExportDetailPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState<Decision | null>(null);
  const q = useQuery({
    queryKey: ['exports', 'detail', id],
    queryFn: () => api.get<ExportDetail>(`/exports/${id}`),
    refetchInterval: (query) => (['APPROVED', 'PROCESSING'].includes(query.state.data?.status ?? '') ? 2500 : false),
  });
  const decide = useMutation({
    mutationFn: ({ d, reason }: { d: Decision; reason: string }) => api.post<ExportDetail>(`/exports/${id}/${d}`, d === 'revoke' ? { reason } : { note: reason || undefined }),
    onSuccess: (_r, v) => {
      setOpen(null);
      toast.success(v.d === 'approve' ? 'Approved — the package is being built' : v.d === 'reject' ? 'Export rejected' : 'Export revoked; the package was deleted');
      void qc.invalidateQueries({ queryKey: ['exports'] });
    },
  });
  const download = useMutation({
    mutationFn: () => api.get<{ url: string; filename: string; sha256: string; sizeBytes: number }>(`/exports/${id}/download`),
    onSuccess: (r) => {
      const a = document.createElement('a');
      a.href = r.url;
      a.download = r.filename;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast.success(`Download started (${formatBytes(r.sizeBytes)}). Package SHA-256 ${shortHash(r.sha256, 16)}`);
      void qc.invalidateQueries({ queryKey: ['exports', 'detail', id] });
    },
    onError: (e) => toast.error(e),
  });
  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const x = q.data;
  const cols: Column<ExportItem>[] = [
    { key: 'num', header: t('Evidence'), render: (r) => <Link className="mono text-brand-700 hover:underline" to={`/evidence/${r.evidenceId}`}>{r.evidenceNumber ?? r.evidenceId}</Link> },
    { key: 'title', header: t('Title'), render: (r) => r.title ?? '—' },
    { key: 'dur', header: t('Duration'), render: (r) => formatDuration(r.durationMs) },
    { key: 'reg', header: t('Registered SHA-256'), render: (r) => <code className="mono text-xs" title={r.expectedSha256}>{shortHash(r.expectedSha256, 16)}</code> },
    { key: 'ver', header: t('Verified SHA-256'), render: (r) => (r.verifiedSha256 ? <code className="mono text-xs" title={r.verifiedSha256}>{shortHash(r.verifiedSha256, 16)}</code> : '—') },
    {
      key: 'ok', header: t('Integrity'), render: (r) => (r.verifiedOk === null ? <Badge>{t('Not yet verified')}</Badge> : r.verifiedOk ? <Badge tone="green"><CheckCircle2 className="mr-1 inline h-3 w-3" aria-hidden />{t('Match')}</Badge> : <Badge tone="red"><XCircle className="mr-1 inline h-3 w-3" aria-hidden />{t('Mismatch')}</Badge>),
    },
  ];
  const copy: Record<Decision, { title: string; label: string; message: string; variant: 'primary' | 'danger'; requireReason: boolean }> = {
    approve: { title: t('Approve export'), label: t('Approve'), message: `The package for ${x.exportNumber} will be built: originals are re-verified, then packaged with a signed manifest. You are recorded as the approving officer.`, variant: 'primary', requireReason: false },
    reject: { title: t('Reject export'), label: t('Reject'), message: t('The requester is informed through the export status.'), variant: 'danger', requireReason: true },
    revoke: { title: t('Revoke export'), label: t('Revoke'), message: t('The package is deleted and can no longer be downloaded. Copies already downloaded are not affected.'), variant: 'danger', requireReason: true },
  };
  return (
    <div className="space-y-4">
      <PageHeader
        title={<span className="font-mono">{x.exportNumber}</span>}
        subtitle={x.purpose}
        breadcrumb={<Link to="/exports" className="text-brand-700 hover:underline">{t('Court exports')}</Link>}
        actions={
          <div className="flex flex-wrap gap-2">
            {x.permissions.canApprove && <><Button onClick={() => { decide.reset(); setOpen('approve'); }}>{t('Approve')}</Button><Button variant="secondary" onClick={() => { decide.reset(); setOpen('reject'); }}>{t('Reject')}</Button></>}
            {x.permissions.canDownload && <Button icon={<Download className="h-4 w-4" />} loading={download.isPending} onClick={() => download.mutate()}>{t('Download package')}</Button>}
            {x.permissions.canRevoke && <Button variant="ghost" onClick={() => { decide.reset(); setOpen('revoke'); }}>{t('Revoke')}</Button>}
          </div>
        }
      />
      {x.status === 'FAILED' && <Alert tone="red" title={t('Export failed')}>{x.error}</Alert>}
      {x.status === 'PENDING_APPROVAL' && !x.permissions.canApprove && <Alert tone="amber">{t('Waiting for an approving officer. The requester cannot approve their own export.')}</Alert>}
      {['APPROVED', 'PROCESSING'].includes(x.status) && <Card title={t('Building package')}><ProgressBar value={x.progress} label={`${Math.round(x.progress * 100)} %`} /></Card>}
      <Card title={t('Export')}>
        <KeyValue items={[
          { label: t('Status'), value: <StatusBadge status={x.status} /> },
          { label: t('Court'), value: [x.courtName, x.courtCaseNumber].filter(Boolean).join(' · ') || '—' },
          { label: t('Recipient'), value: x.recipient ?? '—' },
          { label: t('Case'), value: x.case ? <Link className="text-brand-700 hover:underline" to={`/cases/${x.case.id}`}>{x.case.caseNumber}</Link> : '—' },
          { label: t('Requested'), value: `${x.createdBy.name} · ${formatDateTime(x.createdAt)}` },
          { label: x.status === 'REJECTED' ? 'Rejected' : 'Approved', value: x.approvedBy ? `${x.approvedBy.name} · ${formatDateTime(x.approvedAt)}` : '—' },
          { label: t('Decision note'), value: x.decisionNote ?? '—' },
          { label: t('Contents'), value: [x.options.includeOriginal && 'originals', x.options.includeWatermarked && 'watermarked copies', x.options.includeCustodyReport !== false && 'custody reports', x.options.includeFactSheet !== false && 'fact sheet'].filter(Boolean).join(', ') },
          !!x.revokedAt && { label: t('Revoked'), value: `${x.revokedBy?.name ?? '—'} · ${formatDateTime(x.revokedAt)} — ${x.revokeReason ?? ''}` },
        ]} />
      </Card>
      {x.sha256 && (
        <Card title={t('Package integrity')}>
          <KeyValue columns={1} items={[
            { label: t('Package SHA-256'), value: x.sha256, mono: true },
            { label: t('manifest.json SHA-256'), value: x.manifestSha256, mono: true },
            { label: t('Signature'), value: `${x.signatureAlgorithm ?? '—'} · key ${x.signingKeyId ?? '—'}` },
            { label: t('Certificate fingerprint'), value: x.certificateFingerprint, mono: true },
            { label: t('Ledger head sealed'), value: x.ledgerHead ? `seq ${x.ledgerHead.seq} · ${x.ledgerHead.hash}` : '—', mono: true },
            { label: t('Size'), value: formatBytes(x.sizeBytes) },
            { label: t('Downloads'), value: x.downloadCount },
            { label: t('Available until'), value: formatDateTime(x.expiresAt) },
          ]} />
          <p className="mt-2 text-xs text-ink-600">{t('Recipients can verify the package offline with the commands in VERIFY.txt, or upload it on')}{' '}<Link className="text-brand-700 underline" to="/exports/verify">{t('Verify package')}</Link>.</p>
        </Card>
      )}
      <Card title={`Items (${x.items.length})`} bodyClassName="p-0">
        <DataTable caption={t('Export items')} columns={cols} rows={x.items} rowKey={(r) => r.evidenceId} />
      </Card>
      {open && (
        <ConfirmDialog
          open
          title={copy[open].title}
          message={copy[open].message}
          confirmLabel={copy[open].label}
          variant={copy[open].variant}
          requireReason={copy[open].requireReason}
          reasonLabel={open === 'revoke' ? 'Reason for revocation' : 'Reason'}
          loading={decide.isPending}
          error={decide.error ? new Error(`${errorMessage(decide.error)}`) : undefined}
          onConfirm={(reason) => decide.mutate({ d: open, reason })}
          onCancel={() => setOpen(null)}
        />
      )}
      <p className="text-xs text-ink-500">{titleCase(x.status)}{' '}{t('· every action on this export is recorded in the chain of custody of each item.')}</p>
    </div>
  );
}
