import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { OrgUnitSelect } from '@/components/pickers';
import { Alert, Button, Card, Field, Input, PageHeader, Select } from '@/components/ui';
import { localToIso, OneTimePasswordDialog, useRoles } from './shared';
import type { UserDetail } from './types';

interface Grant {
  roleId: string;
  orgUnitId: string;
  expiresAt: string;
}

export interface ProfileForm {
  fullName: string;
  email: string;
  badgeNumber: string;
  rank: string;
  designation: string;
  phone: string;
  homeOrgUnitId: string;
}

export function ProfileFields({ f, setF, idPrefix }: { f: ProfileForm; setF: (f: ProfileForm) => void; idPrefix: string }) {
  const fld = (k: keyof ProfileForm) => ({ id: `${idPrefix}-${k}`, value: f[k], onChange: (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value }) });
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Full name" htmlFor={`${idPrefix}-fullName`} required>
        <Input {...fld('fullName')} maxLength={200} required />
      </Field>
      <Field label="Home unit" htmlFor={`${idPrefix}-homeOrgUnitId`} required hint="Determines which administrators manage this account.">
        <OrgUnitSelect id={`${idPrefix}-homeOrgUnitId`} value={f.homeOrgUnitId} onChange={(v) => setF({ ...f, homeOrgUnitId: v })} allowEmpty emptyLabel="Select a unit…" required />
      </Field>
      <Field label="Email" htmlFor={`${idPrefix}-email`}>
        <Input type="email" {...fld('email')} maxLength={254} />
      </Field>
      <Field label="Badge / employee number" htmlFor={`${idPrefix}-badgeNumber`}>
        <Input {...fld('badgeNumber')} maxLength={64} />
      </Field>
      <Field label="Rank" htmlFor={`${idPrefix}-rank`}>
        <Input {...fld('rank')} maxLength={100} />
      </Field>
      <Field label="Designation" htmlFor={`${idPrefix}-designation`}>
        <Input {...fld('designation')} maxLength={200} />
      </Field>
      <Field label="Phone" htmlFor={`${idPrefix}-phone`}>
        <Input type="tel" {...fld('phone')} maxLength={20} />
      </Field>
    </div>
  );
}

export const profileBody = (f: ProfileForm) => ({
  fullName: f.fullName.trim(), email: f.email.trim() || null, badgeNumber: f.badgeNumber.trim() || null, rank: f.rank.trim() || null,
  designation: f.designation.trim() || null, phone: f.phone.trim() || null, homeOrgUnitId: f.homeOrgUnitId,
});

export function UserCreatePage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const roles = useRoles(can('roles:read'));
  const [username, setUsername] = useState('');
  const [f, setF] = useState<ProfileForm>({ fullName: '', email: '', badgeNumber: '', rank: '', designation: '', phone: '', homeOrgUnitId: '' });
  const [grants, setGrants] = useState<Grant[]>([]);
  const [created, setCreated] = useState<{ user: UserDetail; temporaryPassword: string } | null>(null);
  const m = useMutation({
    mutationFn: () => api.post<{ user: UserDetail; temporaryPassword: string }>('/users', {
      username: username.trim().toLowerCase(), ...profileBody(f),
      roles: grants.filter((g) => g.roleId && g.orgUnitId).map((g) => ({ roleId: g.roleId, orgUnitId: g.orgUnitId, expiresAt: localToIso(g.expiresAt) })),
    }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['admin', 'users'] });
      setCreated(r);
    },
  });
  const valid = /^[a-z0-9][a-z0-9._-]{2,63}$/.test(username.trim().toLowerCase()) && f.fullName.trim().length >= 2 && !!f.homeOrgUnitId;
  const fieldErrors = m.error instanceof ApiError && m.error.code === 'VALIDATION_FAILED' ? m.error.details : null;

  return (
    <div className="space-y-4">
      <PageHeader title="New user" breadcrumb={<Link to="/admin/users" className="hover:underline">Users</Link>} subtitle="A strong one-time password is generated; the user must change it at first sign-in." />
      <form onSubmit={(e) => { e.preventDefault(); if (valid) m.mutate(); }} className="space-y-4">
        <Card title="Account">
          <div className="space-y-3">
            <Field label="Username" htmlFor="nu-username" required hint="3-64 characters: lowercase letters, digits, dot, dash, underscore.">
              <Input id="nu-username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" maxLength={64} required />
            </Field>
            <ProfileFields f={f} setF={setF} idPrefix="nu" />
          </div>
        </Card>
        {can('roles:manage') && (
          <Card title="Initial roles" actions={<Button size="sm" variant="secondary" icon={<Plus className="h-4 w-4" />} onClick={() => setGrants([...grants, { roleId: '', orgUnitId: f.homeOrgUnitId, expiresAt: '' }])}>Add role</Button>}>
            {grants.length === 0 ? (
              <p className="text-sm text-ink-500">No roles yet — the account will have no permissions until a role is granted.</p>
            ) : (
              <ul className="space-y-3">
                {grants.map((g, i) => (
                  <li key={i} className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_12rem_auto]">
                    <Field label="Role" htmlFor={`g-role-${i}`}>
                      <Select id={`g-role-${i}`} value={g.roleId} onChange={(e) => setGrants(grants.map((x, j) => (j === i ? { ...x, roleId: e.target.value } : x)))}>
                        <option value="">Select a role…</option>
                        {roles.data?.items.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                      </Select>
                    </Field>
                    <Field label="At unit (and sub-units)" htmlFor={`g-org-${i}`}>
                      <OrgUnitSelect id={`g-org-${i}`} value={g.orgUnitId} onChange={(v) => setGrants(grants.map((x, j) => (j === i ? { ...x, orgUnitId: v } : x)))} emptyLabel="Select a unit…" />
                    </Field>
                    <Field label="Expires (optional)" htmlFor={`g-exp-${i}`}>
                      <Input id={`g-exp-${i}`} type="datetime-local" value={g.expiresAt} onChange={(e) => setGrants(grants.map((x, j) => (j === i ? { ...x, expiresAt: e.target.value } : x)))} />
                    </Field>
                    <Button variant="ghost" aria-label={`Remove role row ${i + 1}`} icon={<Trash2 className="h-4 w-4" />} onClick={() => setGrants(grants.filter((_, j) => j !== i))} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
        {m.error ? (
          <Alert tone="red" title="Could not create the user">
            {errorMessage(m.error)}
            {Array.isArray(fieldErrors) && <ul className="mt-1 list-disc pl-5">{(fieldErrors as Array<{ message?: string; instancePath?: string }>).map((d, i) => <li key={i}>{d.instancePath ? `${d.instancePath}: ` : ''}{d.message}</li>)}</ul>}
          </Alert>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => navigate('/admin/users')}>Cancel</Button>
          <Button type="submit" disabled={!valid} loading={m.isPending}>Create user</Button>
        </div>
      </form>
      <OneTimePasswordDialog password={created?.temporaryPassword ?? null} username={created?.user.username ?? ''} onClose={() => { const id = created?.user.id; setCreated(null); if (id) navigate(`/admin/users/${id}`); }} />
    </div>
  );
}
