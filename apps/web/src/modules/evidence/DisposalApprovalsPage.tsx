import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useUrlState } from '@/lib/hooks';
import { formatBytes, formatDate, formatDateTime } from '@/lib/format';
import { Badge, Button, Card, ConfirmDialog, DataTable, EmptyState, PageHeader, Pagination, Tabs, useToast, StatusBadge, type Column } from '@/components/ui';
import type { DisposalRequest, Paged } from './types';

import { t } from '@/lib/i18n';
type Decision = 'approve' | 'reject' | 'cancel';

/** Approve / reject / cancel / retry controls for one request (server decides what is allowed). */
export function DisposalDecision({ request }: { request: DisposalRequest }) {
  const [open, setOpen] = useState<Decision | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['evidence'] });
  };
  const m = useMutation({
    mutationFn: ({ d, note }: { d: Decision; note: string }) => api.post<DisposalRequest>(`/evidence/disposal-requests/${request.id}/${d}`, d === 'cancel' ? { note: note || undefined } : { note, ...(d === 'approve' && request.early ? { confirmEarly: true } : {}) }),
    onSuccess: (_r, v) => {
      setOpen(null);
      toast.success(v.d === 'approve' ? 'Approved — disposal execution queued' : v.d === 'reject' ? 'Request rejected' : 'Request cancelled');
      invalidate();
    },
  });
  const retry = useMutation({
    mutationFn: () => api.post(`/evidence/disposal-requests/${request.id}/retry`),
    onSuccess: () => {
      toast.success('Disposal execution re-queued');
      invalidate();
    },
    onError: (e) => toast.error(e),
  });
  if (!request.canDecide && !request.canCancel && !request.canRetry) return null;
  const copy: Record<Decision, { title: string; label: string; message: string }> = {
    approve: {
      title: t('Approve disposal'), label: t('Approve and dispose'),
      message: `This permanently destroys the original media and derived files of ${request.evidence.evidenceNumber ?? 'this evidence'}. The record and audit trail are kept.${request.early
        ? ` EARLY DISPOSAL: retention ${request.retainUntilAtRequest ? `runs until ${formatDate(request.retainUntilAtRequest)}` : 'is indefinite'}; authorised by ${request.authorityType === 'GOVERNMENT_ORDER' ? 'government order' : 'court order'} ${request.authorityRef ?? ''}${request.authorityDate ? ` dated ${formatDate(request.authorityDate)}` : ''}. Approving confirms you have checked that order.`
        : ''}`,
    },
    reject: { title: t('Reject disposal'), label: t('Reject'), message: t('The evidence returns to the registered state.') },
    cancel: { title: t('Cancel your request'), label: t('Cancel request'), message: t('The evidence returns to the registered state.') },
  };
  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {request.canDecide && (
        <>
          <Button size="sm" variant="danger" onClick={() => { m.reset(); setOpen('approve'); }}>{t('Approve')}</Button>
          <Button size="sm" variant="secondary" onClick={() => { m.reset(); setOpen('reject'); }}>{t('Reject')}</Button>
        </>
      )}
      {request.canCancel && <Button size="sm" variant="ghost" onClick={() => { m.reset(); setOpen('cancel'); }}>{t('Cancel')}</Button>}
      {request.canRetry && <Button size="sm" variant="secondary" loading={retry.isPending} onClick={() => retry.mutate()}>{t('Retry execution')}</Button>}
      {open && (
        <ConfirmDialog
          open
          title={copy[open].title}
          message={copy[open].message}
          confirmLabel={copy[open].label}
          variant={open === 'approve' ? 'danger' : 'primary'}
          requireReason={open !== 'cancel'}
          reasonLabel={t('Decision note')}
          minReason={3}
          loading={m.isPending}
          error={m.error}
          onConfirm={(note) => m.mutate({ d: open, note })}
          onCancel={() => setOpen(null)}
        />
      )}
    </div>
  );
}

const STATUSES = ['PENDING', 'APPROVED', 'EXECUTED', 'REJECTED', 'CANCELLED'] as const;
const DEFAULTS = { status: 'PENDING', page: '1', view: 'requests' };

interface Candidate {
  id: string;
  evidenceNumber: string | null;
  title: string | null;
  retainUntil: string;
  sizeBytes: number;
  storageTier: string;
  orgUnit: { id: string; name: string };
  retentionPolicy: string | null;
}

function Candidates({ page, onPage }: { page: number; onPage: (p: number) => void }) {
  const q = useQuery({ queryKey: ['evidence', 'disposal-candidates', page], queryFn: () => api.get<Paged<Candidate>>('/evidence/disposal-candidates', { page, pageSize: 25 }), placeholderData: keepPreviousData });
  const cols: Column<Candidate>[] = [
    { key: 'n', header: t('Evidence'), render: (r) => (<Link className="text-brand-700 hover:underline" to={`/evidence/${r.id}?tab=lifecycle`}><span className="mono">{r.evidenceNumber}</span> — {r.title ?? 'Untitled'}</Link>) },
    { key: 'u', header: t('Unit'), render: (r) => r.orgUnit.name },
    { key: 'p', header: t('Policy'), render: (r) => r.retentionPolicy ?? '—' },
    { key: 'r', header: t('Retention ended'), render: (r) => formatDate(r.retainUntil) },
    { key: 's', header: t('Size'), render: (r) => formatBytes(r.sizeBytes) },
  ];
  return (
    <>
      <DataTable caption={t('Disposal candidates')} columns={cols} rows={q.data?.items} rowKey={(r) => r.id} loading={q.isFetching} error={q.error} onRetry={() => void q.refetch()}
        empty={<EmptyState title={t('No disposal candidates')} description={t('Evidence appears here when its retention period has ended, it has no legal hold and no open case. Nothing is disposed automatically.')} />} />
      {q.data && <Pagination page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={onPage} />}
    </>
  );
}

export function DisposalApprovalsPage() {
  const [s, set] = useUrlState(DEFAULTS);
  const { canAny } = useAuth();
  const page = Number(s.page) || 1;
  const q = useQuery({
    queryKey: ['evidence', 'disposal-requests', s.status, page],
    queryFn: () => api.get<Paged<DisposalRequest>>('/evidence/disposal-requests', { status: s.status || undefined, page, pageSize: 25 }),
    placeholderData: keepPreviousData,
    enabled: s.view === 'requests',
  });
  const cols: Column<DisposalRequest>[] = [
    { key: 'ev', header: t('Evidence'), render: (r) => (<div><Link className="text-brand-700 hover:underline" to={`/evidence/${r.evidence.id}?tab=lifecycle`}><span className="mono">{r.evidence.evidenceNumber}</span></Link><p className="text-xs text-ink-500">{r.evidence.title ?? 'Untitled'} · {r.evidence.orgUnit.name}</p>{r.evidence.legalHold && <Badge tone="red">{t('Legal hold')}</Badge>}</div>) },
    { key: 'st', header: t('Status'), render: (r) => <StatusBadge status={r.status} /> },
    { key: 'rq', header: t('Requested by'), render: (r) => (<div><p>{r.requestedBy.fullName}</p><p className="text-xs text-ink-500">{formatDateTime(r.createdAt)}</p></div>) },
    { key: 'why', header: t('Reason / authority'), render: (r) => (<div className="max-w-sm"><p>{r.reason}</p><p className="text-xs text-ink-500">{r.authorityRef}{r.early && <> <Badge tone="red">{t('Before end of retention')}</Badge></>}</p></div>) },
    { key: 'dec', header: t('Decision'), render: (r) => (r.decidedBy ? <div><p>{r.decidedBy.fullName}</p><p className="text-xs text-ink-500">{formatDateTime(r.decidedAt)} — {r.decisionNote}</p></div> : '—') },
    { key: 'ex', header: t('Execution'), render: (r) => (r.executedAt ? <span>{t('Disposed')}{' '}{formatDateTime(r.executedAt)}</span> : r.executionError ? <span className="text-red-700">{t('Failed (')}{r.executionAttempts}×): {r.executionError}</span> : r.status === 'APPROVED' ? 'Queued' : '—') },
    { key: 'act', header: <span className="sr-only">{t('Actions')}</span>, render: (r) => <DisposalDecision request={r} /> },
  ];
  const showCandidates = canAny('retention:manage', 'evidence:dispose_request');
  return (
    <div className="space-y-4">
      <PageHeader title={t('Disposal approvals')} subtitle={t('Authorised disposal requires a request and a decision by a different officer. Evidence under legal hold or linked to an open case cannot be disposed.')} />
      <Tabs
        tabs={[{ id: 'requests', label: t('Requests') }, ...(showCandidates ? [{ id: 'candidates', label: t('Candidates') }] : [])]}
        value={s.view}
        onChange={(view) => set({ view, page: '1' })}
      />
      {s.view === 'candidates' && showCandidates ? (
        <Card bodyClassName="p-0"><Candidates page={page} onPage={(p) => set({ page: String(p) })} /></Card>
      ) : (
        <Card bodyClassName="p-0">
          <div className="flex flex-wrap gap-1 border-b border-ink-100 p-2" role="group" aria-label={t('Filter by status')}>
            {STATUSES.map((st) => (
              <Button key={st} size="sm" variant={s.status === st ? 'primary' : 'ghost'} aria-pressed={s.status === st} onClick={() => set({ status: st })}>
                {st.charAt(0) + st.slice(1).toLowerCase()}
              </Button>
            ))}
          </div>
          <DataTable caption={t('Disposal requests')} columns={cols} rows={q.data?.items} rowKey={(r) => r.id} loading={q.isFetching} error={q.error} onRetry={() => void q.refetch()}
            empty={<EmptyState title={`No ${s.status.toLowerCase()} requests`} />} />
          {q.data && <Pagination page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={(p) => set({ page: String(p) })} />}
        </Card>
      )}
    </div>
  );
}
