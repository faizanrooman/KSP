import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Lock, LogOut, Pencil, Plus, ShieldOff, Unlock, UserCheck, UserX } from 'lucide-react';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import { OrgUnitSelect } from '@/components/pickers';
import { Alert, Badge, Button, Card, ConfirmDialog, DataTable, EmptyState, ErrorState, Field, Input, KeyValue, Modal, PageHeader, Select, Spinner, StatusBadge, useToast, type Column } from '@/components/ui';
import { localToIso, OneTimePasswordDialog, useRoles } from './shared';
import { profileBody, ProfileFields, type ProfileForm } from './UserCreatePage';
import type { RoleAssignment, SessionItem, UserDetail } from './types';

import { t } from '@/lib/i18n';
type Action = 'DISABLED' | 'LOCKED' | 'ACTIVE' | 'unlock' | 'reset-password' | 'reset-mfa' | 'revoke-all';

const ACTIONS: Record<Action, { title: string; label: string; message: string; variant: 'primary' | 'danger'; reason: boolean }> = {
  DISABLED: { title: 'Disable account', label: 'Disable', message: 'The user is signed out everywhere immediately and cannot sign in until re-activated.', variant: 'danger', reason: true },
  LOCKED: { title: 'Lock account', label: 'Lock', message: 'Administrative lock: the user is signed out everywhere and cannot sign in until unlocked.', variant: 'danger', reason: true },
  ACTIVE: { title: 'Re-activate account', label: 'Re-activate', message: 'The user will be able to sign in again. Failed-login counters are cleared.', variant: 'primary', reason: true },
  unlock: { title: 'Unlock account', label: 'Unlock', message: 'Clears the failed-login lockout so the user can sign in again.', variant: 'primary', reason: true },
  'reset-password': { title: 'Reset password', label: 'Reset password', message: 'A new one-time password is generated and shown once. All sessions are revoked and the user must change it at next sign-in.', variant: 'danger', reason: true },
  'reset-mfa': { title: 'Reset MFA', label: 'Reset MFA', message: 'The authenticator and recovery codes are removed and all sessions are revoked. If MFA is mandatory for their role, the user must re-enrol at next sign-in.', variant: 'danger', reason: true },
  'revoke-all': { title: 'Sign out everywhere', label: 'Revoke all sessions', message: 'All active sessions of this user are revoked immediately.', variant: 'danger', reason: true },
};

function EditProfileModal({ user, onClose }: { user: UserDetail; onClose: () => void }) {
  const [f, setF] = useState<ProfileForm>({
    fullName: user.fullName, email: user.email ?? '', badgeNumber: user.badgeNumber ?? '', rank: user.rank ?? '', designation: user.designation ?? '', phone: user.phone ?? '', homeOrgUnitId: user.homeOrgUnit.id,
  });
  const qc = useQueryClient();
  const toast = useToast();
  const m = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = profileBody(f);
      if (body.homeOrgUnitId === user.homeOrgUnit.id) delete body.homeOrgUnitId;
      return api.patch<UserDetail>(`/users/${user.id}`, body);
    },
    onSuccess: (u) => {
      qc.setQueryData(['admin', 'user', user.id], u);
      void qc.invalidateQueries({ queryKey: ['admin', 'users'] });
      toast.success('Profile updated');
      onClose();
    },
  });
  return (
    <Modal open onClose={onClose} title={t('Edit {fullName}', { fullName: user.fullName })} size="lg" footer={<><Button variant="secondary" onClick={onClose} disabled={m.isPending}>{t('Cancel')}</Button><Button onClick={() => m.mutate()} loading={m.isPending} disabled={f.fullName.trim().length < 2}>{t('Save')}</Button></>}>
      <form onSubmit={(e) => { e.preventDefault(); m.mutate(); }} className="space-y-3">
        <ProfileFields f={f} setF={setF} idPrefix="ep" />
        {m.error ? <Alert tone="red">{errorMessage(m.error)}</Alert> : null}
      </form>
    </Modal>
  );
}

function GrantRoleModal({ user, onClose }: { user: UserDetail; onClose: () => void }) {
  const roles = useRoles();
  const [roleId, setRoleId] = useState('');
  const [orgUnitId, setOrgUnitId] = useState(user.homeOrgUnit.id);
  const [expiresAt, setExpiresAt] = useState('');
  const qc = useQueryClient();
  const toast = useToast();
  const m = useMutation({
    mutationFn: () => api.post<{ user: UserDetail }>(`/users/${user.id}/roles`, { roleId, orgUnitId, expiresAt: localToIso(expiresAt) }),
    onSuccess: (r) => {
      qc.setQueryData(['admin', 'user', user.id], r.user);
      void qc.invalidateQueries({ queryKey: ['admin', 'users'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'roles'] });
      toast.success('Role granted');
      onClose();
    },
  });
  const role = roles.data?.items.find((r) => r.id === roleId);
  const missing = m.error instanceof ApiError && m.error.code === 'PRIVILEGE_ESCALATION' ? ((m.error.details as { missing?: string[] })?.missing ?? []) : [];
  return (
    <Modal open onClose={onClose} title={t('Grant role')} footer={<><Button variant="secondary" onClick={onClose} disabled={m.isPending}>{t('Cancel')}</Button><Button onClick={() => m.mutate()} loading={m.isPending} disabled={!roleId || !orgUnitId}>{t('Grant')}</Button></>}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (roleId && orgUnitId) m.mutate(); }}>
        <Field label={t('Role')} htmlFor="gr-role" required>
          <Select id="gr-role" value={roleId} onChange={(e) => setRoleId(e.target.value)} disabled={roles.isLoading}>
            <option value="">{t('Select a role…')}</option>
            {roles.data?.items.map((r) => <option key={r.id} value={r.id}>{r.name}{r.isSystem ? '' : t(' (custom)')}</option>)}
          </Select>
        </Field>
        {role && <p className="text-xs text-ink-600">{role.description ?? ''} {role.permissions.length}{' '}{t('permission(s).')}</p>}
        <Field label={t('At unit')} htmlFor="gr-org" required hint={t('The role applies to this unit and every unit below it.')}>
          <OrgUnitSelect id="gr-org" scope="roles:manage" value={orgUnitId} onChange={setOrgUnitId} emptyLabel={t('Select a unit…')} />
        </Field>
        <Field label={t('Expires (optional, IST)')} htmlFor="gr-exp" hint={t('Leave blank for a permanent assignment.')}>
          <Input id="gr-exp" type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
        </Field>
        {m.error ? (
          <Alert tone="red" title={m.error instanceof ApiError && m.error.code === 'SOD_VIOLATION' ? t('Separation of duties') : t('Not granted')}>
            {errorMessage(m.error)}
            {missing.length > 0 && <p className="mt-1">{t('Permissions you do not hold at that unit:')}{' '}<span className="mono">{missing.join(', ')}</span></p>}
          </Alert>
        ) : null}
      </form>
    </Modal>
  );
}

export function UserDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['admin', 'user', id], queryFn: () => api.get<UserDetail>(`/users/${id}`) });
  const sessions = useQuery({ queryKey: ['admin', 'user', id, 'sessions'], queryFn: () => api.get<{ items: SessionItem[] }>(`/users/${id}/sessions`), enabled: !!q.data });
  const [action, setAction] = useState<Action | null>(null);
  const [edit, setEdit] = useState(false);
  const [grant, setGrant] = useState(false);
  const [revoke, setRevoke] = useState<RoleAssignment | null>(null);
  const [password, setPassword] = useState<string | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['admin', 'user', id] });
    void qc.invalidateQueries({ queryKey: ['admin', 'users'] });
  };
  const act = useMutation({
    mutationFn: async ({ a, reason }: { a: Action; reason: string }) => {
      if (a === 'DISABLED' || a === 'LOCKED' || a === 'ACTIVE') return api.post(`/users/${id}/status`, { status: a, reason });
      if (a === 'reset-password') return api.post<{ temporaryPassword: string }>(`/users/${id}/reset-password`, { reason });
      if (a === 'revoke-all') return api.post(`/users/${id}/sessions/revoke-all`, { reason });
      return api.post(`/users/${id}/${a}`, { reason });
    },
    onSuccess: (res, { a }) => {
      setAction(null);
      if (a === 'reset-password') setPassword((res as { temporaryPassword: string }).temporaryPassword);
      toast.success(`${ACTIONS[a].title}: done`);
      refresh();
    },
  });
  const revokeRole = useMutation({
    mutationFn: ({ assignment, reason }: { assignment: RoleAssignment; reason: string }) => api.delete(`/users/${id}/roles/${assignment.id}`, { reason }),
    onSuccess: () => { setRevoke(null); toast.success('Role revoked'); refresh(); void qc.invalidateQueries({ queryKey: ['admin', 'roles'] }); },
  });
  const revokeSession = useMutation({
    mutationFn: (sid: string) => api.delete(`/users/${id}/sessions/${sid}`),
    onSuccess: () => { toast.success('Session revoked'); refresh(); },
    onError: (e) => toast.error(e),
  });

  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} title={q.error instanceof ApiError && q.error.status === 404 ? t('User not found') : undefined} />;
  const u = q.data!;
  const manage = u.canManage && !u.isSelf;
  const manageRoles = can('roles:manage') && !u.isSelf;

  const roleCols: Column<RoleAssignment>[] = [
    { key: 'role', header: t('Role'), render: (r) => (<div><p className="font-medium">{r.roleName}</p><p className="mono text-xs text-ink-500">{r.roleCode}{r.isSystemRole ? '' : t(' · custom')}</p></div>) },
    { key: 'org', header: t('At unit'), render: (r) => (<span>{r.orgUnitName}{!r.orgUnitActive && <Badge tone="gray" className="ml-1">{t('Inactive')}</Badge>}</span>) },
    { key: 'granted', header: t('Granted'), render: (r) => (<div className="text-sm"><p>{formatDateTime(r.grantedAt)}</p><p className="text-xs text-ink-500">{r.grantedBy ? t('by {fullName}', { fullName: r.grantedBy.fullName }) : t('by system')}</p></div>) },
    { key: 'exp', header: t('Expires'), render: (r) => (r.expired ? <Badge tone="gray">{t('Expired')}{' '}{formatDateTime(r.expiresAt)}</Badge> : r.expiresAt ? formatDateTime(r.expiresAt) : 'Never') },
    ...(manageRoles ? [{ key: 'a', header: <span className="sr-only">{t('Actions')}</span>, render: (r: RoleAssignment) => <Button size="sm" variant="ghost" onClick={() => { revokeRole.reset(); setRevoke(r); }}>{t('Revoke')}</Button> }] : []),
  ];
  const sessCols: Column<SessionItem>[] = [
    { key: 'started', header: t('Started'), render: (r) => formatDateTime(r.createdAt) },
    { key: 'seen', header: t('Last active'), render: (r) => formatDateTime(r.lastSeenAt) },
    { key: 'ip', header: t('IP address'), render: (r) => <span className="mono text-xs">{r.ip ?? '—'}</span> },
    { key: 'ua', header: t('Client'), render: (r) => <span className="line-clamp-2 max-w-xs text-xs text-ink-600">{r.userAgent ?? '—'}</span> },
    { key: 'mfa', header: t('MFA'), render: (r) => (r.mfaVerified ? <Badge tone="green">{t('Verified')}</Badge> : <Badge>{t('Password only')}</Badge>) },
    { key: 'exp', header: t('Idle expiry'), render: (r) => formatDateTime(r.idleExpiresAt) },
    ...(manage ? [{ key: 'a', header: <span className="sr-only">{t('Actions')}</span>, render: (r: SessionItem) => <Button size="sm" variant="ghost" loading={revokeSession.isPending && revokeSession.variables === r.id} onClick={() => revokeSession.mutate(r.id)}>{t('Revoke')}</Button> }] : []),
  ];
  const cfg = action ? ACTIONS[action] : null;

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumb={<Link to="/admin/users" className="hover:underline">{t('Users')}</Link>}
        title={<span className="flex items-center gap-2">{u.fullName} <StatusBadge status={u.status} />{u.locked && u.status !== 'LOCKED' && <Badge tone="red">{t('Locked out')}</Badge>}</span>}
        subtitle={<span className="mono">@{u.username}{u.badgeNumber ? ` · ${u.badgeNumber}` : ''}</span>}
        actions={manage ? <Button variant="secondary" icon={<Pencil className="h-4 w-4" />} onClick={() => setEdit(true)}>{t('Edit profile')}</Button> : undefined}
      />
      {u.isSelf && <Alert tone="blue">{t('This is your own account. Status, credential and role changes must be made by another administrator.')}</Alert>}
      {u.status !== 'ACTIVE' && u.statusReason && <Alert tone="amber" title={t('Account {value} {statusChangedAt}', { value: u.status.toLowerCase(), statusChangedAt: formatDateTime(u.statusChangedAt) })}>{u.statusReason}</Alert>}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title={t('Profile')} className="lg:col-span-2">
          <KeyValue items={[
            { label: t('Home unit'), value: u.homeOrgUnit.name },
            { label: t('Email'), value: u.email ?? '—' },
            { label: t('Rank'), value: u.rank ?? '—' },
            { label: t('Designation'), value: u.designation ?? '—' },
            { label: t('Phone'), value: u.phone ?? '—' },
            { label: t('Created'), value: `${formatDateTime(u.createdAt)}${u.createdBy ? ` by ${u.createdBy.fullName}` : ''}` },
          ]} />
        </Card>
        <Card title={t('Security')}>
          <KeyValue columns={1} items={[
            { label: t('Last sign-in'), value: `${formatDateTime(u.lastLoginAt)}${u.lastLoginIp ? ` from ${u.lastLoginIp}` : ''}` },
            { label: t('MFA'), value: u.mfaEnabled ? <Badge tone="green">{t('Enrolled')}{' '}{formatDateTime(u.mfaEnrolledAt)}</Badge> : <Badge>{t('Not enrolled')}</Badge> },
            { label: t('Password'), value: `${u.mustChangePassword ? 'Must change at next sign-in · ' : ''}changed ${formatDateTime(u.passwordChangedAt)}` },
            { label: t('Failed sign-ins'), value: `${u.failedLoginCount}${u.lockedUntil ? ` · locked until ${formatDateTime(u.lockedUntil)}` : ''}` },
            { label: t('Active sessions'), value: u.activeSessions },
          ]} />
          {manage && (
            <div className="mt-4 flex flex-wrap gap-2">
              {u.status === 'ACTIVE' && <Button size="sm" variant="danger" icon={<UserX className="h-4 w-4" />} onClick={() => { act.reset(); setAction('DISABLED'); }}>{t('Disable')}</Button>}
              {u.status === 'ACTIVE' && <Button size="sm" variant="secondary" icon={<Lock className="h-4 w-4" />} onClick={() => { act.reset(); setAction('LOCKED'); }}>{t('Lock')}</Button>}
              {u.status !== 'ACTIVE' && u.status !== 'LOCKED' && <Button size="sm" variant="success" icon={<UserCheck className="h-4 w-4" />} onClick={() => { act.reset(); setAction('ACTIVE'); }}>{t('Re-activate')}</Button>}
              {(u.locked || u.status === 'LOCKED') && u.status !== 'DISABLED' && <Button size="sm" variant="secondary" icon={<Unlock className="h-4 w-4" />} onClick={() => { act.reset(); setAction('unlock'); }}>{t('Unlock')}</Button>}
              <Button size="sm" variant="secondary" icon={<KeyRound className="h-4 w-4" />} onClick={() => { act.reset(); setAction('reset-password'); }}>{t('Reset password')}</Button>
              {u.mfaEnabled && <Button size="sm" variant="secondary" icon={<ShieldOff className="h-4 w-4" />} onClick={() => { act.reset(); setAction('reset-mfa'); }}>{t('Reset MFA')}</Button>}
            </div>
          )}
        </Card>
      </div>
      <Card title={t('Role assignments')} bodyClassName="p-0" actions={manageRoles && u.status !== 'DISABLED' ? <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setGrant(true)}>{t('Grant role')}</Button> : undefined}>
        <DataTable caption={t('Role assignments')} columns={roleCols} rows={u.roles} rowKey={(r) => r.id} empty={<EmptyState title={t('No roles')} description={t('This account has no permissions.')} />} />
      </Card>
      <Card title={t('Active sessions')} bodyClassName="p-0" actions={manage && (sessions.data?.items.length ?? 0) > 0 ? <Button size="sm" variant="secondary" icon={<LogOut className="h-4 w-4" />} onClick={() => { act.reset(); setAction('revoke-all'); }}>{t('Revoke all')}</Button> : undefined}>
        <DataTable caption={t('Active sessions')} columns={sessCols} rows={sessions.data?.items} rowKey={(r) => r.id} loading={sessions.isFetching} error={sessions.error} onRetry={() => void sessions.refetch()} empty={<EmptyState title={t('No active sessions')} />} />
      </Card>

      {edit && <EditProfileModal user={u} onClose={() => setEdit(false)} />}
      {grant && <GrantRoleModal user={u} onClose={() => setGrant(false)} />}
      <ConfirmDialog
        open={!!cfg}
        title={cfg?.title ?? ''}
        message={<>{cfg?.message} <strong>{u.fullName}</strong> (@{u.username}).</>}
        confirmLabel={cfg?.label}
        variant={cfg?.variant}
        requireReason={cfg?.reason}
        loading={act.isPending}
        error={act.error}
        onConfirm={(reason) => action && act.mutate({ a: action, reason })}
        onCancel={() => setAction(null)}
      />
      <ConfirmDialog
        open={!!revoke}
        title={t('Revoke role')}
        message={revoke ? <>{t('Remove')}{' '}<strong>{revoke.roleName}</strong>{' '}{t('at')}{' '}<strong>{revoke.orgUnitName}</strong>{' '}{t('from')}{' '}{u.fullName}{t('? Takes effect immediately.')}</> : ''}
        confirmLabel={t('Revoke')}
        variant="danger"
        requireReason
        loading={revokeRole.isPending}
        error={revokeRole.error}
        onConfirm={(reason) => revoke && revokeRole.mutate({ assignment: revoke, reason })}
        onCancel={() => setRevoke(null)}
      />
      <OneTimePasswordDialog password={password} username={u.username} onClose={() => setPassword(null)} />
    </div>
  );
}
