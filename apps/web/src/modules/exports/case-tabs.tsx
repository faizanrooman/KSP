/** Case tab "Court exports": exports made for this case + start a new export from the case's evidence. */
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import type { CaseSummary, CaseTab } from '@/lib/extensions';
import { Button, Card, DataTable, EmptyState, StatusBadge, type Column } from '@/components/ui';
import type { ExportSummary, Paged } from './types';

function CaseExportsTab({ caseItem }: { caseItem: CaseSummary }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const view = can('export:approve') ? 'all' : 'mine';
  const q = useQuery({ queryKey: ['exports', 'case', caseItem.id, view], queryFn: () => api.get<Paged<ExportSummary>>('/exports', { view, caseId: caseItem.id, pageSize: 100 }) });
  const cols: Column<ExportSummary>[] = [
    { key: 'n', header: 'Export', render: (r) => <Link className="mono text-brand-700 hover:underline" to={`/exports/${r.id}`}>{r.exportNumber}</Link> },
    { key: 's', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'c', header: 'Court', render: (r) => [r.courtName, r.courtCaseNumber].filter(Boolean).join(' · ') || '—' },
    { key: 'i', header: 'Items', render: (r) => r.itemCount },
    { key: 'a', header: 'Requested', render: (r) => `${r.createdBy.name} · ${formatDateTime(r.createdAt)}` },
  ];
  return (
    <Card title="Court exports" bodyClassName="p-0" actions={can('export:create') ? <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => navigate(`/exports/new?caseId=${caseItem.id}`)}>Export case evidence</Button> : undefined}>
      <DataTable caption="Case exports" columns={cols} rows={q.data?.items} rowKey={(r) => r.id} loading={q.isFetching} error={q.error} onRetry={() => void q.refetch()} empty={<EmptyState title="No exports for this case" />} />
    </Card>
  );
}

const tabs: CaseTab[] = [{ id: 'exports', label: 'Court exports', order: 70, anyOf: ['export:create', 'export:approve'], component: CaseExportsTab }];
export default tabs;
