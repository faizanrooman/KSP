import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { Page, UploadSessionView } from '@ksp/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatBytes, formatDateTime } from '@/lib/format';
import { useUrlState } from '@/lib/hooks';
import { Card, DataTable, EmptyState, Field, PageHeader, Pagination, Select, StatusBadge, type Column } from '@/components/ui';

const DEFAULTS = { scope: 'mine', status: '', page: '1' };
const ACTIVE_STATES = ['INITIATED', 'UPLOADING', 'COMPLETING'];

function outcome(v: UploadSessionView) {
  if (!v.evidence) return <StatusBadge status={v.status} />;
  return <StatusBadge status={v.evidence.status} />;
}

export function UploadHistoryPage() {
  const { can } = useAuth();
  const [q, setQ] = useUrlState(DEFAULTS);
  const page = Number(q.page) || 1;
  const query = useQuery({
    queryKey: ['uploads', q],
    queryFn: () => api.get<Page<UploadSessionView>>('/uploads', { scope: q.scope, status: q.status, page, pageSize: 25 }),
    // Poll while anything is still uploading or being validated.
    refetchInterval: (qq) =>
      qq.state.data?.items.some((v) => ACTIVE_STATES.includes(v.status) || (v.status === 'COMPLETED' && (!v.evidence || ['RECEIVED', 'VALIDATING'].includes(v.evidence.status)))) ? 5000 : false,
  });

  const columns: Column<UploadSessionView>[] = [
    { key: 'file', header: 'File', className: 'min-w-[12rem] max-w-xs', render: (v) => <span className="break-all font-medium text-ink-900">{v.filename}</span> },
    { key: 'station', header: 'Station', className: 'min-w-[9rem]', render: (v) => v.orgUnitName },
    ...(q.scope === 'station' ? [{ key: 'by', header: 'Uploaded by', render: (v: UploadSessionView) => v.createdByName }] : []),
    { key: 'size', header: 'Size', render: (v) => formatBytes(v.size), className: 'whitespace-nowrap' },
    {
      key: 'progress',
      header: 'Transfer',
      render: (v) => (ACTIVE_STATES.includes(v.status) ? `${Math.round((v.receivedBytes / v.size) * 100)}% · ${v.status.toLowerCase()}` : <StatusBadge status={v.status} />),
    },
    { key: 'outcome', header: 'Result', render: outcome },
    {
      key: 'evidence',
      header: 'Evidence',
      render: (v) =>
        v.evidence?.status === 'REGISTERED' ? (
          <Link className="whitespace-nowrap font-mono text-xs text-brand-700 hover:underline" to={`/evidence/${v.evidence.id}`}>{v.evidence.evidenceNumber}</Link>
        ) : v.evidence?.reasonCode ? (
          <span className="text-xs text-red-800" title={v.evidence.statusReason ?? ''}>{v.evidence.reasonCode}</span>
        ) : v.error ? (
          <span className="text-xs text-red-800">{v.error}</span>
        ) : (
          '—'
        ),
    },
    { key: 'created', header: 'Started', render: (v) => formatDateTime(v.createdAt), className: 'whitespace-nowrap' },
  ];

  return (
    <div className="space-y-5">
      <PageHeader title="Upload history" subtitle="Recent uploads and their validation outcome. Updates automatically while items are processing." actions={<Link to="/upload" className="text-sm font-medium text-brand-700 hover:underline">Upload evidence</Link>} />
      <Card>
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          {can('evidence:read') && (
            <Field label="Show" htmlFor="uh-scope">
              <Select id="uh-scope" value={q.scope} onChange={(e) => setQ({ scope: e.target.value })}>
                <option value="mine">My uploads</option>
                <option value="station">All uploads in my jurisdiction</option>
              </Select>
            </Field>
          )}
          <Field label="Status" htmlFor="uh-status">
            <Select id="uh-status" value={q.status} onChange={(e) => setQ({ status: e.target.value })}>
              <option value="">Any</option>
              <option value="UPLOADING">Uploading</option>
              <option value="VALIDATING">Validating</option>
              <option value="REGISTERED">Registered</option>
              <option value="QUARANTINED">Quarantined</option>
              <option value="REJECTED">Rejected</option>
              <option value="ABORTED">Cancelled</option>
              <option value="EXPIRED">Expired</option>
            </Select>
          </Field>
        </div>
        <DataTable
          caption="Upload sessions"
          columns={columns}
          rows={query.data?.items}
          rowKey={(v) => v.id}
          loading={query.isLoading}
          error={query.error}
          onRetry={() => void query.refetch()}
          empty={<EmptyState title="No uploads found" description="Uploads you start appear here with their validation result." action={<Link className="text-brand-700 underline" to="/upload">Upload evidence</Link>} />}
        />
        {query.data && <Pagination page={page} pageSize={query.data.pageSize} total={query.data.total} onPage={(p) => setQ({ page: String(p) })} />}
      </Card>
    </div>
  );
}
