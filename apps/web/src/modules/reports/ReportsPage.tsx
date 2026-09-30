import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '@/lib/api';
import { formatBytes, formatDateTime, shortHash } from '@/lib/format';
import { useUrlState } from '@/lib/hooks';
import { Alert, Button, Card, DataTable, EmptyState, ErrorState, Field, Input, PageHeader, Pagination, Select, Spinner, StatusBadge, useToast, type Column } from '@/components/ui';
import { OrgUnitSelect, UserPicker, type UserOption } from '@/components/pickers';
import { SchedulesCard } from './SchedulesCard';

interface ReportType { code: string; title: string; description: string; requires: string[]; extraParams: string[]; available: boolean; jurisdiction: string[] }
interface ReportRun {
  id: string; reportType: string; title: string; format: string; status: string; rowCount: number | null; sha256: string | null; contentSha256: string | null;
  sizeBytes: number | null; error: string | null; createdAt: string; finishedAt: string | null; downloadCount: number;
  params: { from: string | null; to: string | null; jurisdiction: string[] }; orgUnit: { name: string } | null;
  scheduleId: string | null; requestedBy: { id: string; name: string } | null;
}

export function ReportsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const types = useQuery({ queryKey: ['report-types'], queryFn: () => api.get<{ formats: string[]; items: ReportType[] }>('/reports/types') });
  const [q, setQ] = useUrlState({ page: '1', run: '' });
  const page = Number(q.page) || 1;
  const runs = useQuery({
    queryKey: ['report-runs', page],
    queryFn: () => api.get<{ items: ReportRun[]; total: number }>('/reports/runs', { page, pageSize: 20 }),
    refetchInterval: (qq) => (qq.state.data?.items.some((r) => r.status === 'QUEUED' || r.status === 'RUNNING') ? 3000 : false),
  });
  const shared = useQuery({
    queryKey: ['report-runs', 'shared'],
    queryFn: () => api.get<{ items: ReportRun[]; total: number }>('/reports/runs', { shared: 'true', pageSize: 20 }),
    refetchInterval: (qq) => (qq.state.data?.items.some((r) => r.status === 'QUEUED' || r.status === 'RUNNING') ? 5000 : false),
  });
  const [type, setType] = useState('');
  const [format, setFormat] = useState('CSV');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [orgUnitId, setOrgUnitId] = useState('');
  const [actor, setActor] = useState<UserOption | null>(null);
  const [inactiveDays, setInactiveDays] = useState('90');
  const selected = types.data?.items.find((t) => t.code === type);
  const create = useMutation({
    mutationFn: () => api.post<ReportRun>('/reports/runs', {
      reportType: type, format,
      from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
      to: to ? new Date(new Date(`${to}T00:00:00`).getTime() + 86_400_000).toISOString() : undefined,
      orgUnitId: orgUnitId || undefined,
      actorId: selected?.extraParams.includes('actorId') && actor ? actor.id : undefined,
      inactiveDays: selected?.extraParams.includes('inactiveDays') ? Number(inactiveDays) || undefined : undefined,
    }),
    onSuccess: () => {
      toast.success('Report queued — it will appear below when ready.');
      void qc.invalidateQueries({ queryKey: ['report-runs'] });
    },
  });
  const download = useMutation({
    mutationFn: (id: string) => api.post<{ url: string }>(`/reports/runs/${id}/download-link`),
    onSuccess: (r) => { window.location.assign(r.url); },
    onError: (e) => toast.error(e),
  });

  const cols: Column<ReportRun>[] = [
    { key: 'title', header: 'Report', render: (r) => <span className={r.id === q.run ? 'font-semibold text-brand-700' : 'font-medium text-ink-900'}>{r.title}{r.scheduleId && <span className="ml-1 text-xs font-normal text-ink-500">(scheduled)</span>}</span> },
    { key: 'format', header: 'Format', render: (r) => r.format },
    { key: 'period', header: 'Period', render: (r) => (r.params.from || r.params.to ? `${r.params.from?.slice(0, 10) ?? '…'} → ${r.params.to?.slice(0, 10) ?? '…'}` : 'All time'), className: 'whitespace-nowrap' },
    { key: 'scope', header: 'Scope', render: (r) => r.orgUnit?.name ?? <span className="font-mono text-xs">{r.params.jurisdiction.join(', ')}</span> },
    { key: 'status', header: 'Status', render: (r) => (r.status === 'FAILED' ? <span title={r.error ?? ''}><StatusBadge status={r.status} /></span> : <StatusBadge status={r.status} />) },
    { key: 'rows', header: 'Rows', render: (r) => r.rowCount ?? '—', className: 'text-right tabular-nums' },
    { key: 'size', header: 'Size', render: (r) => formatBytes(r.sizeBytes), className: 'whitespace-nowrap' },
    { key: 'sha', header: 'SHA-256', render: (r) => (r.sha256 ? <span className="font-mono text-xs" title={r.sha256}>{shortHash(r.sha256)}</span> : '—') },
    { key: 'at', header: 'Requested', render: (r) => formatDateTime(r.createdAt), className: 'whitespace-nowrap' },
    { key: 'dl', header: <span className="sr-only">Download</span>, render: (r) => (r.status === 'COMPLETED' ? <Button variant="secondary" onClick={() => download.mutate(r.id)} loading={download.isPending && download.variables === r.id}>Download</Button> : null) },
  ];

  return (
    <div className="space-y-5">
      <PageHeader title="Reports" subtitle="Evidence and compliance reports. Data is limited to your jurisdiction; every request and download is audited." />
      <Card title="New report">
        {types.isLoading ? <Spinner /> : types.error ? <ErrorState error={types.error} onRetry={() => void types.refetch()} /> : (
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
            <div className="grid gap-3 md:grid-cols-3">
              <Field label="Report type" htmlFor="rep-type" required>
                <Select id="rep-type" value={type} required onChange={(e) => setType(e.target.value)}>
                  <option value="">Choose…</option>
                  {types.data!.items.map((t) => <option key={t.code} value={t.code} disabled={!t.available}>{t.title}{t.available ? '' : ' (not permitted)'}</option>)}
                </Select>
              </Field>
              <Field label="Format" htmlFor="rep-format"><Select id="rep-format" value={format} onChange={(e) => setFormat(e.target.value)}>{types.data!.formats.map((f) => <option key={f}>{f}</option>)}</Select></Field>
              <Field label="Station / unit" htmlFor="rep-org" hint="Must be inside your jurisdiction"><OrgUnitSelect scope="reports:generate" id="rep-org" value={orgUnitId} onChange={setOrgUnitId} emptyLabel="All in my jurisdiction" /></Field>
              <Field label="From" htmlFor="rep-from"><Input id="rep-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
              <Field label="To" htmlFor="rep-to"><Input id="rep-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
              {selected?.extraParams.includes('inactiveDays') && <Field label="Inactive after (days)" htmlFor="rep-inactive"><Input id="rep-inactive" type="number" min={1} max={3650} value={inactiveDays} onChange={(e) => setInactiveDays(e.target.value)} /></Field>}
              {selected?.extraParams.includes('actorId') && <Field label="Only this user (optional)" htmlFor="rep-actor"><UserPicker id="rep-actor" value={actor} onChange={setActor} /></Field>}
            </div>
            {selected && <p className="text-sm text-ink-700">{selected.description} <span className="text-ink-500">Jurisdiction: <span className="font-mono">{selected.jurisdiction.join(', ')}</span></span></p>}
            {create.error && <Alert tone="red">{errorMessage(create.error)}</Alert>}
            <Button type="submit" disabled={!type} loading={create.isPending}>Run report</Button>
          </form>
        )}
      </Card>
      {types.data && <SchedulesCard types={types.data.items} formats={types.data.formats} />}
      <Card title="My report runs">
        <DataTable columns={cols} rows={runs.data?.items} rowKey={(r) => r.id} loading={runs.isLoading} error={runs.error} onRetry={() => void runs.refetch()} caption="My report runs"
          empty={<EmptyState title="No reports yet" description="Run a report above; CSV, PDF and JSON are supported." />} />
        {runs.data && <Pagination page={page} pageSize={20} total={runs.data.total} onPage={(p) => setQ({ page: String(p) })} />}
      </Card>
      {(shared.data?.items.length ?? 0) > 0 && (
        <Card title="Shared with me (scheduled reports)">
          <DataTable columns={[...cols.slice(0, 1), { key: 'owner', header: 'Owner', render: (r) => r.requestedBy?.name ?? '—' }, ...cols.slice(1)]} rows={shared.data?.items} rowKey={(r) => r.id}
            loading={shared.isLoading} error={shared.error} onRetry={() => void shared.refetch()} caption="Scheduled report runs shared with me" empty={<EmptyState title="Nothing shared with you" />} />
        </Card>
      )}
    </div>
  );
}
