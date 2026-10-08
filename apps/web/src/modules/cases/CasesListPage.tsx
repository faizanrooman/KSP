import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderPlus } from 'lucide-react';
import { CASE_PRIORITIES, CASE_STATUSES } from '@ksp/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useUrlState } from '@/lib/hooks';
import { formatDate, titleCase } from '@/lib/format';
import { OrgUnitSelect, UserPicker, type UserOption } from '@/components/pickers';
import { Alert, Badge, Button, Card, Checkbox, DataTable, EmptyState, Field, Input, Modal, PageHeader, Pagination, Select, StatusBadge, Textarea, type Column } from '@/components/ui';
import type { CaseDetail, CaseListItem, Fir, Paged } from './types';

import { t as tr } from '@/lib/i18n';
const DEFAULTS = { q: '', status: '', priority: '', orgUnitId: '', mine: '', openedFrom: '', openedTo: '', firId: '', sort: '-opened_at', page: '1', pageSize: '25' };

export function PriorityBadge({ priority }: { priority: string }) {
  const t = priority === 'CRITICAL' ? 'red' : priority === 'HIGH' ? 'amber' : priority === 'LOW' ? 'gray' : 'blue';
  return <Badge tone={t}>{titleCase(priority)}</Badge>;
}

export function CasesListPage() {
  const [s, set, reset] = useUrlState(DEFAULTS);
  const { can } = useAuth();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const query = useMemo(
    () => ({
      q: s.q || undefined, status: s.status || undefined, priority: s.priority || undefined, orgUnitId: s.orgUnitId || undefined, mine: s.mine || undefined,
      firId: s.firId || undefined, openedFrom: s.openedFrom ? new Date(s.openedFrom).toISOString() : undefined,
      openedTo: s.openedTo ? new Date(`${s.openedTo}T23:59:59`).toISOString() : undefined, sort: s.sort, page: s.page, pageSize: s.pageSize,
    }),
    [s],
  );
  const list = useQuery({ queryKey: ['cases', 'list', query], queryFn: () => api.get<Paged<CaseListItem>>('/cases', query), placeholderData: keepPreviousData });
  const filtered = !!(s.q || s.status || s.priority || s.orgUnitId || s.mine || s.openedFrom || s.openedTo || s.firId);

  const cols: Column<CaseListItem>[] = [
    {
      key: 'case', header: tr('Case'), sortKey: 'case_number',
      render: (r) => (
        <div>
          <Link to={`/cases/${r.id}`} className="mono font-medium text-brand-800 hover:underline" onClick={(e) => e.stopPropagation()}>{r.caseNumber}</Link>
          <p className="line-clamp-2 min-w-[14rem] max-w-md text-sm text-ink-800" title={r.title}>{r.title}</p>
        </div>
      ),
    },
    { key: 'fir', header: tr('FIR'), render: (r) => (r.fir ? <Link className="mono text-sm text-brand-700 hover:underline" to={`/firs/${r.fir.id}`} onClick={(e) => e.stopPropagation()}>{r.fir.displayNumber}</Link> : <span className="text-ink-400">—</span>) },
    { key: 'station', header: tr('Station'), render: (r) => r.orgUnit.name },
    { key: 'io', header: tr('Investigating officer'), render: (r) => r.investigatingOfficer?.fullName ?? <span className="text-ink-500">{tr('Unassigned')}</span> },
    { key: 'priority', header: tr('Priority'), sortKey: 'priority', render: (r) => <PriorityBadge priority={r.priority} /> },
    { key: 'status', header: tr('Status'), sortKey: 'status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'ev', header: tr('Evidence'), render: (r) => <span className="tabular-nums">{r.evidenceCount}</span> },
    { key: 'opened', header: tr('Opened'), sortKey: 'opened_at', render: (r) => <span className="whitespace-nowrap text-sm">{formatDate(r.openedAt)}</span> },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title={tr('Cases')}
        subtitle={tr('Cases in your jurisdiction and cases where you are on the team.')}
        actions={can('cases:manage') ? <Button icon={<FolderPlus className="h-4 w-4" />} onClick={() => setCreating(true)}>{tr('New case')}</Button> : undefined}
      />
      <Card>
        <form className="grid gap-3 md:grid-cols-3 xl:grid-cols-6" onSubmit={(e) => { e.preventDefault(); set({ q: String(new FormData(e.currentTarget).get('q') ?? '').trim() }); }}>
          <div className="md:col-span-2">
            <Field label={tr('Search')} htmlFor="c-q"><Input id="c-q" name="q" defaultValue={s.q} key={s.q} placeholder={tr('Title, case number, FIR no., court case no.…')} /></Field>
          </div>
          <Field label={tr('Status')} htmlFor="c-status">
            <Select id="c-status" value={s.status} onChange={(e) => set({ status: e.target.value })}>
              <option value="">{tr('All statuses')}</option>
              {CASE_STATUSES.map((x) => <option key={x} value={x}>{titleCase(x)}</option>)}
            </Select>
          </Field>
          <Field label={tr('Priority')} htmlFor="c-pri">
            <Select id="c-pri" value={s.priority} onChange={(e) => set({ priority: e.target.value })}>
              <option value="">{tr('Any priority')}</option>
              {CASE_PRIORITIES.map((x) => <option key={x} value={x}>{titleCase(x)}</option>)}
            </Select>
          </Field>
          <Field label={tr('Station / unit')} htmlFor="c-org"><OrgUnitSelect id="c-org" scope="cases:read" value={s.orgUnitId} onChange={(v) => set({ orgUnitId: v })} /></Field>
          <div className="flex items-end pb-2"><Checkbox label={tr('My cases (team)')} checked={s.mine === 'true'} onChange={(v) => set({ mine: v ? 'true' : '' })} /></div>
          <Field label={tr('Opened from')} htmlFor="c-from"><Input id="c-from" type="date" value={s.openedFrom} onChange={(e) => set({ openedFrom: e.target.value })} /></Field>
          <Field label={tr('Opened to')} htmlFor="c-to"><Input id="c-to" type="date" value={s.openedTo} onChange={(e) => set({ openedTo: e.target.value })} /></Field>
          <div className="flex items-end gap-2 md:col-span-3 xl:col-span-4">
            <Button type="submit">{tr('Search')}</Button>
            {filtered && <Button variant="ghost" onClick={reset}>{tr('Clear filters')}</Button>}
          </div>
        </form>
      </Card>
      <Card bodyClassName="p-0">
        <DataTable
          caption={tr('Cases')}
          columns={cols}
          rows={list.data?.items}
          rowKey={(r) => r.id}
          loading={list.isFetching}
          error={list.error}
          onRetry={() => void list.refetch()}
          sort={s.sort}
          onSort={(sort) => set({ sort })}
          onRowClick={(r) => navigate(`/cases/${r.id}`)}
          empty={<EmptyState title={filtered ? 'No cases match these filters' : 'No cases yet'} action={filtered ? <Button variant="secondary" onClick={reset}>{tr('Clear filters')}</Button> : undefined} />}
        />
        {list.data && <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={(p) => set({ page: String(p) })} />}
      </Card>
      <CreateCaseModal open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

/** FIR search select (FIRs visible to the user). */
export function FirSelect({ value, onChange, id }: { value: Fir | null; onChange: (f: Fir | null) => void; id?: string }) {
  const [q, setQ] = useState('');
  const res = useQuery({ queryKey: ['firs', 'pick', q], queryFn: () => api.get<Paged<Fir>>('/firs', { q: q || undefined, pageSize: 10 }), enabled: q.length >= 1 });
  if (value) {
    return (
      <div className="flex items-center justify-between rounded-md border border-ink-300 bg-white px-3 py-2 text-sm">
        <span><span className="mono">{value.displayNumber}</span> · {value.orgUnit.name}</span>
        <button type="button" className="text-xs text-brand-700 hover:underline" onClick={() => onChange(null)}>{tr('Change')}</button>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <Input id={id} placeholder={tr('Type FIR number, complainant…')} value={q} onChange={(e) => setQ(e.target.value)} />
      {q && (
        <ul className="max-h-48 overflow-y-auto rounded-md border border-ink-200 bg-white text-sm" aria-label={tr('Matching FIRs')}>
          {res.isFetching && !res.data && <li className="px-3 py-2 text-ink-500">{tr('Searching…')}</li>}
          {res.data?.items.length === 0 && <li className="px-3 py-2 text-ink-500">{tr('No FIRs found')}</li>}
          {res.data?.items.map((f) => (
            <li key={f.id}>
              <button type="button" className="w-full px-3 py-1.5 text-left hover:bg-brand-50" onClick={() => { onChange(f); setQ(''); }}>
                <span className="mono">{f.displayNumber}</span> · {f.orgUnit.name} <span className="text-ink-500">{f.actsSections.join(', ')}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function CreateCaseModal({ open, onClose, initialFir }: { open: boolean; onClose: () => void; initialFir?: Fir | null }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('NORMAL');
  const [orgUnitId, setOrgUnitId] = useState('');
  const [fir, setFir] = useState<Fir | null>(initialFir ?? null);
  const [io, setIo] = useState<UserOption | null>(null);
  const [sup, setSup] = useState<UserOption | null>(null);
  const m = useMutation({
    mutationFn: () =>
      api.post<CaseDetail>('/cases', {
        title: title.trim(), description: description.trim() || null, priority, orgUnitId: orgUnitId || undefined, firId: fir?.id ?? null,
        ...(io ? { investigatingOfficerId: io.id } : {}), supervisorId: sup?.id ?? null,
      }),
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: ['cases'] });
      onClose();
      navigate(`/cases/${c.id}`);
    },
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={tr('Open a new case')}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={m.isPending}>{tr('Cancel')}</Button>
          <Button onClick={() => m.mutate()} loading={m.isPending} disabled={title.trim().length < 3}>{tr('Create case')}</Button>
        </>
      }
    >
      <div className="grid gap-3 md:grid-cols-2">
        <div className="md:col-span-2"><Field label={tr('Title')} required htmlFor="nc-title"><Input id="nc-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} /></Field></div>
        <div className="md:col-span-2"><Field label={tr('Description')} htmlFor="nc-desc"><Textarea id="nc-desc" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} /></Field></div>
        <Field label={tr('Linked FIR')} htmlFor="nc-fir" hint={tr('Optional. The case station defaults to the FIR\'s station.')}><FirSelect id="nc-fir" value={fir} onChange={setFir} /></Field>
        <Field label={tr('Station')} htmlFor="nc-org" hint={tr('Defaults to the FIR station or your home unit.')}><OrgUnitSelect id="nc-org" scope="cases:manage" value={orgUnitId} onChange={setOrgUnitId} emptyLabel={tr('Default')} stationsOnly /></Field>
        <Field label={tr('Priority')} htmlFor="nc-pri">
          <Select id="nc-pri" value={priority} onChange={(e) => setPriority(e.target.value)}>
            {CASE_PRIORITIES.map((x) => <option key={x} value={x}>{titleCase(x)}</option>)}
          </Select>
        </Field>
        <div />
        <Field label={tr('Investigating officer')} htmlFor="nc-io" hint={tr('Defaults to you. Must belong to the case station or a unit above it.')}><UserPicker id="nc-io" value={io} onChange={setIo} /></Field>
        <Field label={tr('Supervisor')} htmlFor="nc-sup"><UserPicker id="nc-sup" value={sup} onChange={setSup} /></Field>
      </div>
      {m.error ? <div className="mt-3"><Alert tone="red">{(m.error as Error).message}</Alert></div> : null}
    </Modal>
  );
}
