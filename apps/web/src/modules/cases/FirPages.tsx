import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CloudDownload, FilePlus2, FolderPlus } from 'lucide-react';
import { FIR_STATUSES } from '@ksp/shared';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useUrlState } from '@/lib/hooks';
import { formatDate, formatDateTime, titleCase } from '@/lib/format';
import { OrgUnitSelect } from '@/components/pickers';
import { Alert, Badge, Button, Card, DataTable, EmptyState, ErrorState, Field, Input, KeyValue, Modal, PageHeader, Pagination, Select, Spinner, StatusBadge, Textarea, useToast, type Column } from '@/components/ui';
import { CreateCaseModal } from './CasesListPage';
import type { Fir, FirDetail, Paged } from './types';

const DEFAULTS = { q: '', orgUnitId: '', year: '', status: '', actSection: '', sort: '-registered_at', page: '1', pageSize: '25' };

export function VerificationBadge({ status }: { status: 'VERIFIED' | 'UNVERIFIED' | 'FIXTURE' | string }) {
  if (status === 'VERIFIED') return <Badge tone="green">Verified</Badge>;
  if (status === 'FIXTURE') return <Badge tone="purple">Fixture data</Badge>;
  return <Badge tone="amber">UNVERIFIED</Badge>;
}

export function FirListPage() {
  const [s, set, reset] = useUrlState(DEFAULTS);
  const { can } = useAuth();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const query = useMemo(() => ({ q: s.q || undefined, orgUnitId: s.orgUnitId || undefined, year: /^\d{4}$/.test(s.year) ? s.year : undefined, status: s.status || undefined, actSection: s.actSection || undefined, sort: s.sort, page: s.page, pageSize: s.pageSize }), [s]);
  const list = useQuery({ queryKey: ['firs', 'list', query], queryFn: () => api.get<Paged<Fir>>('/firs', query), placeholderData: keepPreviousData });
  const filtered = !!(s.q || s.orgUnitId || s.year || s.status || s.actSection);
  const cols: Column<Fir>[] = [
    { key: 'no', header: 'FIR', sortKey: 'fir_number', render: (r) => <Link className="mono font-medium text-brand-800 hover:underline" to={`/firs/${r.id}`} onClick={(e) => e.stopPropagation()}>{r.displayNumber}</Link> },
    { key: 'station', header: 'Station', render: (r) => r.orgUnit.name },
    { key: 'reg', header: 'Registered', sortKey: 'registered_at', render: (r) => <span className="whitespace-nowrap text-sm">{formatDateTime(r.registeredAt)}</span> },
    { key: 'acts', header: 'Acts / sections', render: (r) => <span className="text-sm">{r.actsSections.join(', ') || '—'}</span> },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'source', header: 'Source', render: (r) => <Badge tone={r.source === 'MANUAL' ? 'gray' : 'blue'}>{titleCase(r.source)}</Badge> },
    { key: 'cases', header: 'Cases', render: (r) => <span className="tabular-nums">{r.caseCount ?? 0}</span> },
  ];
  return (
    <div className="space-y-4">
      <PageHeader
        title="First Information Reports"
        subtitle="FIRs registered at stations in your jurisdiction."
        actions={can('cases:manage') ? (
          <div className="flex gap-2">
            <Button variant="secondary" icon={<CloudDownload className="h-4 w-4" />} onClick={() => setImporting(true)}>Import from CCTNS</Button>
            <Button icon={<FilePlus2 className="h-4 w-4" />} onClick={() => setCreating(true)}>Register FIR</Button>
          </div>
        ) : undefined}
      />
      <Card>
        <form className="grid gap-3 md:grid-cols-3 xl:grid-cols-6" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); set({ q: String(f.get('q') ?? '').trim(), actSection: String(f.get('act') ?? '').trim() }); }}>
          <div className="md:col-span-2"><Field label="Search" htmlFor="f-q"><Input id="f-q" name="q" defaultValue={s.q} key={s.q} placeholder="FIR number, complainant, facts…" /></Field></div>
          <Field label="Station" htmlFor="f-org"><OrgUnitSelect id="f-org" value={s.orgUnitId} onChange={(v) => set({ orgUnitId: v })} /></Field>
          <Field label="Year" htmlFor="f-year"><Input id="f-year" type="number" min={1950} max={2200} value={s.year} onChange={(e) => set({ year: e.target.value })} /></Field>
          <Field label="Status" htmlFor="f-status">
            <Select id="f-status" value={s.status} onChange={(e) => set({ status: e.target.value })}>
              <option value="">All statuses</option>
              {FIR_STATUSES.map((x) => <option key={x} value={x}>{titleCase(x)}</option>)}
            </Select>
          </Field>
          <Field label="Act / section" htmlFor="f-act"><Input id="f-act" name="act" defaultValue={s.actSection} key={s.actSection} placeholder="e.g. BNS 303" /></Field>
          <div className="flex items-end gap-2 md:col-span-3 xl:col-span-6">
            <Button type="submit">Search</Button>
            {filtered && <Button variant="ghost" onClick={reset}>Clear filters</Button>}
          </div>
        </form>
      </Card>
      <Card bodyClassName="p-0">
        <DataTable caption="FIRs" columns={cols} rows={list.data?.items} rowKey={(r) => r.id} loading={list.isFetching} error={list.error} onRetry={() => void list.refetch()} sort={s.sort} onSort={(sort) => set({ sort })} onRowClick={(r) => navigate(`/firs/${r.id}`)} empty={<EmptyState title={filtered ? 'No FIRs match these filters' : 'No FIRs yet'} />} />
        {list.data && <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={(p) => set({ page: String(p) })} />}
      </Card>
      {creating && <FirFormModal onClose={() => setCreating(false)} />}
      {importing && <ImportFirModal onClose={() => setImporting(false)} />}
    </div>
  );
}

function FirFormModal({ fir, onClose }: { fir?: FirDetail; onClose: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const local = (v: string | null | undefined) => (v ? new Date(new Date(v).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
  const [f, setF] = useState({
    firNumber: fir?.firNumber ?? '', firYear: String(fir?.firYear ?? new Date().getFullYear()), orgUnitId: fir?.orgUnit.id ?? '', registeredAt: local(fir?.registeredAt),
    acts: fir?.actsSections.join('; ') ?? '', complainant: fir?.complainant ?? '', briefFacts: fir?.briefFacts ?? '', place: fir?.placeOfOccurrence ?? '',
    from: local(fir?.occurredFrom), to: local(fir?.occurredTo),
  });
  const upd = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const iso = (v: string) => (v ? new Date(v).toISOString() : null);
  const m = useMutation({
    mutationFn: () => {
      const common = {
        registeredAt: iso(f.registeredAt), actsSections: f.acts.split(/[;\n]/).map((x) => x.trim()).filter(Boolean), complainant: f.complainant.trim() || null,
        briefFacts: f.briefFacts.trim() || null, placeOfOccurrence: f.place.trim() || null, occurredFrom: iso(f.from), occurredTo: iso(f.to),
      };
      return fir ? api.patch<Fir>(`/firs/${fir.id}`, common) : api.post<Fir>('/firs', { ...common, firNumber: f.firNumber.trim(), firYear: Number(f.firYear), orgUnitId: f.orgUnitId });
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['firs'] });
      toast.success(fir ? 'FIR updated' : 'FIR registered');
      onClose();
      if (!fir) navigate(`/firs/${r.id}`);
    },
  });
  const valid = f.registeredAt && (fir || (f.firNumber.trim() && f.orgUnitId && f.firYear));
  return (
    <Modal open onClose={onClose} title={fir ? `Edit FIR ${fir.displayNumber}` : 'Register FIR'} size="lg" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => m.mutate()} loading={m.isPending} disabled={!valid}>{fir ? 'Save' : 'Register'}</Button></>}>
      <div className="grid gap-3 md:grid-cols-3">
        {!fir && (
          <>
            <Field label="FIR number" required htmlFor="fr-no"><Input id="fr-no" value={f.firNumber} onChange={upd('firNumber')} placeholder="0142" /></Field>
            <Field label="Year" required htmlFor="fr-year"><Input id="fr-year" type="number" value={f.firYear} onChange={upd('firYear')} /></Field>
            <Field label="Station" required htmlFor="fr-org"><OrgUnitSelect id="fr-org" value={f.orgUnitId} onChange={(v) => setF((x) => ({ ...x, orgUnitId: v }))} stationsOnly emptyLabel="Select station" /></Field>
          </>
        )}
        <Field label="Registered at" required htmlFor="fr-reg"><Input id="fr-reg" type="datetime-local" value={f.registeredAt} onChange={upd('registeredAt')} /></Field>
        <Field label="Occurred from" htmlFor="fr-from"><Input id="fr-from" type="datetime-local" value={f.from} onChange={upd('from')} /></Field>
        <Field label="Occurred to" htmlFor="fr-to"><Input id="fr-to" type="datetime-local" value={f.to} onChange={upd('to')} /></Field>
        <div className="md:col-span-3"><Field label="Acts / sections" htmlFor="fr-acts" hint="Separate with semicolons, e.g. BNS 303(2); BNS 115(2)"><Input id="fr-acts" value={f.acts} onChange={upd('acts')} /></Field></div>
        <div className="md:col-span-3"><Field label="Complainant" htmlFor="fr-comp"><Input id="fr-comp" value={f.complainant} onChange={upd('complainant')} /></Field></div>
        <div className="md:col-span-3"><Field label="Place of occurrence" htmlFor="fr-place"><Input id="fr-place" value={f.place} onChange={upd('place')} /></Field></div>
        <div className="md:col-span-3"><Field label="Brief facts" htmlFor="fr-facts"><Textarea id="fr-facts" rows={4} value={f.briefFacts} onChange={upd('briefFacts')} /></Field></div>
      </div>
      {m.error ? <div className="mt-3"><Alert tone="red">{errorMessage(m.error)}</Alert></div> : null}
    </Modal>
  );
}

interface FirSource { id: string; code: string; name: string; systemType: string; adapter: string; verified: boolean; verificationStatus: string }

export function ImportFirModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const sources = useQuery({ queryKey: ['integrations', 'fir-sources'], queryFn: () => api.get<{ items: FirSource[] }>('/integrations/systems/fir-sources') });
  const [systemId, setSystemId] = useState('');
  const [stationCode, setStationCode] = useState('');
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [firNumber, setFirNumber] = useState('');
  const sys = sources.data?.items.find((s) => s.id === (systemId || sources.data?.items[0]?.id));
  const m = useMutation({
    mutationFn: () => api.post<{ fir: Fir; created: boolean; systemVerified: boolean }>('/firs/import', { systemId: sys!.id, stationCode: stationCode.trim(), year: Number(year), firNumber: firNumber.trim() }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['firs'] });
      toast.success(r.created ? `FIR ${r.fir.displayNumber} imported` : `FIR ${r.fir.displayNumber} refreshed from source`);
      onClose();
      navigate(`/firs/${r.fir.id}`);
    },
  });
  return (
    <Modal open onClose={onClose} title="Import FIR from CCTNS / FIR system" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => m.mutate()} loading={m.isPending} disabled={!sys || !stationCode.trim() || !firNumber.trim() || !year}>Import</Button></>}>
      {sources.isLoading ? <Spinner /> : sources.error ? <ErrorState error={sources.error} onRetry={() => void sources.refetch()} /> : !sources.data?.items.length ? (
        <EmptyState title="No FIR sources configured" description="An administrator must configure and enable a CCTNS/FIR integration first." />
      ) : (
        <div className="space-y-3">
          <Field label="Source system" htmlFor="im-sys">
            <Select id="im-sys" value={sys?.id ?? ''} onChange={(e) => setSystemId(e.target.value)}>
              {sources.data.items.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.adapter})</option>)}
            </Select>
          </Field>
          {sys && (
            <div className="flex items-center gap-2 text-sm">Integration status: <VerificationBadge status={sys.verificationStatus} /></div>
          )}
          {sys && sys.verificationStatus !== 'VERIFIED' && (
            <Alert tone="amber" title={sys.verificationStatus === 'FIXTURE' ? 'Fixture data' : 'Unverified integration'}>
              {sys.verificationStatus === 'FIXTURE'
                ? 'This source returns synthetic fixture records for development/testing. Do not use for real investigations.'
                : 'The external API contract for this system has not been verified by a live contract test. Check imported data against the source record.'}
            </Alert>
          )}
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Station code (source)" required htmlFor="im-st"><Input id="im-st" value={stationCode} onChange={(e) => setStationCode(e.target.value)} placeholder="ps_cubbonpark" /></Field>
            <Field label="Year" required htmlFor="im-year"><Input id="im-year" type="number" value={year} onChange={(e) => setYear(e.target.value)} /></Field>
            <Field label="FIR number" required htmlFor="im-no"><Input id="im-no" value={firNumber} onChange={(e) => setFirNumber(e.target.value)} /></Field>
          </div>
          {m.error ? <Alert tone="red">{errorMessage(m.error)}{m.error instanceof ApiError && m.error.code.startsWith('INTEGRATION_') ? ` (${m.error.code.replace('INTEGRATION_', '')})` : ''}</Alert> : null}
        </div>
      )}
    </Modal>
  );
}

export function FirDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [newCase, setNewCase] = useState(false);
  const [statusTo, setStatusTo] = useState('');
  const [reason, setReason] = useState('');
  const q = useQuery({ queryKey: ['firs', 'detail', id], queryFn: () => api.get<FirDetail>(`/firs/${id}`), retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2 });
  const sm = useMutation({
    mutationFn: () => api.post(`/firs/${id}/status`, { status: statusTo, reason: reason.trim() }),
    onSuccess: () => {
      toast.success('FIR status updated');
      setStatusTo('');
      setReason('');
      void qc.invalidateQueries({ queryKey: ['firs'] });
    },
  });
  if (q.isLoading) return <Spinner label="Loading FIR…" />;
  if (q.error) {
    if (q.error instanceof ApiError && q.error.status === 404) return <EmptyState heading="h1" title="FIR not found" description="It does not exist or is outside your jurisdiction." action={<Link className="text-brand-700 hover:underline" to="/firs">Back to FIRs</Link>} />;
    return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  }
  const f = q.data!;
  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumb={<Link to="/firs" className="text-brand-700 hover:underline">FIRs</Link>}
        title={<span>FIR <span className="mono">{f.displayNumber}</span></span>}
        subtitle={<span className="flex items-center gap-2"><StatusBadge status={f.status} /> {f.orgUnit.name} · registered {formatDate(f.registeredAt)}</span>}
        actions={f.permissions.canManage ? (
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setEditing(true)}>Edit</Button>
            {can('cases:manage') && <Button icon={<FolderPlus className="h-4 w-4" />} onClick={() => setNewCase(true)}>Open case</Button>}
          </div>
        ) : undefined}
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="FIR details" className="lg:col-span-2">
          <KeyValue
            items={[
              { label: 'Acts / sections', value: f.actsSections.join(', ') || '—' },
              { label: 'Complainant', value: f.complainant ?? '—' },
              { label: 'Place of occurrence', value: f.placeOfOccurrence ?? '—' },
              { label: 'Occurred', value: f.occurredFrom ? `${formatDateTime(f.occurredFrom)}${f.occurredTo ? ` – ${formatDateTime(f.occurredTo)}` : ''}` : '—' },
              { label: 'Source', value: titleCase(f.source) },
              { label: 'External reference', value: f.externalRef ?? '—', mono: true },
            ]}
          />
          {f.briefFacts && <p className="mt-4 whitespace-pre-wrap text-sm">{f.briefFacts}</p>}
          {f.source !== 'MANUAL' && <div className="mt-3"><Alert tone="blue">Imported from an external system. Verify against the source record before relying on it in court documents.</Alert></div>}
        </Card>
        <div className="space-y-4">
          <Card title="Cases">
            {f.cases.length ? (
              <ul className="space-y-2 text-sm">
                {f.cases.map((c) => <li key={c.id}><Link className="mono text-brand-700 hover:underline" to={`/cases/${c.id}`}>{c.caseNumber}</Link> {c.title} <StatusBadge status={c.status} /></li>)}
              </ul>
            ) : <EmptyState title="No cases for this FIR" />}
          </Card>
          {f.permissions.canManage && f.allowedTransitions.length > 0 && (
            <Card title="Change FIR status">
              <div className="space-y-2">
                <Field label="New status" htmlFor="fs-to"><Select id="fs-to" value={statusTo} onChange={(e) => setStatusTo(e.target.value)}><option value="">Select…</option>{f.allowedTransitions.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}</Select></Field>
                <Field label="Reason" required htmlFor="fs-reason"><Textarea id="fs-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
                <Button disabled={!statusTo || reason.trim().length < 5} loading={sm.isPending} onClick={() => sm.mutate()}>Update status</Button>
                {sm.error ? <Alert tone="red">{errorMessage(sm.error)}</Alert> : null}
              </div>
            </Card>
          )}
        </div>
      </div>
      {editing && <FirFormModal fir={f} onClose={() => setEditing(false)} />}
      <CreateCaseModal open={newCase} onClose={() => setNewCase(false)} initialFir={f} />
    </div>
  );
}
