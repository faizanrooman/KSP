/** Court exports: my requests, approval queue, all in scope. */
import { Link, useNavigate } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { EXPORT_STATUSES } from '@ksp/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useUrlState } from '@/lib/hooks';
import { formatDateTime, titleCase } from '@/lib/format';
import { Button, Card, DataTable, EmptyState, Field, Input, PageHeader, Pagination, Select, StatusBadge, Tabs, type Column } from '@/components/ui';
import type { ExportSummary, Paged } from './types';

const DEFAULTS = { view: 'mine', status: '', q: '', page: '1' };

export function ExportsPage() {
  const { can, canAny } = useAuth();
  const navigate = useNavigate();
  const [s, set] = useUrlState(DEFAULTS);
  const views = [
    ...(can('export:create') ? [{ id: 'mine', label: 'My requests' }] : []),
    ...(can('export:approve') ? [{ id: 'pending', label: 'Awaiting my approval' }, { id: 'all', label: 'All in my jurisdiction' }] : []),
  ] as Array<{ id: string; label: string }>;
  const view = views.some((v) => v.id === s.view) ? s.view : (views[0]?.id ?? 'mine');
  const q = useQuery({
    queryKey: ['exports', 'list', view, s.status, s.q, s.page],
    queryFn: () => api.get<Paged<ExportSummary>>('/exports', { view, status: s.status || undefined, q: s.q || undefined, page: s.page, pageSize: 25 }),
    placeholderData: keepPreviousData,
    refetchInterval: (query) => (query.state.data?.items.some((x) => ['APPROVED', 'PROCESSING'].includes(x.status)) ? 4000 : false),
  });
  const cols: Column<ExportSummary>[] = [
    { key: 'num', header: 'Export', render: (r) => <Link className="mono text-brand-700 hover:underline" to={`/exports/${r.id}`}>{r.exportNumber}</Link> },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'purpose', header: 'Purpose / court', render: (r) => <div><div className="line-clamp-1">{r.purpose}</div><div className="text-xs text-ink-500">{[r.courtName, r.courtCaseNumber].filter(Boolean).join(' · ') || '—'}</div></div> },
    { key: 'items', header: 'Items', render: (r) => r.itemCount },
    { key: 'by', header: 'Requested by', render: (r) => r.createdBy.name },
    { key: 'at', header: 'Requested', render: (r) => <span className="whitespace-nowrap">{formatDateTime(r.createdAt)}</span> },
    { key: 'appr', header: 'Decided by', render: (r) => r.approvedBy?.name ?? '—' },
  ];
  return (
    <div className="space-y-4">
      <PageHeader
        title="Court exports"
        subtitle="Controlled export of evidence for court: two-person approval, integrity re-verification, signed manifest and fact sheet."
        actions={can('export:create') ? <Button icon={<Plus className="h-4 w-4" />} onClick={() => navigate('/exports/new')}>New export</Button> : undefined}
      />
      {views.length > 1 && <Tabs tabs={views} value={view} onChange={(v) => set({ view: v, page: '1' })} />}
      <Card>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Field label="Search" htmlFor="ex-q"><Input id="ex-q" value={s.q} placeholder="Export number, purpose, court case" onChange={(e) => set({ q: e.target.value })} /></Field>
          <Field label="Status" htmlFor="ex-status">
            <Select id="ex-status" value={s.status} onChange={(e) => set({ status: e.target.value })}>
              <option value="">All</option>
              {EXPORT_STATUSES.map((x) => <option key={x} value={x}>{titleCase(x)}</option>)}
            </Select>
          </Field>
        </div>
      </Card>
      <Card bodyClassName="p-0">
        <DataTable
          caption="Exports"
          columns={cols}
          rows={q.data?.items}
          rowKey={(r) => r.id}
          loading={q.isFetching}
          error={q.error}
          onRetry={() => void q.refetch()}
          onRowClick={(r) => navigate(`/exports/${r.id}`)}
          empty={<EmptyState title={view === 'pending' ? 'Nothing awaiting your approval' : 'No exports'} description={canAny('export:create') && view === 'mine' ? 'Start an export from an evidence item ("Export for court") or with New export.' : undefined} />}
        />
        {q.data && q.data.total > q.data.pageSize && <div className="border-t border-ink-100 p-3"><Pagination page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={(p) => set({ page: String(p) })} /></div>}
      </Card>
    </div>
  );
}
