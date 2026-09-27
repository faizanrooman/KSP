/** Export detail: status/progress, items with verified hashes, approve/reject, download, revoke. */
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Download, XCircle } from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import { formatBytes, formatDateTime, formatDuration, shortHash, titleCase } from '@/lib/format';
import { Alert, Badge, Button, Card, ConfirmDialog, DataTable, ErrorState, KeyValue, PageHeader, ProgressBar, Spinner, StatusBadge, useToast, type Column } from '@/components/ui';
import type { ExportDetail, ExportItem } from './types';

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
    { key: 'num', header: 'Evidence', render: (r) => <Link className="mono text-brand-700 hover:underline" to={`/evidence/${r.evidenceId}`}>{r.evidenceNumber ?? r.evidenceId}</Link> },
    { key: 'title', header: 'Title', render: (r) => r.title ?? '—' },
    { key: 'dur', header: 'Duration', render: (r) => formatDuration(r.durationMs) },
    { key: 'reg', header: 'Registered SHA-256', render: (r) => <code className="mono text-xs" title={r.expectedSha256}>{shortHash(r.expectedSha256, 16)}</code> },
    { key: 'ver', header: 'Verified SHA-256', render: (r) => (r.verifiedSha256 ? <code className="mono text-xs" title={r.verifiedSha256}>{shortHash(r.verifiedSha256, 16)}</code> : '—') },
    {
      key: 'ok', header: 'Integrity', render: (r) => (r.verifiedOk === null ? <Badge>Not yet verified</Badge> : r.verifiedOk ? <Badge tone="green"><CheckCircle2 className="mr-1 inline h-3 w-3" aria-hidden />Match</Badge> : <Badge tone="red"><XCircle className="mr-1 inline h-3 w-3" aria-hidden />Mismatch</Badge>),
    },
  ];
  const copy: Record<Decision, { title: string; label: string; message: string; variant: 'primary' | 'danger'; requireReason: boolean }> = {
    approve: { title: 'Approve export', label: 'Approve', message: `The package for ${x.exportNumber} will be built: originals are re-verified, then packaged with a signed manifest. You are recorded as the approving officer.`, variant: 'primary', requireReason: false },
    reject: { title: 'Reject export', label: 'Reject', message: 'The requester is informed through the export status.', variant: 'danger', requireReason: true },
    revoke: { title: 'Revoke export', label: 'Revoke', message: 'The package is deleted and can no longer be downloaded. Copies already downloaded are not affected.', variant: 'danger', requireReason: true },
  };
  return (
    <div className="space-y-4">
      <PageHeader
        title={<span className="font-mono">{x.exportNumber}</span>}
        subtitle={x.purpose}
        breadcrumb={<Link to="/exports" className="text-brand-700 hover:underline">Court exports</Link>}
        actions={
          <div className="flex flex-wrap gap-2">
            {x.permissions.canApprove && <><Button onClick={() => { decide.reset(); setOpen('approve'); }}>Approve</Button><Button variant="secondary" onClick={() => { decide.reset(); setOpen('reject'); }}>Reject</Button></>}
            {x.permissions.canDownload && <Button icon={<Download className="h-4 w-4" />} loading={download.isPending} onClick={() => download.mutate()}>Download package</Button>}
            {x.permissions.canRevoke && <Button variant="ghost" onClick={() => { decide.reset(); setOpen('revoke'); }}>Revoke</Button>}
          </div>
        }
      />
      {x.status === 'FAILED' && <Alert tone="red" title="Export failed">{x.error}</Alert>}
      {x.status === 'PENDING_APPROVAL' && !x.permissions.canApprove && <Alert tone="amber">Waiting for an approving officer. The requester cannot approve their own export.</Alert>}
      {['APPROVED', 'PROCESSING'].includes(x.status) && <Card title="Building package"><ProgressBar value={x.progress} label={`${Math.round(x.progress * 100)} %`} /></Card>}
      <Card title="Export">
        <KeyValue items={[
          { label: 'Status', value: <StatusBadge status={x.status} /> },
          { label: 'Court', value: [x.courtName, x.courtCaseNumber].filter(Boolean).join(' · ') || '—' },
          { label: 'Recipient', value: x.recipient ?? '—' },
          { label: 'Case', value: x.case ? <Link className="text-brand-700 hover:underline" to={`/cases/${x.case.id}`}>{x.case.caseNumber}</Link> : '—' },
          { label: 'Requested', value: `${x.createdBy.name} · ${formatDateTime(x.createdAt)}` },
          { label: x.status === 'REJECTED' ? 'Rejected' : 'Approved', value: x.approvedBy ? `${x.approvedBy.name} · ${formatDateTime(x.approvedAt)}` : '—' },
          { label: 'Decision note', value: x.decisionNote ?? '—' },
          { label: 'Contents', value: [x.options.includeOriginal && 'originals', x.options.includeWatermarked && 'watermarked copies', x.options.includeCustodyReport !== false && 'custody reports', x.options.includeFactSheet !== false && 'fact sheet'].filter(Boolean).join(', ') },
          !!x.revokedAt && { label: 'Revoked', value: `${x.revokedBy?.name ?? '—'} · ${formatDateTime(x.revokedAt)} — ${x.revokeReason ?? ''}` },
        ]} />
      </Card>
      {x.sha256 && (
        <Card title="Package integrity">
          <KeyValue columns={1} items={[
            { label: 'Package SHA-256', value: x.sha256, mono: true },
            { label: 'manifest.json SHA-256', value: x.manifestSha256, mono: true },
            { label: 'Signature', value: `${x.signatureAlgorithm ?? '—'} · key ${x.signingKeyId ?? '—'}` },
            { label: 'Certificate fingerprint', value: x.certificateFingerprint, mono: true },
            { label: 'Ledger head sealed', value: x.ledgerHead ? `seq ${x.ledgerHead.seq} · ${x.ledgerHead.hash}` : '—', mono: true },
            { label: 'Size', value: formatBytes(x.sizeBytes) },
            { label: 'Downloads', value: x.downloadCount },
            { label: 'Available until', value: formatDateTime(x.expiresAt) },
          ]} />
          <p className="mt-2 text-xs text-ink-600">Recipients can verify the package offline with the commands in VERIFY.txt, or upload it on <Link className="text-brand-700 underline" to="/exports/verify">Verify package</Link>.</p>
        </Card>
      )}
      <Card title={`Items (${x.items.length})`} bodyClassName="p-0">
        <DataTable caption="Export items" columns={cols} rows={x.items} rowKey={(r) => r.evidenceId} />
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
      <p className="text-xs text-ink-500">{titleCase(x.status)} · every action on this export is recorded in the chain of custody of each item.</p>
    </div>
  );
}
