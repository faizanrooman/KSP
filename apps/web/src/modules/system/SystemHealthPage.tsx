import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, RefreshCw, XCircle, AlertTriangle } from 'lucide-react';
import { api } from '@/lib/api';
import { formatBytes, formatDateTime } from '@/lib/format';
import { Alert, Button, Card, DataTable, EmptyState, ErrorState, KeyValue, PageHeader, Spinner, Stat, StatusBadge, type Column } from '@/components/ui';
import { CategoryBars, ThresholdMeter } from '../dashboard/charts';
import type { QueueStat, StorageUtilisation } from '../dashboard/types';

interface Health {
  status: 'ok' | 'degraded' | 'down'; reasons: string[]; checkedAt: string; tookMs: number;
  api: { pid: number; node: string; uptimeSeconds: number; rssBytes: number; version: string | null };
  database: { ok: boolean; ms: number; error?: string; version: string | null; sizeBytes: number | null; inRecovery: boolean | null; connections: { total: number; active: number; max: number } | null; pool: { total: number; idle: number; waiting: number }; replication: Array<{ client: string | null; state: string | null; lagSeconds: number | null }> | null };
  objectStorage: { ok: boolean; ms: number; buckets: Array<{ role: string; ok: boolean; ms: number; error?: string }> };
  queues: { summary: { totalQueued: number; totalActive: number; failed24h: number; deadLettered: number; oldestQueuedSeconds: number | null }; items: QueueStat[] };
  workers: { staleAfterSeconds: number; alive: number; items: Array<{ id: string; service: string; hostname: string; pid: number; version: string | null; startedAt: string; lastSeenAt: string; ageSeconds: number; alive: boolean }> } | null;
  backups: { recorded: boolean; lastSuccessful: { kind: string; finishedAt: string; sizeBytes: number | null; sha256: string | null; location: string | null } | null; lastSuccessfulAgeHours: number | null; recent: Array<{ id: string; kind: string; status: string; startedAt: string; finishedAt: string | null; sizeBytes: number | null; error: string | null }> } | null;
  auditLedger: { headSeq: number; headAt: string | null; lastCheckpoint: { headSeq: number; createdAt: string; keyId: string } | null; eventsSinceCheckpoint: number; verification: { verifiedThroughSeq: number | null; lastRunAt: string; lastFullAt: string | null; lastMode: string | null; firstBadSeq: number | null } | null } | null;
  storage: StorageUtilisation | null;
  openAlerts: Record<string, number>;
  alertChannels: { inApp: string; webhook: string; email: string };
}
interface MetricsSummary {
  window: { windowMinutes: number; requests: number; requestsPerMinute: number; errorRate5xx: number; clientErrorRate4xx: number; latencyMs: { p50: number | null; p95: number | null; p99: number | null; mean: number | null } };
  sinceStart: { requests: number; errors5xx: number; errorRate5xx: number };
  slowestRoutes: Array<{ method: string; route: string; count: number; meanMs: number; errors5xx: number }>;
  instance: { pid: number; uptimeSeconds: number };
}

const dur = (s: number | null) => (s === null ? '—' : s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`);
function Ok({ ok, text }: { ok: boolean; text?: string }) {
  return ok ? <span className="inline-flex items-center gap-1 text-emerald-800"><CheckCircle2 className="h-4 w-4" aria-hidden />{text ?? 'OK'}</span>
    : <span className="inline-flex items-center gap-1 font-medium text-red-800"><XCircle className="h-4 w-4" aria-hidden />{text ?? 'Failing'}</span>;
}

export function SystemHealthPage() {
  const health = useQuery({ queryKey: ['system-health'], queryFn: () => api.get<Health>('/system/health'), refetchInterval: 30_000 });
  const metrics = useQuery({ queryKey: ['system-metrics'], queryFn: () => api.get<MetricsSummary>('/system/metrics-summary'), refetchInterval: 30_000 });
  const h = health.data;
  const qCols: Column<QueueStat>[] = [
    { key: 'q', header: 'Queue', render: (q) => <span className="font-mono text-xs">{q.queue}</span> },
    { key: 'w', header: 'Waiting', render: (q) => (q.deadLetter && q.queued ? <span className="font-semibold text-red-800">{q.queued}</span> : q.queued), className: 'text-right tabular-nums' },
    { key: 'a', header: 'Active', render: (q) => q.active, className: 'text-right tabular-nums' },
    { key: 'o', header: 'Oldest waiting', render: (q) => dur(q.oldestQueuedSeconds), className: 'text-right' },
    { key: 'c', header: 'Completed 24 h', render: (q) => q.completed24h, className: 'text-right tabular-nums' },
    { key: 'f', header: 'Failed 24 h', render: (q) => (q.failed24h ? <span className="text-red-800">{q.failed24h}</span> : 0), className: 'text-right tabular-nums' },
  ];
  type W = NonNullable<Health['workers']>['items'][number];
  const wCols: Column<W>[] = [
    { key: 's', header: 'Service', render: (w) => w.service },
    { key: 'h', header: 'Host / PID', render: (w) => <span className="font-mono text-xs">{w.hostname}:{w.pid}</span> },
    { key: 'st', header: 'State', render: (w) => <Ok ok={w.alive} text={w.alive ? 'Alive' : 'Stale'} /> },
    { key: 'l', header: 'Last heartbeat', render: (w) => `${formatDateTime(w.lastSeenAt)} (${dur(w.ageSeconds)} ago)` },
    { key: 'u', header: 'Started', render: (w) => formatDateTime(w.startedAt) },
  ];
  return (
    <div className="space-y-5">
      <PageHeader title="System health" subtitle={h ? `Checked ${formatDateTime(h.checkedAt)} in ${h.tookMs} ms · refreshes every 30 s` : undefined}
        actions={<Button variant="secondary" onClick={() => { void health.refetch(); void metrics.refetch(); }} loading={health.isFetching}><RefreshCw className="h-4 w-4" aria-hidden />Refresh</Button>} />
      {health.isLoading && <Spinner />}
      {health.error && !h && <ErrorState error={health.error} onRetry={() => void health.refetch()} />}
      {h && (
        <>
          {h.status === 'ok' ? <Alert tone="green" title="All monitored components healthy" /> : (
            <Alert tone={h.status === 'down' ? 'red' : 'amber'} title={h.status === 'down' ? 'System down' : 'Degraded'}>
              <ul className="list-disc pl-5">{h.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
            </Alert>
          )}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Database" value={<Ok ok={h.database.ok} text={h.database.ok ? `${h.database.ms} ms` : 'Down'} />} sub={h.database.version ? `PostgreSQL ${h.database.version}` : h.database.error} />
            <Stat label="Object storage" value={<Ok ok={h.objectStorage.ok} text={h.objectStorage.ok ? `${h.objectStorage.ms} ms` : 'Failing'} />} sub={`${h.objectStorage.buckets.filter((b) => b.ok).length}/${h.objectStorage.buckets.length} buckets reachable`} />
            <Stat label="Workers alive" value={h.workers?.alive ?? 0} tone={h.workers && h.workers.alive === 0 ? 'red' : undefined} sub={`stale after ${h.workers?.staleAfterSeconds ?? 90}s`} />
            <Stat label="Open alerts" value={(h.openAlerts.CRITICAL ?? 0) + (h.openAlerts.WARNING ?? 0) + (h.openAlerts.INFO ?? 0)} sub={`${h.openAlerts.CRITICAL ?? 0} critical`} tone={h.openAlerts.CRITICAL ? 'red' : undefined} />
          </div>

          <Card title="API performance (this instance)">
            {metrics.isLoading ? <Spinner /> : metrics.error ? <ErrorState error={metrics.error} onRetry={() => void metrics.refetch()} /> : metrics.data && (
              <>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                  <Stat label={`Requests (${metrics.data.window.windowMinutes} min)`} value={metrics.data.window.requests} sub={`${metrics.data.window.requestsPerMinute}/min`} />
                  <Stat label="p50 latency" value={metrics.data.window.latencyMs.p50 === null ? '—' : `${metrics.data.window.latencyMs.p50} ms`} />
                  <Stat label="p95 latency" value={metrics.data.window.latencyMs.p95 === null ? '—' : `${metrics.data.window.latencyMs.p95} ms`} />
                  <Stat label="5xx error rate" value={`${(metrics.data.window.errorRate5xx * 100).toFixed(2)}%`} tone={metrics.data.window.errorRate5xx > 0.005 ? 'red' : undefined} />
                  <Stat label="Uptime" value={dur(metrics.data.instance.uptimeSeconds)} sub={`${metrics.data.sinceStart.requests} requests since start`} />
                </div>
                <p className="mt-2 text-xs text-ink-600">Per-instance estimate from histogram buckets. Fleet-wide availability (99.5% target) is measured by the synthetic probe in Prometheus — see docs/MONITORING.md; it is not asserted here.</p>
                {metrics.data.slowestRoutes.length > 0 && (
                  <div className="mt-3">
                    <CategoryBars title="Slowest routes by mean latency (ms)" label="route" value="meanMs" rows={metrics.data.slowestRoutes.map((r) => ({ ...r, route: `${r.method} ${r.route}` }))}
                      summary={`Slowest: ${metrics.data.slowestRoutes[0]!.method} ${metrics.data.slowestRoutes[0]!.route} at ${metrics.data.slowestRoutes[0]!.meanMs} ms mean.`} format={(v) => `${v} ms`} />
                  </div>
                )}
              </>
            )}
          </Card>

          <div className="grid gap-5 xl:grid-cols-2">
            <Card title="Database">
              <KeyValue items={[
                { label: 'Status', value: <Ok ok={h.database.ok} /> },
                { label: 'Version', value: h.database.version ?? '—' },
                { label: 'Size', value: formatBytes(h.database.sizeBytes) },
                { label: 'Connections', value: h.database.connections ? `${h.database.connections.total} / ${h.database.connections.max} (${h.database.connections.active} active)` : '—' },
                { label: 'API pool', value: `${h.database.pool.total} open · ${h.database.pool.idle} idle · ${h.database.pool.waiting} waiting` },
                { label: 'Replication', value: h.database.replication === null ? 'Not observable (needs pg_monitor)' : h.database.replication.length ? h.database.replication.map((r) => `${r.client}: ${r.state} lag ${r.lagSeconds ?? '?'}s`).join('; ') : 'No replicas attached' },
                { label: 'Role', value: h.database.inRecovery ? 'Standby (in recovery)' : 'Primary' },
              ]} />
            </Card>
            <Card title="Object storage buckets">
              <ul className="grid grid-cols-2 gap-1 text-sm">{h.objectStorage.buckets.map((b) => <li key={b.role} className="flex justify-between"><span>{b.role}</span><Ok ok={b.ok} text={b.ok ? `${b.ms} ms` : b.error} /></li>)}</ul>
            </Card>
          </div>

          <Card title="Queues">
            <p className="mb-2 text-sm text-ink-700">{h.queues.summary.totalQueued} waiting · {h.queues.summary.totalActive} active · {h.queues.summary.failed24h} failed in 24 h · {h.queues.summary.deadLettered} dead-lettered · oldest waiting {dur(h.queues.summary.oldestQueuedSeconds)}</p>
            <DataTable columns={qCols} rows={h.queues.items} rowKey={(q) => q.queue} caption="Queue depths" empty={<EmptyState title="No queues" />} />
          </Card>

          <Card title="Worker heartbeats">
            <DataTable columns={wCols} rows={h.workers?.items} rowKey={(w) => w.id} caption="Worker heartbeats" empty={<EmptyState title="No worker heartbeats in the last day" description="Workers write a heartbeat every 30 s. None have been recorded — background processing may be stopped." />} />
          </Card>

          <div className="grid gap-5 xl:grid-cols-2">
            <Card title="Audit ledger">
              {h.auditLedger && (
                <KeyValue items={[
                  { label: 'Head sequence', value: h.auditLedger.headSeq, mono: true },
                  { label: 'Last event', value: formatDateTime(h.auditLedger.headAt) },
                  { label: 'Last signed checkpoint', value: h.auditLedger.lastCheckpoint ? `#${h.auditLedger.lastCheckpoint.headSeq} at ${formatDateTime(h.auditLedger.lastCheckpoint.createdAt)} (${h.auditLedger.lastCheckpoint.keyId})` : 'None yet' },
                  { label: 'Events since checkpoint', value: h.auditLedger.eventsSinceCheckpoint },
                  { label: 'Chain verification', value: h.auditLedger.verification ? (h.auditLedger.verification.firstBadSeq ? <span className="inline-flex items-center gap-1 font-medium text-red-800"><AlertTriangle className="h-4 w-4" aria-hidden />Broken at #{h.auditLedger.verification.firstBadSeq}</span> : `Verified through #${h.auditLedger.verification.verifiedThroughSeq ?? 0} (${h.auditLedger.verification.lastMode?.toLowerCase() ?? '—'}, ${formatDateTime(h.auditLedger.verification.lastRunAt)})`) : 'Not yet run by the alert evaluator' },
                  { label: 'Last full verification', value: formatDateTime(h.auditLedger.verification?.lastFullAt) },
                ]} />
              )}
            </Card>
            <Card title="Backups">
              {h.backups && !h.backups.recorded ? <Alert tone="amber" title="No backup runs recorded">The backup tooling has not reported any run. Backup and restore are UNVERIFIED until it does.</Alert> : h.backups && (
                <>
                  <KeyValue items={[
                    { label: 'Last successful', value: h.backups.lastSuccessful ? `${h.backups.lastSuccessful.kind} · ${formatDateTime(h.backups.lastSuccessful.finishedAt)} (${h.backups.lastSuccessfulAgeHours} h ago)` : 'None' },
                    { label: 'Size', value: formatBytes(h.backups.lastSuccessful?.sizeBytes ?? null) },
                    { label: 'Location', value: h.backups.lastSuccessful?.location ?? '—' },
                  ]} />
                  <ul className="mt-2 space-y-1 text-xs">{h.backups.recent.map((b) => <li key={b.id}>{b.kind} · <StatusBadge status={b.status} /> · {formatDateTime(b.startedAt)} {b.error && <span className="text-red-800">· {b.error}</span>}</li>)}</ul>
                </>
              )}
            </Card>
          </div>

          {h.storage && (
            <Card title="Storage">
              <ThresholdMeter percent={h.storage.percentUsed} warn={h.storage.warnThresholdPercent} critical={h.storage.criticalThresholdPercent} label={`${formatBytes(h.storage.usedBytes)}${h.storage.capacityBytes ? ` of ${formatBytes(h.storage.capacityBytes)}` : ''} used`} />
              <table className="mt-4 min-w-full text-sm">
                <caption className="sr-only">Storage by store</caption>
                <thead><tr className="text-left text-ink-600"><th scope="col">Store</th><th scope="col">Tier</th><th scope="col" className="text-right">Objects</th><th scope="col" className="text-right">Size</th><th scope="col">Method</th><th scope="col" className="text-right">DB catalogue</th></tr></thead>
                <tbody>{h.storage.byBucket.map((b) => (
                  <tr key={b.role} className="border-t border-ink-100"><td className="font-mono text-xs">{b.role}</td><td>{b.tier}</td><td className="text-right tabular-nums">{b.objects}</td><td className="text-right">{formatBytes(b.bytes)}</td><td className="text-xs">{b.source === 'S3_LIST' ? 'S3 listing' : 'DB sum'}</td><td className="text-right">{formatBytes(b.dbBytes)}</td></tr>
                ))}</tbody>
              </table>
              {!h.storage.byBucket.length && <p className="text-sm text-ink-600">No snapshot captured yet.</p>}
            </Card>
          )}

          <Card title="Alert delivery channels">
            <KeyValue items={[{ label: 'In-app', value: h.alertChannels.inApp }, { label: 'Webhook', value: h.alertChannels.webhook }, { label: 'E-mail', value: h.alertChannels.email }]} />
          </Card>
        </>
      )}
    </div>
  );
}
