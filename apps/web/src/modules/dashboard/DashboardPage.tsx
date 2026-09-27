import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { AlertOctagon, AlertTriangle, CheckCircle2, Info, RefreshCw, XCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatBytes, formatDateTime } from '@/lib/format';
import { useUrlState } from '@/lib/hooks';
import { Badge, Button, Card, DataTable, EmptyState, ErrorState, Field, Input, PageHeader, Spinner, Stat, clsx, type Column } from '@/components/ui';
import { OrgUnitSelect } from '@/components/pickers';
import { CategoryBars, STATUS, ThresholdMeter, TimeBars } from './charts';
import type { DashboardSummary } from './types';

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const DEFAULTS = { from: '', to: '', orgUnitId: '' };
const fmtInt = (n: number) => n.toLocaleString('en-IN');
const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);

export function SeverityIcon({ severity, className = 'h-4 w-4' }: { severity: string; className?: string }) {
  if (severity === 'CRITICAL') return <AlertOctagon className={className} style={{ color: STATUS.critical }} aria-hidden />;
  if (severity === 'WARNING') return <AlertTriangle className={className} style={{ color: '#b87900' }} aria-hidden />;
  return <Info className={className} style={{ color: STATUS.info }} aria-hidden />;
}

function OkBadge({ ok, label }: { ok: boolean; label?: string }) {
  return ok ? (
    <span className="inline-flex items-center gap-1 text-sm text-emerald-800"><CheckCircle2 className="h-4 w-4" aria-hidden />{label ?? 'OK'}</span>
  ) : (
    <span className="inline-flex items-center gap-1 text-sm font-medium text-red-800"><XCircle className="h-4 w-4" aria-hidden />{label ?? 'Failing'}</span>
  );
}

export function DashboardPage() {
  const { me } = useAuth();
  const [q, setQ] = useUrlState(DEFAULTS);
  const today = useMemo(() => new Date(), []);
  const from = q.from || isoDay(new Date(today.getTime() - 29 * 86_400_000));
  const to = q.to || isoDay(today);
  const query = useQuery({
    queryKey: ['dashboard', from, to, q.orgUnitId],
    queryFn: () => api.get<DashboardSummary>('/dashboard/summary', {
      from: new Date(`${from}T00:00:00`).toISOString(),
      to: new Date(new Date(`${to}T00:00:00`).getTime() + 86_400_000).toISOString(),
      orgUnitId: q.orgUnitId,
    }),
    refetchInterval: 60_000,
    placeholderData: (prev) => prev,
  });
  const d = query.data;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Dashboard"
        subtitle={d ? `${d.meta.scope === 'OWN' ? 'Your own uploads and evidence' : d.meta.orgUnit ? d.meta.orgUnit.name : 'Everything within your jurisdiction'} · refreshed ${formatDateTime(d.meta.generatedAt)} (auto-refresh every 60 s)` : `Welcome, ${me?.user.fullName ?? ''}`}
        actions={<Button variant="secondary" onClick={() => void query.refetch()} loading={query.isFetching}><RefreshCw className="h-4 w-4" aria-hidden />Refresh</Button>}
      />
      <Card>
        <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => e.preventDefault()} aria-label="Dashboard filters">
          <Field label="From" htmlFor="dash-from"><Input id="dash-from" type="date" value={from} max={to} onChange={(e) => setQ({ from: e.target.value })} /></Field>
          <Field label="To" htmlFor="dash-to"><Input id="dash-to" type="date" value={to} min={from} max={isoDay(today)} onChange={(e) => setQ({ to: e.target.value })} /></Field>
          <Field label="Station / unit" htmlFor="dash-org"><OrgUnitSelect id="dash-org" value={q.orgUnitId} onChange={(v) => setQ({ orgUnitId: v })} emptyLabel="All in my jurisdiction" /></Field>
          {(q.from || q.to || q.orgUnitId) && <Button variant="ghost" type="button" onClick={() => setQ({ from: '', to: '', orgUnitId: '' })}>Reset</Button>}
        </form>
      </Card>

      {query.isLoading && <Spinner label="Loading dashboard…" />}
      {query.error && !d && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
      {d && <DashboardBody d={d} />}
    </div>
  );
}

function DashboardBody({ d }: { d: DashboardSummary }) {
  const ev = d.evidence;
  const up = d.uploads;
  const stationCols: Column<DashboardSummary['evidence']['byStation'][number]>[] = [
    { key: 'name', header: 'Station / unit', render: (r) => <span className="font-medium text-ink-900">{r.name}</span> },
    { key: 'items', header: 'Items', render: (r) => fmtInt(r.items), className: 'text-right tabular-nums' },
    { key: 'period', header: 'Registered in period', render: (r) => fmtInt(r.registeredInPeriod), className: 'text-right tabular-nums' },
    { key: 'bytes', header: 'Size', render: (r) => formatBytes(r.bytes), className: 'text-right whitespace-nowrap' },
    { key: 'holds', header: 'Legal holds', render: (r) => fmtInt(r.legalHolds), className: 'text-right tabular-nums' },
    { key: 'q', header: 'Quarantined', render: (r) => (r.quarantined ? <span className="text-amber-800">{fmtInt(r.quarantined)}</span> : '0'), className: 'text-right tabular-nums' },
    { key: 'mf', header: 'Media failed', render: (r) => (r.mediaFailed ? <span className="text-red-800">{fmtInt(r.mediaFailed)}</span> : '0'), className: 'text-right tabular-nums' },
  ];
  const failCols: Column<DashboardSummary['recentFailures'][number]>[] = [
    { key: 'kind', header: 'Type', render: (r) => <Badge tone={r.kind === 'QUARANTINED' ? 'amber' : 'red'}>{r.kind.replace('_', ' ').toLowerCase()}</Badge> },
    { key: 'title', header: 'Item', render: (r) => (r.link ? <Link className="text-brand-700 hover:underline" to={r.link}>{r.title}</Link> : r.title) },
    { key: 'reason', header: 'Reason', render: (r) => <span className="text-xs text-ink-700">{r.reason ?? '—'}</span> },
    { key: 'at', header: 'When', render: (r) => formatDateTime(r.at), className: 'whitespace-nowrap' },
  ];
  const regSum = ev.perDay.reduce((s, x) => s + x.registered, 0);
  const upSum = up.perDay.reduce((s, x) => s + x.sessions, 0);
  const failSum = up.perDay.reduce((s, x) => s + x.failed, 0);
  const peakDay = ev.perDay.reduce<{ day: string; registered: number } | null>((m, x) => (!m || x.registered > m.registered ? x : m), null);

  return (
    <>
      <section aria-labelledby="kpi-h" className="space-y-2">
        <h2 id="kpi-h" className="sr-only">Key figures</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
          <Stat label="Evidence items" value={fmtInt(ev.total)} sub={formatBytes(ev.totalBytes)} />
          <Stat label="Registered (period)" value={fmtInt(ev.registeredInPeriod)} />
          <Stat label="Uploads (period)" value={fmtInt(up.total)} sub={`${fmtInt(up.inProgress)} in progress`} />
          <Stat label="Failed uploads" value={fmtInt(up.failed)} tone={up.failed ? 'red' : undefined} />
          <Stat label="Quarantined" value={fmtInt(ev.quarantined)} tone={ev.quarantined ? 'amber' : undefined} />
          <Stat label="Pending media processing" value={fmtInt(ev.pendingMediaProcessing)} sub={ev.mediaFailed ? `${fmtInt(ev.mediaFailed)} failed` : undefined} tone={ev.mediaFailed ? 'red' : undefined} />
          <Stat label="Legal holds" value={fmtInt(ev.legalHolds)} />
          <Stat label="Disposal pending" value={fmtInt(ev.disposalPending)} />
          <Stat label="Retention overdue" value={fmtInt(ev.retentionOverdue)} tone={ev.retentionOverdue ? 'amber' : undefined} />
          {d.analytics && <Stat label="Review queue" value={fmtInt(d.analytics.reviewQueue.pending + d.analytics.reviewQueue.needsSecondReview)} sub={`${fmtInt(d.analytics.reviewQueue.needsSecondReview)} need 2nd review`} />}
          {d.alerts && <Stat label="Open alerts" value={fmtInt(d.alerts.open)} sub={`${d.alerts.bySeverity.CRITICAL} critical`} tone={d.alerts.bySeverity.CRITICAL ? 'red' : d.alerts.open ? 'amber' : undefined} />}
        </div>
      </section>

      <div className="grid gap-5 xl:grid-cols-2">
        <Card title="Uploads per day">
          {upSum === 0 ? <EmptyState title="No uploads in this period" /> : (
            <TimeBars title="Uploads per day" rows={up.perDay} x="day"
              series={[{ key: 'sessions', label: 'Upload sessions' }, { key: 'failed', label: 'Failed' }]}
              summary={`${fmtInt(upSum)} upload sessions in the period, ${fmtInt(failSum)} failed.`} />
          )}
        </Card>
        <Card title="Evidence registered per day">
          {regSum === 0 ? <EmptyState title="No evidence registered in this period" /> : (
            <TimeBars title="Evidence registered per day" rows={ev.perDay} x="day" series={[{ key: 'registered', label: 'Registered items' }]}
              summary={`${fmtInt(regSum)} items registered${peakDay ? `; busiest day ${peakDay.day} with ${fmtInt(peakDay.registered)}` : ''}.`} />
          )}
        </Card>
      </div>

      {/* Column count follows the cards this role can see — a fixed 3-column grid left an empty third column. */}
      <div className={clsx('grid gap-5', ['', '', 'xl:grid-cols-2', 'xl:grid-cols-3'][[d.analytics, d.alerts, d.storage].filter(Boolean).length])}>
        {d.analytics && (
          <Card title="AI analysis & review">
            <CategoryBars title="AI jobs by status" label="status" value="n"
              rows={[{ status: 'Queued', n: d.analytics.jobs.queued }, { status: 'Running', n: d.analytics.jobs.running }, { status: 'Completed', n: d.analytics.jobs.completed }, { status: 'Failed', n: d.analytics.jobs.failed }]}
              summary={`${fmtInt(d.analytics.jobs.queued)} queued, ${fmtInt(d.analytics.jobs.running)} running, ${fmtInt(d.analytics.jobs.completed)} completed, ${fmtInt(d.analytics.jobs.failed)} failed.`}
              colorOf={(r) => (r.status === 'Failed' ? STATUS.critical : '#2a78d6')} />
            <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
              <div><dt className="text-ink-600">Pending review</dt><dd className="font-semibold">{fmtInt(d.analytics.reviewQueue.pending)}</dd></div>
              <div><dt className="text-ink-600">Needs second review</dt><dd className="font-semibold">{fmtInt(d.analytics.reviewQueue.needsSecondReview)}</dd></div>
              <div><dt className="text-ink-600">Approval rate</dt><dd className="font-semibold">{pct(d.analytics.reviewOutcomes.approvalRate)}</dd></div>
              <div><dt className="text-ink-600">Rejection rate</dt><dd className="font-semibold">{pct(d.analytics.reviewOutcomes.rejectionRate)}</dd></div>
            </dl>
          </Card>
        )}
        {d.alerts && (
          <Card title="Open alerts" actions={<Link to="/alerts" className="text-sm text-brand-700 hover:underline">All alerts</Link>}>
            <CategoryBars title="Open alerts by severity" label="severity" value="n"
              rows={(['CRITICAL', 'WARNING', 'INFO'] as const).map((s) => ({ severity: s, n: d.alerts!.bySeverity[s] }))}
              summary={`${d.alerts.bySeverity.CRITICAL} critical, ${d.alerts.bySeverity.WARNING} warning, ${d.alerts.bySeverity.INFO} info alerts open.`}
              colorOf={(r) => (r.severity === 'CRITICAL' ? STATUS.critical : r.severity === 'WARNING' ? STATUS.warning : STATUS.info)} />
            <ul className="mt-3 space-y-1 text-sm">
              {d.alerts.recent.map((a) => (
                <li key={a.id} className="flex items-start gap-2">
                  <SeverityIcon severity={a.severity} className="mt-0.5 h-4 w-4 shrink-0" />
                  <Link to={`/alerts/${a.id}`} className="text-ink-900 hover:underline"><span className="sr-only">{a.severity}: </span>{a.title}</Link>
                </li>
              ))}
              {!d.alerts.recent.length && <li className="text-ink-600">No open alerts.</li>}
            </ul>
          </Card>
        )}
        {d.storage && (
          <Card title="Storage utilisation" actions={<Link to="/system/health" className="text-sm text-brand-700 hover:underline">System health</Link>}>
            <ThresholdMeter percent={d.storage.percentUsed} warn={d.storage.warnThresholdPercent} critical={d.storage.criticalThresholdPercent} label={`${formatBytes(d.storage.usedBytes)}${d.storage.capacityBytes ? ` of ${formatBytes(d.storage.capacityBytes)}` : ''} used`} />
            <div className="mt-4">
              {d.storage.byTier.length ? (
                <CategoryBars title="Stored bytes by tier" label="tier" value="bytes" rows={d.storage.byTier} format={(v) => formatBytes(v)}
                  summary={d.storage.byTier.map((t) => `${t.tier} ${formatBytes(t.bytes)}`).join(', ')} />
              ) : <p className="text-sm text-ink-600">No storage snapshot yet (captured every 15 minutes by the worker).</p>}
            </div>
            {d.storage.growthBytesPerDay !== null && <p className="mt-2 text-xs text-ink-600">Growth: {formatBytes(d.storage.growthBytesPerDay)}/day over the last {d.storage.trend.length} days.</p>}
          </Card>
        )}
      </div>

      {d.system && (
        <Card title="System health" actions={<Link to="/system/health" className="text-sm text-brand-700 hover:underline">Details</Link>}>
          <div className="grid gap-3 text-sm md:grid-cols-4">
            <div><p className="text-ink-600">Database</p><OkBadge ok={d.system.database.ok} label={d.system.database.ok ? `OK · ${d.system.database.ms} ms` : undefined} /></div>
            <div><p className="text-ink-600">Object storage</p><OkBadge ok={d.system.objectStorage.ok} label={d.system.objectStorage.ok ? `OK · ${d.system.objectStorage.ms} ms` : undefined} /></div>
            <div><p className="text-ink-600">Workers alive</p><OkBadge ok={d.system.workers.alive > 0} label={`${d.system.workers.alive} alive`} /></div>
            <div><p className="text-ink-600">Queues</p><span>{fmtInt(d.system.queues.summary.totalQueued)} waiting · {fmtInt(d.system.queues.summary.deadLettered)} dead-lettered</span></div>
          </div>
        </Card>
      )}

      <Card title="By station">
        <DataTable columns={stationCols} rows={ev.byStation} rowKey={(r) => r.orgUnitId} caption="Evidence by station" empty={<EmptyState title="No evidence visible to you yet" />} />
      </Card>
      <Card title="Recent failures">
        <DataTable columns={failCols} rows={d.recentFailures} rowKey={(r) => `${r.kind}:${r.id}`} caption="Recent upload and processing failures" empty={<EmptyState title="No recent failures" description="Failed uploads, quarantined items and media processing errors appear here." />} />
      </Card>
    </>
  );
}
