import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { ALERT_RULE_CODES } from '@ksp/shared';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime, titleCase } from '@/lib/format';
import { useUrlState } from '@/lib/hooks';
import {
  Alert, Badge, Button, Card, Checkbox, ConfirmDialog, DataTable, EmptyState, ErrorState, Field, Input, KeyValue, PageHeader, Pagination, Select, Spinner, StatusBadge, useToast, type Column,
} from '@/components/ui';
import { SeverityIcon } from '../dashboard/DashboardPage';
import { RULE_FIELDS, type AlertRule, type AlertView, type NotificationPage } from './api';

import { t } from '@/lib/i18n';
const DEFAULTS = { status: 'OPEN', severity: '', rule: '', from: '', to: '', page: '1' };

export function SeverityBadge({ severity }: { severity: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <SeverityIcon severity={severity} />
      <Badge tone={severity === 'CRITICAL' ? 'red' : severity === 'WARNING' ? 'amber' : 'blue'}>{titleCase(severity)}</Badge>
    </span>
  );
}

export function AlertsListPage() {
  const [q, setQ] = useUrlState(DEFAULTS);
  const page = Number(q.page) || 1;
  const nav = useNavigate();
  const query = useQuery({
    queryKey: ['alerts', q],
    queryFn: () => api.get<{ items: AlertView[]; total: number; page: number; pageSize: number }>('/alerts', {
      status: q.status || undefined, severity: q.severity || undefined, rule: q.rule || undefined,
      from: q.from ? new Date(`${q.from}T00:00:00`).toISOString() : undefined, to: q.to ? new Date(`${q.to}T23:59:59`).toISOString() : undefined, page, pageSize: 25,
    }),
    refetchInterval: 60_000,
  });
  const cols: Column<AlertView>[] = [
    { key: 'sev', header: t('Severity'), render: (a) => <SeverityBadge severity={a.severity} /> },
    { key: 'title', header: t('Alert'), render: (a) => <Link to={`/alerts/${a.id}`} className="font-medium text-ink-900 hover:underline">{a.title}</Link> },
    { key: 'rule', header: t('Rule'), render: (a) => <span className="font-mono text-xs">{a.ruleCode}</span> },
    { key: 'unit', header: t('Unit'), render: (a) => a.orgUnit?.name ?? <span className="text-ink-500">{t('System-wide')}</span> },
    { key: 'n', header: t('Occurrences'), render: (a) => a.occurrences, className: 'text-right tabular-nums' },
    { key: 'status', header: t('Status'), render: (a) => <StatusBadge status={a.status} /> },
    { key: 'last', header: t('Last seen'), render: (a) => formatDateTime(a.lastSeenAt), className: 'whitespace-nowrap' },
  ];
  return (
    <div className="space-y-5">
      <PageHeader title={t('Alerts')} subtitle={t('Failed uploads, processing errors, storage thresholds and policy violations within your jurisdiction.')} />
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('Status')} htmlFor="al-status"><Select id="al-status" value={q.status} onChange={(e) => setQ({ status: e.target.value })}><option value="">{t('Any')}</option><option value="OPEN">{t('Open')}</option><option value="ACKNOWLEDGED">{t('Acknowledged')}</option><option value="RESOLVED">{t('Resolved')}</option></Select></Field>
          <Field label={t('Severity')} htmlFor="al-sev"><Select id="al-sev" value={q.severity} onChange={(e) => setQ({ severity: e.target.value })}><option value="">{t('Any')}</option><option value="CRITICAL">{t('Critical')}</option><option value="WARNING">{t('Warning')}</option><option value="INFO">{t('Info')}</option></Select></Field>
          <Field label={t('Rule')} htmlFor="al-rule"><Select id="al-rule" value={q.rule} onChange={(e) => setQ({ rule: e.target.value })}><option value="">{t('Any')}</option>{ALERT_RULE_CODES.map((c) => <option key={c}>{c}</option>)}</Select></Field>
          <Field label={t('From')} htmlFor="al-from"><Input id="al-from" type="date" value={q.from} onChange={(e) => setQ({ from: e.target.value })} /></Field>
          <Field label={t('To')} htmlFor="al-to"><Input id="al-to" type="date" value={q.to} onChange={(e) => setQ({ to: e.target.value })} /></Field>
        </div>
      </Card>
      <Card>
        <DataTable columns={cols} rows={query.data?.items} rowKey={(a) => a.id} loading={query.isLoading} error={query.error} onRetry={() => void query.refetch()} onRowClick={(a) => nav(`/alerts/${a.id}`)} caption={t('Alerts')}
          empty={<EmptyState title={t('No alerts match')} description={t('Nothing needs attention for these filters.')} />} />
        {query.data && <Pagination page={page} pageSize={25} total={query.data.total} onPage={(p) => setQ({ page: String(p) })} />}
      </Card>
    </div>
  );
}

export function AlertDetailPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const [dialog, setDialog] = useState<null | 'ack' | 'resolve'>(null);
  const query = useQuery({ queryKey: ['alert', id], queryFn: () => api.get<AlertView>(`/alerts/${id}`) });
  const act = useMutation({
    mutationFn: (v: { kind: 'ack' | 'resolve'; note: string }) => api.post<AlertView>(`/alerts/${id}/${v.kind === 'ack' ? 'acknowledge' : 'resolve'}`, v.note ? { note: v.note } : {}),
    onSuccess: (_d, v) => {
      setDialog(null);
      toast.success(v.kind === 'ack' ? 'Alert acknowledged' : 'Alert resolved');
      void qc.invalidateQueries({ queryKey: ['alert', id] });
      void qc.invalidateQueries({ queryKey: ['alerts'] });
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
  if (query.isLoading) return <Spinner />;
  if (query.error) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const a = query.data!;
  return (
    <div className="space-y-5">
      <PageHeader title={a.title} breadcrumb={<Link to="/alerts" className="text-sm text-brand-700 hover:underline">{t('← Alerts')}</Link>}
        actions={a.canManage && a.status !== 'RESOLVED' ? (
          <div className="flex gap-2">
            {a.status === 'OPEN' && <Button variant="secondary" onClick={() => setDialog('ack')}>{t('Acknowledge')}</Button>}
            <Button onClick={() => setDialog('resolve')}>{t('Resolve')}</Button>
          </div>
        ) : undefined} />
      <Card>
        <KeyValue items={[
          { label: t('Severity'), value: <SeverityBadge severity={a.severity} /> },
          { label: t('Status'), value: <StatusBadge status={a.status} /> },
          { label: t('Rule'), value: a.ruleCode, mono: true },
          { label: t('Unit'), value: a.orgUnit?.name ?? 'System-wide' },
          { label: t('Occurrences'), value: a.occurrences },
          { label: t('First seen'), value: formatDateTime(a.firstSeenAt) },
          { label: t('Last seen'), value: formatDateTime(a.lastSeenAt) },
          { label: t('Subject'), value: a.link ? <Link to={a.link} className="text-brand-700 hover:underline">{a.resourceType} {a.resourceId?.slice(0, 13)}</Link> : a.resourceId ? `${a.resourceType} ${a.resourceId}` : '—' },
          a.acknowledgedAt ? { label: t('Acknowledged'), value: `${formatDateTime(a.acknowledgedAt)} by ${a.acknowledgedBy ?? '—'}` } : null,
          a.resolvedAt ? { label: t('Resolved'), value: `${formatDateTime(a.resolvedAt)} by ${a.resolvedBy ?? '—'}` } : null,
          a.resolutionNote ? { label: t('Note'), value: a.resolutionNote } : null,
        ]} />
        <p className="mt-4 whitespace-pre-wrap text-sm text-ink-800">{a.message}</p>
      </Card>
      <Card title={t('Notification deliveries')}>
        {a.deliveries?.length ? (
          <ul className="space-y-1 text-sm">
            {a.deliveries.map((d, i) => (
              <li key={i}>
                <span className="font-mono text-xs">{d.channel}</span> · <StatusBadge status={d.status} />{d.attempt > 1 && t(' · attempt {attempt}', { attempt: d.attempt })} {d.recipients !== null && t('· {recipients} recipient(s)', { recipients: d.recipients })} {d.detail && <span className="text-ink-600">· {d.detail}</span>} · {formatDateTime(d.at)}
                {d.status === 'RETRYING' && d.nextAttemptAt && <span className="text-ink-600">{' '}{t('· next attempt')}{' '}{formatDateTime(d.nextAttemptAt)}</span>}
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-ink-600">{a.severity === 'INFO' ? t('INFO alerts are not fanned out.') : t('Not yet dispatched (the alert evaluator runs every minute).')}</p>}
      </Card>
      <ConfirmDialog open={dialog === 'ack'} title={t('Acknowledge alert')} message={t('Acknowledging tells other managers you are handling this alert. It stays open until resolved.')} confirmLabel={t('Acknowledge')}
        loading={act.isPending} error={act.error} onCancel={() => setDialog(null)} onConfirm={(note) => act.mutate({ kind: 'ack', note })} />
      <ConfirmDialog open={dialog === 'resolve'} title={t('Resolve alert')} message={t('Record what was done. The note is kept with the alert and in the audit trail.')} confirmLabel={t('Resolve')} requireReason reasonLabel={t('Resolution note')}
        loading={act.isPending} error={act.error} onCancel={() => setDialog(null)} onConfirm={(note) => act.mutate({ kind: 'resolve', note })} />
    </div>
  );
}

export function AlertRulesPage() {
  const query = useQuery({ queryKey: ['alert-rules'], queryFn: () => api.get<{ canEdit: boolean; items: AlertRule[] }>('/alerts/rules') });
  if (query.isLoading) return <Spinner />;
  if (query.error) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const { canEdit, items } = query.data!;
  return (
    <div className="space-y-5">
      <PageHeader title={t('Alert rules')} subtitle={t('Rules are evaluated every minute by the worker. Thresholds left blank fall back to system settings.')} />
      {!canEdit && <Alert tone="blue">{t('Alert rules are system-wide. Only state-level alert managers can change them; you can view the current configuration.')}</Alert>}
      <div className="grid gap-4 lg:grid-cols-2">{items.map((r) => <RuleCard key={r.code} rule={r} canEdit={canEdit} />)}</div>
    </div>
  );
}

function RuleCard({ rule, canEdit }: { rule: AlertRule; canEdit: boolean }) {
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState(rule.enabled);
  const [severity, setSeverity] = useState(rule.severity);
  const fields = RULE_FIELDS[rule.code] ?? [];
  const [cfg, setCfg] = useState<Record<string, string>>(Object.fromEntries(fields.map((f) => [f.key, rule.config[f.key] !== undefined ? String(rule.config[f.key]) : ''])));
  const [emails, setEmails] = useState((rule.emailRecipients ?? []).join(', '));
  const save = useMutation({
    mutationFn: () => api.put<AlertRule>(`/alerts/rules/${rule.code}`, {
      enabled, severity, config: Object.fromEntries(Object.entries(cfg).filter(([, v]) => v.trim() !== '').map(([k, v]) => [k, Number(v)])),
      emailRecipients: emails.split(/[\s,;]+/).filter(Boolean),
    }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['alert-rules'] }),
  });
  return (
    <Card title={<span>{rule.name} <span className="ml-1 font-mono text-xs text-ink-500">{rule.code}</span></span>}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Checkbox label={t('Enabled')} checked={enabled} onChange={setEnabled} disabled={!canEdit} />
        <Field label={t('Severity')} htmlFor={`sev-${rule.code}`}>
          <Select id={`sev-${rule.code}`} value={severity} disabled={!canEdit} onChange={(e) => setSeverity(e.target.value as AlertRule['severity'])}><option value="CRITICAL">{t('Critical')}</option><option value="WARNING">{t('Warning')}</option><option value="INFO">{t('Info')}</option></Select>
        </Field>
        {fields.map((f) => (
          <Field key={f.key} label={f.label} hint={f.hint} htmlFor={`${rule.code}-${f.key}`}>
            <Input id={`${rule.code}-${f.key}`} type="number" min={0} value={cfg[f.key] ?? ''} disabled={!canEdit} onChange={(e) => setCfg({ ...cfg, [f.key]: e.target.value })} />
          </Field>
        ))}
        <Field label={t('Extra e-mail recipients')} hint={t('Comma-separated. In addition to alert managers in scope and the Alert delivery settings.')} htmlFor={`${rule.code}-emails`}>
          <Input id={`${rule.code}-emails`} value={emails} disabled={!canEdit} onChange={(e) => setEmails(e.target.value)} />
        </Field>
        <p className="text-xs text-ink-600">{t('Last evaluated:')}{' '}{rule.lastEvaluatedAt ? formatDateTime(rule.lastEvaluatedAt) : t('never')}{' '}{t('· updated')}{' '}{formatDateTime(rule.updatedAt)}{rule.updatedBy ? t(' by {updatedBy}', { updatedBy: rule.updatedBy }) : ''}</p>
        {save.error && <Alert tone="red">{errorMessage(save.error)}</Alert>}
        {save.isSuccess && <Alert tone="green">{t('Saved.')}</Alert>}
        {canEdit && <div className="flex justify-end"><Button type="submit" loading={save.isPending}>{t('Save')}</Button></div>}
      </form>
    </Card>
  );
}

export function NotificationsPage() {
  const qc = useQueryClient();
  const [q, setQ] = useUrlState({ unread: '', page: '1' });
  const page = Number(q.page) || 1;
  const query = useQuery({ queryKey: ['notifications', 'list', q], queryFn: () => api.get<NotificationPage>('/notifications', { unread: q.unread === 'true' ? 'true' : undefined, page, pageSize: 25 }) });
  const readAll = useMutation({ mutationFn: () => api.post('/notifications/read-all'), onSuccess: () => void qc.invalidateQueries({ queryKey: ['notifications'] }) });
  const readOne = useMutation({ mutationFn: (id: string) => api.post(`/notifications/${id}/read`), onSuccess: () => void qc.invalidateQueries({ queryKey: ['notifications'] }) });
  const { can } = useAuth();
  return (
    <div className="space-y-5">
      <PageHeader title={t('Notifications')} subtitle={query.data ? t('{unread} unread', { unread: query.data.unread }) : undefined}
        actions={<Button variant="secondary" onClick={() => readAll.mutate()} loading={readAll.isPending} disabled={!query.data?.unread}>{t('Mark all read')}</Button>} />
      <Card>
        <Checkbox label={t('Unread only')} checked={q.unread === 'true'} onChange={(v) => setQ({ unread: v ? 'true' : '' })} />
        <div className="mt-3">
          {query.isLoading ? <Spinner /> : query.error ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : !query.data?.items.length ? <EmptyState title={t('No notifications')} /> : (
            <ul className="divide-y divide-ink-100">
              {query.data.items.map((n) => (
                <li key={n.id} className="flex items-start justify-between gap-3 py-2">
                  <div>
                    <p className={n.readAt ? 'text-sm text-ink-700' : 'text-sm font-semibold text-ink-900'}>
                      {!n.readAt && <span className="sr-only">{t('Unread:')}{' '}</span>}
                      {n.link && (can('alerts:read') || !n.link.startsWith('/alerts')) ? <Link to={n.link} onClick={() => !n.readAt && readOne.mutate(n.id)} className="hover:underline">{n.title}</Link> : n.title}
                    </p>
                    {n.body && <p className="text-xs text-ink-600">{n.body}</p>}
                    <p className="text-xs text-ink-500">{n.kind} · {formatDateTime(n.createdAt)}</p>
                  </div>
                  {!n.readAt && <Button variant="ghost" onClick={() => readOne.mutate(n.id)}>{t('Mark read')}</Button>}
                </li>
              ))}
            </ul>
          )}
        </div>
        {query.data && <Pagination page={page} pageSize={25} total={query.data.total} onPage={(p) => setQ({ page: String(p) })} />}
      </Card>
    </div>
  );
}
