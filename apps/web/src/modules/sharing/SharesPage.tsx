/** Shares list: created by me, received (internal), all in jurisdiction (share:manage_all). */
import { Link, useNavigate } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { SHARE_STATUSES } from '@ksp/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useDebounced, useUrlState } from '@/lib/hooks';
import { formatDateTime, titleCase } from '@/lib/format';
import { Badge, Card, DataTable, EmptyState, Field, Input, PageHeader, Pagination, Select, StatusBadge, Tabs, type Column } from '@/components/ui';
import type { Paged, ShareSummary } from './types';

const DEFAULTS = { view: 'mine', status: '', q: '', page: '1' };

export function SharesPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [s, set] = useUrlState(DEFAULTS);
  const views = [
    { id: 'mine', label: 'Shared by me' },
    { id: 'received', label: 'Shared with me' },
    ...(can('share:manage_all') ? [{ id: 'all', label: 'All in my jurisdiction' }] : []),
  ];
  const view = views.some((v) => v.id === s.view) ? s.view : 'mine';
  const search = useDebounced(s.q.trim());
  const q = useQuery({
    queryKey: ['shares', 'list', view, s.status, search, s.page],
    queryFn: () => api.get<Paged<ShareSummary>>('/shares', { view, status: s.status || undefined, q: search || undefined, page: s.page, pageSize: 25 }),
    placeholderData: keepPreviousData,
  });
  const cols: Column<ShareSummary>[] = [
    { key: 'r', header: 'Recipient', render: (r) => <Link className="text-brand-700 hover:underline" to={`/shares/${r.id}`}>{r.recipient.name ?? '—'}</Link> },
    { key: 't', header: 'Type', render: (r) => <Badge tone={r.recipientType === 'EXTERNAL' ? 'purple' : 'blue'}>{r.recipientType === 'EXTERNAL' ? 'External' : 'Internal'}</Badge> },
    { key: 's', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'p', header: 'Purpose', render: (r) => <span className="line-clamp-1">{r.purpose}</span> },
    { key: 'i', header: 'Items', render: (r) => r.itemCount },
    { key: 'v', header: 'Views', render: (r) => (r.recipientType === 'EXTERNAL' ? `${r.viewCount}${r.maxViews ? ` / ${r.maxViews}` : ''}` : '—') },
    { key: 'e', header: 'Expires', render: (r) => <span className="whitespace-nowrap">{formatDateTime(r.expiresAt)}</span> },
    { key: 'b', header: 'Shared by', render: (r) => r.createdBy.name },
  ];
  return (
    <div className="space-y-4">
      <PageHeader title="Shares" subtitle='Time-limited, revocable access to evidence. Start a share from an evidence item ("Share").' />
      <Tabs tabs={views} value={view} onChange={(v) => set({ view: v, page: '1' })} />
      <Card>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Field label="Search" htmlFor="sh-q"><Input id="sh-q" value={s.q} placeholder="Recipient, e-mail or purpose" onChange={(e) => set({ q: e.target.value })} /></Field>
          <Field label="Status" htmlFor="sh-st">
            <Select id="sh-st" value={s.status} onChange={(e) => set({ status: e.target.value })}>
              <option value="">All</option>
              {SHARE_STATUSES.map((x) => <option key={x} value={x}>{titleCase(x)}</option>)}
            </Select>
          </Field>
        </div>
      </Card>
      <Card bodyClassName="p-0">
        <DataTable caption="Shares" columns={cols} rows={q.data?.items} rowKey={(r) => r.id} loading={q.isFetching} error={q.error} onRetry={() => void q.refetch()} onRowClick={(r) => navigate(`/shares/${r.id}`)} empty={<EmptyState title="No shares" />} />
        {q.data && q.data.total > q.data.pageSize && <Pagination page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={(p) => set({ page: String(p) })} />}
      </Card>
    </div>
  );
}
