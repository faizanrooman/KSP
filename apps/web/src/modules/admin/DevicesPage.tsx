import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, Plus, UserMinus, UserPlus } from 'lucide-react';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useUrlState } from '@/lib/hooks';
import { formatDateTime, titleCase } from '@/lib/format';
import { OrgUnitSelect, UserPicker, type UserOption } from '@/components/pickers';
import { Alert, Button, Card, ConfirmDialog, DataTable, EmptyState, ErrorState, Field, Input, KeyValue, Modal, PageHeader, Pagination, Select, Spinner, StatusBadge, Textarea, useToast, type Column } from '@/components/ui';
import { DEVICE_STATUSES, DEVICE_TYPES, type Device, type DeviceDetail, type Paged } from './types';

const DEFAULTS = { q: '', type: '', status: '', orgUnitId: '', assigned: '', sort: 'serialNumber', page: '1', pageSize: '25' };

interface Form {
  serialNumber: string;
  deviceType: string;
  make: string;
  model: string;
  firmwareVersion: string;
  orgUnitId: string;
  status: string;
  notes: string;
}

function DeviceModal({ device, onClose }: { device: Device | null; onClose: (created?: Device) => void }) {
  const isNew = !device;
  const [f, setF] = useState<Form>(device
    ? { serialNumber: device.serialNumber, deviceType: device.deviceType, make: device.make ?? '', model: device.model ?? '', firmwareVersion: device.firmwareVersion ?? '', orgUnitId: device.orgUnit.id, status: device.status, notes: device.notes ?? '' }
    : { serialNumber: '', deviceType: 'BODY_WORN_CAMERA', make: '', model: '', firmwareVersion: '', orgUnitId: '', status: 'ACTIVE', notes: '' });
  const qc = useQueryClient();
  const toast = useToast();
  const m = useMutation({
    mutationFn: () => {
      const body = { deviceType: f.deviceType, make: f.make.trim() || null, model: f.model.trim() || null, firmwareVersion: f.firmwareVersion.trim() || null, orgUnitId: f.orgUnitId, notes: f.notes.trim() || null };
      return isNew ? api.post<Device>('/devices', { ...body, serialNumber: f.serialNumber.trim() }) : api.patch<Device>(`/devices/${device.id}`, { ...body, status: f.status });
    },
    onSuccess: (d) => {
      toast.success(isNew ? 'Device registered' : 'Device updated');
      void qc.invalidateQueries({ queryKey: ['admin', 'devices'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'device', d.id] });
      onClose(isNew ? d : undefined);
    },
  });
  const valid = (!isNew || f.serialNumber.trim().length >= 3) && !!f.orgUnitId;
  const fld = (k: keyof Form) => ({ id: `dv-${k}`, value: f[k], onChange: (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value }) });
  return (
    <Modal open onClose={() => onClose()} title={isNew ? 'Register device' : `Edit ${device.serialNumber}`} size="lg" footer={<><Button variant="secondary" onClick={() => onClose()} disabled={m.isPending}>Cancel</Button><Button onClick={() => m.mutate()} disabled={!valid} loading={m.isPending}>Save</Button></>}>
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); if (valid) m.mutate(); }}>
        {isNew && (
          <Field label="Serial number" htmlFor="dv-serialNumber" required hint="Unique; stored upper-case.">
            <Input {...fld('serialNumber')} maxLength={64} />
          </Field>
        )}
        <Field label="Type" htmlFor="dv-deviceType" required>
          <Select {...fld('deviceType')}>{DEVICE_TYPES.map((t) => <option key={t} value={t}>{titleCase(t)}</option>)}</Select>
        </Field>
        <Field label="Owning unit" htmlFor="dv-orgUnitId" required>
          <OrgUnitSelect id="dv-orgUnitId" scope="devices:manage" value={f.orgUnitId} onChange={(v) => setF({ ...f, orgUnitId: v })} emptyLabel="Select a unit…" />
        </Field>
        {!isNew && (
          <Field label="Status" htmlFor="dv-status" hint="Use “Retire” to take a device out of service permanently.">
            <Select {...fld('status')}>{DEVICE_STATUSES.filter((s) => s !== 'RETIRED').map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}</Select>
          </Field>
        )}
        <Field label="Make" htmlFor="dv-make"><Input {...fld('make')} maxLength={100} /></Field>
        <Field label="Model" htmlFor="dv-model"><Input {...fld('model')} maxLength={100} /></Field>
        <Field label="Firmware version" htmlFor="dv-firmwareVersion"><Input {...fld('firmwareVersion')} maxLength={100} /></Field>
        <div className="sm:col-span-2">
          <Field label="Notes" htmlFor="dv-notes"><Textarea {...fld('notes')} rows={2} maxLength={2000} /></Field>
        </div>
        {m.error ? <div className="sm:col-span-2"><Alert tone="red">{errorMessage(m.error)}</Alert></div> : null}
      </form>
    </Modal>
  );
}

export function DevicesPage() {
  const [s, set, reset] = useUrlState(DEFAULTS);
  const { can } = useAuth();
  const navigate = useNavigate();
  const [registering, setRegistering] = useState(false);
  const query = useMemo(() => ({ q: s.q || undefined, type: s.type || undefined, status: s.status || undefined, orgUnitId: s.orgUnitId || undefined, assigned: s.assigned || undefined, sort: s.sort, page: s.page, pageSize: s.pageSize }), [s]);
  const list = useQuery({ queryKey: ['admin', 'devices', query], queryFn: () => api.get<Paged<Device>>('/devices', query), placeholderData: keepPreviousData });
  const filtered = !!(s.q || s.type || s.status || s.orgUnitId || s.assigned);
  const cols: Column<Device>[] = [
    { key: 'serial', header: 'Serial', sortKey: 'serialNumber', render: (r) => (<div><Link to={`/admin/devices/${r.id}`} className="mono font-medium text-brand-800 hover:underline" onClick={(e) => e.stopPropagation()}>{r.serialNumber}</Link><p className="text-xs text-ink-500">{[r.make, r.model].filter(Boolean).join(' ') || '—'}</p></div>) },
    { key: 'type', header: 'Type', sortKey: 'deviceType', render: (r) => titleCase(r.deviceType) },
    { key: 'unit', header: 'Unit', render: (r) => r.orgUnit.name },
    { key: 'officer', header: 'Assigned officer', render: (r) => (r.assignedOfficer ? `${r.assignedOfficer.fullName}${r.assignedOfficer.badgeNumber ? ` (${r.assignedOfficer.badgeNumber})` : ''}` : <span className="text-ink-500">Unassigned</span>) },
    { key: 'status', header: 'Status', sortKey: 'status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'updated', header: 'Updated', sortKey: 'updatedAt', render: (r) => <span className="whitespace-nowrap text-sm">{formatDateTime(r.updatedAt)}</span> },
  ];
  return (
    <div className="space-y-4">
      <PageHeader title="Devices" subtitle="Body-worn cameras and other capture devices within your jurisdiction." actions={can('devices:manage') ? <Button icon={<Plus className="h-4 w-4" />} onClick={() => setRegistering(true)}>Register device</Button> : undefined} />
      <Card>
        <form className="grid gap-3 md:grid-cols-3 xl:grid-cols-6" onSubmit={(e) => { e.preventDefault(); set({ q: String(new FormData(e.currentTarget).get('q') ?? '').trim() }); }}>
          <div className="md:col-span-2">
            <Field label="Search" htmlFor="dv-q"><Input id="dv-q" name="q" defaultValue={s.q} key={s.q} placeholder="Serial, make, model, officer…" /></Field>
          </div>
          <Field label="Unit" htmlFor="dv-org"><OrgUnitSelect id="dv-org" scope="devices:read" value={s.orgUnitId} onChange={(v) => set({ orgUnitId: v })} /></Field>
          <Field label="Type" htmlFor="dv-type">
            <Select id="dv-type" value={s.type} onChange={(e) => set({ type: e.target.value })}><option value="">Any type</option>{DEVICE_TYPES.map((t) => <option key={t} value={t}>{titleCase(t)}</option>)}</Select>
          </Field>
          <Field label="Status" htmlFor="dv-st">
            <Select id="dv-st" value={s.status} onChange={(e) => set({ status: e.target.value })}><option value="">Any status</option>{DEVICE_STATUSES.map((t) => <option key={t} value={t}>{titleCase(t)}</option>)}</Select>
          </Field>
          <Field label="Assignment" htmlFor="dv-as">
            <Select id="dv-as" value={s.assigned} onChange={(e) => set({ assigned: e.target.value })}><option value="">Any</option><option value="true">Assigned</option><option value="false">Unassigned</option></Select>
          </Field>
          <div className="flex items-end gap-2 md:col-span-3 xl:col-span-6">
            <Button type="submit">Search</Button>
            {filtered && <Button variant="ghost" onClick={reset}>Clear filters</Button>}
          </div>
        </form>
      </Card>
      <Card bodyClassName="p-0">
        <DataTable caption="Devices" columns={cols} rows={list.data?.items} rowKey={(r) => r.id} loading={list.isFetching} error={list.error} onRetry={() => void list.refetch()} sort={s.sort} onSort={(sort) => set({ sort })} onRowClick={(r) => navigate(`/admin/devices/${r.id}`)}
          empty={<EmptyState icon={<Camera className="h-6 w-6" />} title={filtered ? 'No devices match these filters' : 'No devices registered'} />} />
        {list.data && <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={(p) => set({ page: String(p) })} />}
      </Card>
      {registering && <DeviceModal device={null} onClose={(d) => { setRegistering(false); if (d) navigate(`/admin/devices/${d.id}`); }} />}
    </div>
  );
}

export function DeviceDetailPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['admin', 'device', id], queryFn: () => api.get<DeviceDetail>(`/devices/${id}`) });
  const [edit, setEdit] = useState(false);
  const [assign, setAssign] = useState(false);
  const [officer, setOfficer] = useState<UserOption | null>(null);
  const [confirm, setConfirm] = useState<'unassign' | 'retire' | null>(null);
  const done = (msg: string) => { toast.success(msg); void qc.invalidateQueries({ queryKey: ['admin', 'device', id] }); void qc.invalidateQueries({ queryKey: ['admin', 'devices'] }); };
  const assignM = useMutation({ mutationFn: () => api.post(`/devices/${id}/assign`, { officerId: officer!.id }), onSuccess: () => { setAssign(false); setOfficer(null); done('Device assigned'); } });
  const actM = useMutation({
    mutationFn: ({ a, reason }: { a: 'unassign' | 'retire'; reason: string }) => (a === 'retire' ? api.post(`/devices/${id}/retire`, { reason }) : api.post(`/devices/${id}/unassign`)),
    onSuccess: (_r, { a }) => { setConfirm(null); done(a === 'retire' ? 'Device retired' : 'Assignment removed'); },
  });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} title={q.error instanceof ApiError && q.error.status === 404 ? 'Device not found' : undefined} />;
  const d = q.data!;
  const manage = d.canManage && d.status !== 'RETIRED';
  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumb={<Link to="/admin/devices" className="hover:underline">Devices</Link>}
        title={<span className="flex flex-wrap items-center gap-2 font-mono">{d.serialNumber} <StatusBadge status={d.status} /></span>}
        subtitle={`${titleCase(d.deviceType)} · ${d.orgUnit.name}`}
        actions={manage ? (
          <>
            <Button variant="secondary" onClick={() => setEdit(true)}>Edit</Button>
            {d.assignedOfficer ? <Button variant="secondary" icon={<UserMinus className="h-4 w-4" />} onClick={() => { actM.reset(); setConfirm('unassign'); }}>Unassign</Button> : <Button icon={<UserPlus className="h-4 w-4" />} onClick={() => { assignM.reset(); setAssign(true); }}>Assign officer</Button>}
            <Button variant="danger" onClick={() => { actM.reset(); setConfirm('retire'); }}>Retire</Button>
          </>
        ) : undefined}
      />
      <Card title="Details">
        <KeyValue items={[
          { label: 'Make / model', value: [d.make, d.model].filter(Boolean).join(' ') || '—' },
          { label: 'Firmware', value: d.firmwareVersion ?? '—' },
          { label: 'Assigned officer', value: d.assignedOfficer ? `${d.assignedOfficer.fullName} (@${d.assignedOfficer.username})` : 'Unassigned' },
          { label: 'Evidence recorded', value: d.evidenceCount.toLocaleString('en-IN') },
          { label: 'Registered', value: formatDateTime(d.createdAt) },
          { label: 'Notes', value: d.notes ?? '—' },
        ]} />
      </Card>
      <Card title="History" bodyClassName="p-0">
        {d.history.length === 0 ? <EmptyState title="No history" /> : (
          <ol className="divide-y divide-ink-100 text-sm">
            {d.history.map((h) => (
              <li key={h.seq} className="flex flex-wrap gap-x-3 px-4 py-2">
                <span className="w-44 shrink-0 text-ink-500">{formatDateTime(h.occurredAt)}</span>
                <span className="font-medium">{titleCase(h.action.replace(/^DEVICE_/, ''))}</span>
                <span className="text-ink-600">{h.actorName ? `by ${h.actorName}` : ''}</span>
                {typeof h.details.reason === 'string' && <span className="text-ink-600">— {h.details.reason}</span>}
              </li>
            ))}
          </ol>
        )}
      </Card>
      {edit && <DeviceModal device={d} onClose={() => setEdit(false)} />}
      <Modal open={assign} onClose={() => setAssign(false)} title="Assign to officer" footer={<><Button variant="secondary" onClick={() => setAssign(false)}>Cancel</Button><Button onClick={() => assignM.mutate()} disabled={!officer} loading={assignM.isPending}>Assign</Button></>}>
        <div className="space-y-3">
          <Field label="Officer" htmlFor="dv-officer"><UserPicker id="dv-officer" value={officer} onChange={setOfficer} /></Field>
          {assignM.error ? <Alert tone="red">{errorMessage(assignM.error)}</Alert> : null}
        </div>
      </Modal>
      <ConfirmDialog
        open={!!confirm}
        title={confirm === 'retire' ? 'Retire device' : 'Remove assignment'}
        message={confirm === 'retire' ? 'Retiring is permanent: the device can no longer be assigned or edited. Evidence it recorded is unaffected.' : `Unassign ${d.serialNumber} from ${d.assignedOfficer?.fullName ?? ''}?`}
        confirmLabel={confirm === 'retire' ? 'Retire' : 'Unassign'}
        variant="danger"
        requireReason={confirm === 'retire'}
        loading={actM.isPending}
        error={actM.error}
        onConfirm={(reason) => confirm && actM.mutate({ a: confirm, reason })}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
