import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { Alert, Badge, Button, Card, Checkbox, ConfirmDialog, DataTable, EmptyState, Field, Input, Select, useToast, type Column } from '@/components/ui';
import { OrgUnitSelect, UserPicker, type UserOption } from '@/components/pickers';

export interface ReportTypeOption { code: string; title: string; available: boolean; extraParams: string[] }
interface Schedule {
  id: string; name: string; reportType: string; title: string; format: string; frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'CRON'; cron: string; timezone: string;
  lookbackDays: number; hour?: number; minute?: number; dayOfWeek?: number; dayOfMonth?: number;
  orgUnit: { id: string; name: string | null } | null; recipients: Array<{ id: string; fullName: string | null }>;
  emailRecipients: boolean; enabled: boolean; nextRunAt: string | null; lastRunAt: string | null; lastError: string | null;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function describe(s: Schedule): string {
  const t = `${String(s.hour ?? 6).padStart(2, '0')}:${String(s.minute ?? 0).padStart(2, '0')}`;
  if (s.frequency === 'DAILY') return `Daily at ${t}`;
  if (s.frequency === 'WEEKLY') return `Weekly, ${DAYS[s.dayOfWeek ?? 1]} at ${t}`;
  if (s.frequency === 'MONTHLY') return `Monthly, day ${s.dayOfMonth ?? 1} at ${t}`;
  return `cron ${s.cron}`;
}

/** Scheduled (recurring) reports owned by the current user: list, pause/resume, delete, create. */
export function SchedulesCard({ types, formats }: { types: ReportTypeOption[]; formats: string[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ['report-schedules'], queryFn: () => api.get<{ items: Schedule[] }>('/reports/schedules') });
  const [open, setOpen] = useState(false);
  const [del, setDel] = useState<Schedule | null>(null);
  const [f, setF] = useState({ name: '', reportType: '', format: 'CSV', frequency: 'DAILY' as Schedule['frequency'], time: '06:00', dayOfWeek: '1', dayOfMonth: '1', cron: '0 6 * * *', orgUnitId: '', emailRecipients: true, lookbackDays: '' });
  const [recipients, setRecipients] = useState<UserOption[]>([]);
  const [pick, setPick] = useState<UserOption | null>(null);
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['report-schedules'] });
  const create = useMutation({
    mutationFn: () => {
      const [h, m] = f.time.split(':').map(Number);
      return api.post<Schedule>('/reports/schedules', {
        name: f.name, reportType: f.reportType, format: f.format, frequency: f.frequency, hour: h, minute: m,
        ...(f.frequency === 'WEEKLY' ? { dayOfWeek: Number(f.dayOfWeek) } : {}), ...(f.frequency === 'MONTHLY' ? { dayOfMonth: Number(f.dayOfMonth) } : {}),
        ...(f.frequency === 'CRON' ? { cron: f.cron } : {}), ...(f.lookbackDays ? { lookbackDays: Number(f.lookbackDays) } : {}),
        orgUnitId: f.orgUnitId || null, recipientIds: recipients.map((r) => r.id), emailRecipients: f.emailRecipients,
      });
    },
    onSuccess: () => { toast.success('Schedule created'); setOpen(false); setRecipients([]); setF({ ...f, name: '' }); invalidate(); },
  });
  const toggle = useMutation({ mutationFn: (s: Schedule) => api.patch<Schedule>(`/reports/schedules/${s.id}`, { enabled: !s.enabled }), onSuccess: invalidate, onError: (e) => toast.error(e) });
  const remove = useMutation({ mutationFn: (s: Schedule) => api.delete(`/reports/schedules/${s.id}`), onSuccess: () => { setDel(null); toast.success('Schedule deleted'); invalidate(); } });

  const cols: Column<Schedule>[] = [
    { key: 'name', header: 'Schedule', render: (s) => <div><div className="font-medium text-ink-900">{s.name}</div><div className="text-xs text-ink-600">{s.title} · {s.format}{s.orgUnit?.name ? ` · ${s.orgUnit.name}` : ''}</div></div> },
    { key: 'when', header: 'When', render: (s) => <div><div>{describe(s)}</div><div className="text-xs text-ink-600">{s.timezone} · last {s.lookbackDays} day(s)</div></div> },
    { key: 'next', header: 'Next run', render: (s) => (s.enabled ? (s.nextRunAt ? formatDateTime(s.nextRunAt) : '—') : <Badge>Paused</Badge>), className: 'whitespace-nowrap' },
    { key: 'last', header: 'Last run', render: (s) => <div>{s.lastRunAt ? formatDateTime(s.lastRunAt) : 'never'}{s.lastError && <div className="text-xs text-red-700">{s.lastError}</div>}</div> },
    { key: 'to', header: 'Recipients', render: (s) => (s.recipients.length ? s.recipients.map((r) => r.fullName ?? r.id.slice(0, 8)).join(', ') : 'only me') + (s.emailRecipients ? ' (+ e-mail)' : '') },
    {
      key: 'act', header: <span className="sr-only">Actions</span>,
      render: (s) => (
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => toggle.mutate(s)} loading={toggle.isPending && toggle.variables?.id === s.id}>{s.enabled ? 'Pause' : 'Resume'}</Button>
          <Button size="sm" variant="ghost" onClick={() => { remove.reset(); setDel(s); }}>Delete</Button>
        </div>
      ),
    },
  ];
  const selected = types.find((t) => t.code === f.reportType);
  return (
    <Card title="Scheduled reports" actions={<Button size="sm" variant={open ? 'ghost' : 'secondary'} onClick={() => setOpen(!open)}>{open ? 'Cancel' : 'New schedule'}</Button>}>
      <p className="mb-3 text-sm text-ink-600">Runs are created automatically under <strong>your</strong> jurisdiction as it is at run time. You and the recipients are notified when a run is ready; recipients must be allowed to run the same report over the same area themselves.</p>
      {open && (
        <form className="mb-4 space-y-3 rounded-lg border border-ink-100 p-3" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Name" htmlFor="sch-name" required><Input id="sch-name" value={f.name} required maxLength={200} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Report type" htmlFor="sch-type" required>
              <Select id="sch-type" value={f.reportType} required onChange={(e) => setF({ ...f, reportType: e.target.value })}>
                <option value="">Choose…</option>
                {types.map((t) => <option key={t.code} value={t.code} disabled={!t.available}>{t.title}{t.available ? '' : ' (not permitted)'}</option>)}
              </Select>
            </Field>
            <Field label="Format" htmlFor="sch-format"><Select id="sch-format" value={f.format} onChange={(e) => setF({ ...f, format: e.target.value })}>{formats.map((x) => <option key={x}>{x}</option>)}</Select></Field>
            <Field label="Frequency" htmlFor="sch-freq">
              <Select id="sch-freq" value={f.frequency} onChange={(e) => setF({ ...f, frequency: e.target.value as Schedule['frequency'] })}>
                <option value="DAILY">Daily</option><option value="WEEKLY">Weekly</option><option value="MONTHLY">Monthly</option><option value="CRON">Custom (cron)</option>
              </Select>
            </Field>
            {f.frequency === 'CRON'
              ? <Field label="Cron expression" htmlFor="sch-cron" hint="minute hour day month weekday — at most hourly"><Input id="sch-cron" value={f.cron} onChange={(e) => setF({ ...f, cron: e.target.value })} /></Field>
              : <Field label="Time (IST)" htmlFor="sch-time"><Input id="sch-time" type="time" value={f.time} required onChange={(e) => setF({ ...f, time: e.target.value })} /></Field>}
            {f.frequency === 'WEEKLY' && <Field label="Day of week" htmlFor="sch-dow"><Select id="sch-dow" value={f.dayOfWeek} onChange={(e) => setF({ ...f, dayOfWeek: e.target.value })}>{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</Select></Field>}
            {f.frequency === 'MONTHLY' && <Field label="Day of month" htmlFor="sch-dom" hint="1–28"><Input id="sch-dom" type="number" min={1} max={28} value={f.dayOfMonth} onChange={(e) => setF({ ...f, dayOfMonth: e.target.value })} /></Field>}
            <Field label="Period covered (days)" htmlFor="sch-lookback" hint="Default: 1 / 7 / 31 by frequency"><Input id="sch-lookback" type="number" min={1} max={1098} value={f.lookbackDays} onChange={(e) => setF({ ...f, lookbackDays: e.target.value })} /></Field>
            <Field label="Station / unit" htmlFor="sch-org"><OrgUnitSelect id="sch-org" value={f.orgUnitId} onChange={(v) => setF({ ...f, orgUnitId: v })} emptyLabel="All in my jurisdiction" /></Field>
            <Field label="Add recipient" htmlFor="sch-rcpt">
              <UserPicker id="sch-rcpt" value={pick} onChange={(u) => { if (u && !recipients.some((r) => r.id === u.id)) setRecipients([...recipients, u]); setPick(null); }} />
            </Field>
          </div>
          {recipients.length > 0 && (
            <ul className="flex flex-wrap gap-2" aria-label="Recipients">
              {recipients.map((r) => <li key={r.id}><Badge tone="blue">{r.fullName} <button type="button" className="ml-1 underline" aria-label={`Remove ${r.fullName}`} onClick={() => setRecipients(recipients.filter((x) => x.id !== r.id))}>×</button></Badge></li>)}
            </ul>
          )}
          <Checkbox label="Also e-mail me and the recipients a sign-in link when a run is ready" checked={f.emailRecipients} onChange={(v) => setF({ ...f, emailRecipients: v })} />
          {selected?.extraParams.length ? <p className="text-xs text-ink-600">This report&apos;s optional parameters use their defaults in schedules.</p> : null}
          {create.error && <Alert tone="red">{errorMessage(create.error)}</Alert>}
          <Button type="submit" disabled={!f.name || !f.reportType} loading={create.isPending}>Create schedule</Button>
        </form>
      )}
      <DataTable columns={cols} rows={list.data?.items} rowKey={(s) => s.id} loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()} caption="My scheduled reports"
        empty={<EmptyState title="No scheduled reports" description="Create a schedule to receive a report daily, weekly or monthly." />} />
      <ConfirmDialog open={!!del} title="Delete schedule" message={`Delete “${del?.name ?? ''}”? Past runs are kept.`} confirmLabel="Delete" variant="danger"
        loading={remove.isPending} error={remove.error} onConfirm={() => del && remove.mutate(del)} onCancel={() => setDel(null)} />
    </Card>
  );
}
