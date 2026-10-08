import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { titleCase } from '@/lib/format';
import { Alert, Badge, Button, Card, Checkbox, EmptyState, ErrorState, Field, Input, Modal, PageHeader, Select, Spinner, useToast } from '@/components/ui';
import { UNIT_TYPES, type OrgUnit } from './types';

import { t as tr } from '@/lib/i18n';
interface Form {
  code: string;
  name: string;
  unitType: string;
  address: string;
  phone: string;
  latitude: string;
  longitude: string;
  active: boolean;
}
const num = (v: string) => (v.trim() === '' ? null : Number(v));

function UnitModal({ unit, parent, onClose }: { unit: OrgUnit | null; parent: OrgUnit | null; onClose: () => void }) {
  const isNew = !unit;
  const [f, setF] = useState<Form>(unit
    ? { code: unit.code, name: unit.name, unitType: unit.unitType, address: unit.address ?? '', phone: unit.phone ?? '', latitude: unit.latitude?.toString() ?? '', longitude: unit.longitude?.toString() ?? '', active: unit.active }
    : { code: '', name: '', unitType: parent?.unitType === 'STATION' ? 'UNIT' : 'STATION', address: '', phone: '', latitude: '', longitude: '', active: true });
  const qc = useQueryClient();
  const toast = useToast();
  const m = useMutation({
    mutationFn: () => {
      const body = { name: f.name.trim(), address: f.address.trim() || null, phone: f.phone.trim() || null, latitude: num(f.latitude), longitude: num(f.longitude) };
      return isNew ? api.post<OrgUnit>('/org', { ...body, code: f.code.trim().toLowerCase(), unitType: f.unitType, parentId: parent!.id }) : api.patch<OrgUnit>(`/org/${unit.id}`, { ...body, ...(f.active !== unit.active ? { active: f.active } : {}) });
    },
    onSuccess: () => {
      toast.success(isNew ? 'Unit created' : 'Unit updated');
      void qc.invalidateQueries({ queryKey: ['admin', 'org'] });
      void qc.invalidateQueries({ queryKey: ['directory', 'org-units'] });
      onClose();
    },
  });
  const valid = f.name.trim().length >= 2 && (!isNew || /^[a-z0-9_]{2,40}$/.test(f.code.trim().toLowerCase()));
  return (
    <Modal open onClose={onClose} title={isNew ? `New unit under ${parent?.name}` : `Edit ${unit.name}`} footer={<><Button variant="secondary" onClick={onClose} disabled={m.isPending}>{tr('Cancel')}</Button><Button onClick={() => m.mutate()} disabled={!valid} loading={m.isPending}>{tr('Save')}</Button></>}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (valid) m.mutate(); }}>
        {isNew ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={tr('Code')} htmlFor="ou-code" required hint={tr('Lowercase letters, digits, underscore. Permanent (forms the jurisdiction path).')}>
              <Input id="ou-code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toLowerCase() })} maxLength={40} />
            </Field>
            <Field label={tr('Type')} htmlFor="ou-type" required>
              <Select id="ou-type" value={f.unitType} onChange={(e) => setF({ ...f, unitType: e.target.value })}>
                {(parent?.unitType === 'STATION' ? ['UNIT'] : UNIT_TYPES).map((t) => <option key={t} value={t}>{titleCase(t)}</option>)}
              </Select>
            </Field>
          </div>
        ) : (
          <p className="text-xs text-ink-500">{tr('Code')}{' '}<span className="mono">{unit.code}</span>{tr(', type and parent are permanent: evidence jurisdiction is recorded against the unit path. To restructure, create a new unit and deactivate this one.')}</p>
        )}
        <Field label={tr('Name')} htmlFor="ou-name" required>
          <Input id="ou-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={200} />
        </Field>
        <Field label={tr('Address')} htmlFor="ou-addr">
          <Input id="ou-addr" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} maxLength={500} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={tr('Phone')} htmlFor="ou-phone">
            <Input id="ou-phone" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} maxLength={20} />
          </Field>
          <Field label={tr('Latitude')} htmlFor="ou-lat">
            <Input id="ou-lat" type="number" step="any" min={-90} max={90} value={f.latitude} onChange={(e) => setF({ ...f, latitude: e.target.value })} />
          </Field>
          <Field label={tr('Longitude')} htmlFor="ou-lon">
            <Input id="ou-lon" type="number" step="any" min={-180} max={180} value={f.longitude} onChange={(e) => setF({ ...f, longitude: e.target.value })} />
          </Field>
        </div>
        {!isNew && unit.parentId && <Checkbox label={tr('Active')} description={tr('Inactive units cannot receive users, devices or role grants; role grants at an inactive unit stop applying.')} checked={f.active} onChange={(v) => setF({ ...f, active: v })} />}
        {m.error ? <Alert tone="red">{errorMessage(m.error)}</Alert> : null}
      </form>
    </Modal>
  );
}

export function OrgUnitsPage() {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['admin', 'org'], queryFn: () => api.get<{ items: OrgUnit[] }>('/org') });
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [edit, setEdit] = useState<{ unit: OrgUnit | null; parent: OrgUnit | null } | null>(null);
  const [filter, setFilter] = useState('');
  const visible = useMemo(() => {
    const items = q.data?.items ?? [];
    const byId = new Map(items.map((u) => [u.id, u]));
    const hidden = (u: OrgUnit): boolean => { let p = u.parentId ? byId.get(u.parentId) : undefined; while (p) { if (collapsed.has(p.id)) return true; p = p.parentId ? byId.get(p.parentId) : undefined; } return false; };
    const f = filter.trim().toLowerCase();
    return f ? items.filter((u) => u.name.toLowerCase().includes(f) || u.code.includes(f)) : items.filter((u) => !hidden(u));
  }, [q.data, collapsed, filter]);
  const manage = can('org:manage');

  return (
    <div className="space-y-4">
      <PageHeader title={tr('Organisation units')} subtitle={tr('State › ranges/commissionerates › districts › sub-divisions › stations. Role grants apply to a unit and everything below it.')} />
      <Card bodyClassName="p-0" title={<Field label={tr('Filter')} htmlFor="ou-filter"><Input id="ou-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={tr('Name or code…')} className="w-64" /></Field>}>
        {q.isLoading ? <Spinner /> : q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : visible.length === 0 ? <EmptyState title={tr('No units match')} /> : (
          <ul role="tree" aria-label={tr('Organisation units')} className="divide-y divide-ink-100">
            {visible.map((u) => (
              <li key={u.id} role="treeitem" aria-level={u.depth + 1} aria-expanded={u.childCount ? !collapsed.has(u.id) : undefined} className="flex flex-wrap items-center gap-2 px-3 py-2" style={{ paddingLeft: `${0.75 + (filter ? 0 : u.depth) * 1.25}rem` }}>
                {u.childCount > 0 && !filter ? (
                  <button type="button" className="rounded p-0.5 text-ink-500 hover:bg-ink-100" aria-label={`${collapsed.has(u.id) ? 'Expand' : 'Collapse'} ${u.name}`} onClick={() => setCollapsed((s) => { const n = new Set(s); if (n.has(u.id)) n.delete(u.id); else n.add(u.id); return n; })}>
                    {collapsed.has(u.id) ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </button>
                ) : <span className="inline-block w-5" />}
                <Building2 className="h-4 w-4 text-ink-400" aria-hidden />
                <span className={u.active ? 'font-medium text-ink-900' : 'font-medium text-ink-500 line-through'}>{u.name}</span>
                <span className="mono text-xs text-ink-500">{u.code}</span>
                <Badge>{titleCase(u.unitType)}</Badge>
                {!u.active && <Badge tone="gray">{tr('Inactive')}</Badge>}
                <span className="text-xs text-ink-500">{u.userCount} {u.userCount === 1 ? 'user' : 'users'} · {u.deviceCount} {u.deviceCount === 1 ? 'device' : 'devices'}</span>
                {manage && u.canManage && (
                  <span className="ml-auto flex gap-1">
                    {u.active && <Button size="sm" variant="ghost" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setEdit({ unit: null, parent: u })} aria-label={`Add unit under ${u.name}`}>{tr('Add')}</Button>}
                    <Button size="sm" variant="secondary" onClick={() => setEdit({ unit: u, parent: null })}>{tr('Edit')}</Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {edit && <UnitModal unit={edit.unit} parent={edit.parent} onClose={() => setEdit(null)} />}
    </div>
  );
}
