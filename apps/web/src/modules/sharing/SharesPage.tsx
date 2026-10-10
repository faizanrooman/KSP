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

import { t } from '@/lib/i18n';
const DEFAULTS = { view: 'mine', status: '', q: '', page: '1' };

export function SharesPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [s, set] = useUrlState(DEFAULTS);
  // Officers who cannot share (e.g. Evidence Custodian, Auditor) only receive internal shares: one view, no "Shared by me".
  const sharer = can('share:create') || can('share:manage_all');
  const views = [
    ...(sharer ? [{ id: 'mine', label: t('Shared by me') }] : []),
    { id: 'received', label: t('Shared with me') },
    ...(can('share:manage_all') ? [{ id: 'all', label: t('All in my jurisdiction') }] : []),
  ];
  const view = views.some((v) => v.id === s.view) ? s.view : views[0]!.id;
  const search = useDebounced(s.q.trim());
  const q = useQuery({
    queryKey: ['shares', 'list', view, s.status, search, s.page],
    queryFn: () => api.get<Paged<ShareSummary>>('/shares', { view, status: s.status || undefined, q: search || undefined, page: s.page, pageSize: 25 }),
    placeholderData: keepPreviousData,
  });
  const cols: Column<ShareSummary>[] = [
    { key: 'r', header: t('Recipient'), render: (r) => <Link className="text-brand-700 hover:underline" to={`/shares/${r.id}`}>{r.recipient.name ?? '—'}</Link> },
    { key: 't', header: t('Type'), render: (r) => <Badge tone={r.recipientType === 'EXTERNAL' ? 'purple' : 'blue'}>{r.recipientType === 'EXTERNAL' ? t('External') : t('Internal')}</Badge> },
    { key: 's', header: t('Status'), render: (r) => <StatusBadge status={r.status} /> },
    { key: 'p', header: t('Purpose'), render: (r) => <span className="line-clamp-1">{r.purpose}</span> },
    { key: 'i', header: t('Items'), render: (r) => r.itemCount },
    { key: 'v', header: t('Views'), render: (r) => (r.recipientType === 'EXTERNAL' || r.maxViews ? `${r.viewCount}${r.maxViews ? ` / ${r.maxViews}` : ''}` : '—') },
    { key: 'e', header: t('Expires'), render: (r) => <span className="whitespace-nowrap">{formatDateTime(r.expiresAt)}</span> },
    { key: 'b', header: t('Shared by'), render: (r) => r.createdBy.name },
  ];
  return (
    <div className="space-y-4">
      <PageHeader title={sharer ? t('Shares') : t('Shared with me')} subtitle={sharer ? t('Time-limited, revocable access to evidence. Start a share from an evidence item ("Share").') : t('Evidence other officers have shared with you. Each share ends at its expiry time or when its view limit is used up.')} />
      {views.length > 1 && <Tabs tabs={views} value={view} onChange={(v) => set({ view: v, page: '1' })} />}
      <Card>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Field label={t('Search')} htmlFor="sh-q"><Input id="sh-q" value={s.q} placeholder={t('Recipient, e-mail or purpose')} onChange={(e) => set({ q: e.target.value })} /></Field>
          <Field label={t('Status')} htmlFor="sh-st">
            <Select id="sh-st" value={s.status} onChange={(e) => set({ status: e.target.value })}>
              <option value="">{t('All')}</option>
              {SHARE_STATUSES.map((x) => <option key={x} value={x}>{titleCase(x)}</option>)}
            </Select>
          </Field>
        </div>
      </Card>
      <Card bodyClassName="p-0">
        <DataTable caption={t('Shares')} columns={cols} rows={q.data?.items} rowKey={(r) => r.id} loading={q.isFetching} error={q.error} onRetry={() => void q.refetch()} onRowClick={(r) => navigate(`/shares/${r.id}`)} empty={<EmptyState title={t('No shares')} />} />
        {q.data && q.data.total > q.data.pageSize && <Pagination page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={(p) => set({ page: String(p) })} />}
      </Card>
    </div>
  );
}
