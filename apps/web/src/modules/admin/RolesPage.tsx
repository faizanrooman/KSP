import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Plus } from 'lucide-react';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import { Alert, Badge, Button, Card, ConfirmDialog, DataTable, EmptyState, ErrorState, Field, Input, PageHeader, Spinner, Textarea, useToast, type Column } from '@/components/ui';
import { useRoles } from './shared';
import type { PermissionCatalogue, Role } from './types';

function useCatalogue() {
  return useQuery({ queryKey: ['admin', 'permissions'], queryFn: () => api.get<PermissionCatalogue>('/roles/permissions'), staleTime: 10 * 60_000 });
}

export function RolesListPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const q = useRoles();
  const cols: Column<Role>[] = [
    { key: 'name', header: 'Role', render: (r) => (<div><p className="font-medium text-brand-800">{r.name} {r.isSystem && <Badge tone="blue">System</Badge>}</p><p className="mono text-xs text-ink-500">{r.code}</p>{r.description && <p className="text-xs text-ink-600">{r.description}</p>}</div>) },
    { key: 'perms', header: 'Permissions', render: (r) => r.permissions.length },
    { key: 'assign', header: 'Active assignments', render: (r) => r.assignmentCount },
    { key: 'updated', header: 'Updated', render: (r) => <span className="whitespace-nowrap text-sm">{formatDateTime(r.updatedAt)}</span> },
    { key: 'sod', header: <span className="sr-only">Warnings</span>, render: (r) => (r.sodViolations.length ? <Badge tone="red"><AlertTriangle className="mr-1 h-3 w-3" aria-hidden />SoD conflict</Badge> : null) },
  ];
  return (
    <div className="space-y-4">
      <PageHeader title="Roles & permissions" subtitle="A role is a permission set; it is granted to a user at an org unit and applies to that unit's whole subtree." actions={can('roles:manage') ? <Button icon={<Plus className="h-4 w-4" />} onClick={() => navigate('/admin/roles/new')}>New role</Button> : undefined} />
      <Card bodyClassName="p-0">
        <DataTable caption="Roles" columns={cols} rows={q.data?.items} rowKey={(r) => r.id} loading={q.isFetching} error={q.error} onRetry={() => void q.refetch()} onRowClick={(r) => navigate(`/admin/roles/${r.id}`)} empty={<EmptyState title="No roles" />} />
      </Card>
    </div>
  );
}

/** Permission matrix grouped by category, with live separation-of-duties feedback. */
function PermissionMatrix({ catalogue, value, onChange, readOnly }: { catalogue: PermissionCatalogue; value: Set<string>; onChange: (v: Set<string>) => void; readOnly: boolean }) {
  const conflicts = catalogue.sodConflicts.filter((c) => value.has(c.a) && value.has(c.b));
  const toggle = (code: string, on: boolean) => {
    const next = new Set(value);
    if (on) next.add(code);
    else next.delete(code);
    onChange(next);
  };
  return (
    <div className="space-y-3">
      {conflicts.length > 0 && (
        <Alert tone="red" title="Separation-of-duties conflict">
          <ul className="list-disc pl-5">{conflicts.map((c) => <li key={c.a + c.b}>{c.message} (<span className="mono">{c.a}</span> + <span className="mono">{c.b}</span>)</li>)}</ul>
        </Alert>
      )}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {catalogue.groups.map((g) => {
          const all = g.permissions.every((p) => value.has(p.code));
          return (
            <fieldset key={g.category} className="rounded-md border border-ink-200 p-3">
              <legend className="flex w-full items-center justify-between px-1 text-sm font-semibold text-ink-800">
                <span>{g.label}</span>
                {!readOnly && (
                  <button type="button" className="text-xs font-normal text-brand-700 hover:underline" onClick={() => { const next = new Set(value); g.permissions.forEach((p) => (all ? next.delete(p.code) : next.add(p.code))); onChange(next); }}>
                    {all ? 'Clear group' : 'Select group'}
                  </button>
                )}
              </legend>
              <ul className="space-y-1.5">
                {g.permissions.map((p) => {
                  const inConflict = conflicts.some((c) => c.a === p.code || c.b === p.code);
                  return (
                    <li key={p.code} className="flex items-start gap-2">
                      <input id={`perm-${p.code}`} type="checkbox" className="mt-0.5 h-4 w-4 rounded border-ink-300 text-brand-700 focus:ring-brand-500" checked={value.has(p.code)} disabled={readOnly} onChange={(e) => toggle(p.code, e.target.checked)} aria-describedby={`perm-${p.code}-d`} />
                      <label htmlFor={`perm-${p.code}`} className="text-sm">
                        <span className={inConflict ? 'mono font-semibold text-red-700' : 'mono text-ink-900'}>{p.code}</span>
                        {inConflict && <span className="sr-only"> (in conflict)</span>}
                        <span id={`perm-${p.code}-d`} className="block text-xs text-ink-500">{p.description}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </fieldset>
          );
        })}
      </div>
    </div>
  );
}

export function RoleDetailPage() {
  const { id = 'new' } = useParams();
  const isNew = id === 'new';
  const { can, me } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const catalogue = useCatalogue();
  const role = useQuery({ queryKey: ['admin', 'role', id], queryFn: () => api.get<Role>(`/roles/${id}`), enabled: !isNew });
  const [draft, setDraft] = useState<{ code: string; name: string; description: string; perms: Set<string> } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const current = useMemo(() => draft ?? (isNew ? { code: '', name: '', description: '', perms: new Set<string>() } : role.data ? { code: role.data.code, name: role.data.name, description: role.data.description ?? '', perms: new Set(role.data.permissions) } : null), [draft, isNew, role.data]);
  const holdsRole = !!role.data && !!me?.roles.some((r) => r.code === role.data!.code);
  const readOnly = !can('roles:manage');
  const save = useMutation({
    mutationFn: () => {
      const c = current!;
      const body = { name: c.name.trim(), description: c.description.trim() || null, permissions: [...c.perms] };
      return isNew ? api.post<Role>('/roles', { ...body, code: c.code.trim().toUpperCase() }) : api.patch<Role>(`/roles/${id}`, body);
    },
    onSuccess: (r) => {
      toast.success(isNew ? 'Role created' : 'Role updated');
      setDraft(null);
      void qc.invalidateQueries({ queryKey: ['admin', 'roles'] });
      qc.setQueryData(['admin', 'role', r.id], r);
      if (isNew) navigate(`/admin/roles/${r.id}`, { replace: true });
    },
  });
  const del = useMutation({
    mutationFn: () => api.delete(`/roles/${id}`),
    onSuccess: () => { toast.success('Role deleted'); void qc.invalidateQueries({ queryKey: ['admin', 'roles'] }); navigate('/admin/roles'); },
  });

  if (catalogue.isLoading || (!isNew && role.isLoading)) return <Spinner />;
  if (catalogue.error) return <ErrorState error={catalogue.error} onRetry={() => void catalogue.refetch()} />;
  if (role.error) return <ErrorState error={role.error} onRetry={() => void role.refetch()} title={role.error instanceof ApiError && role.error.status === 404 ? 'Role not found' : undefined} />;
  const c = current!;
  const set = (patch: Partial<typeof c>) => setDraft({ ...c, ...patch });
  const dirty = draft !== null;
  const valid = c.name.trim().length >= 3 && (!isNew || /^[A-Z][A-Z0-9_]{1,40}$/.test(c.code.trim().toUpperCase()));
  const err = save.error instanceof ApiError ? save.error : null;
  const missing = err?.code === 'PRIVILEGE_ESCALATION' ? ((err.details as { missing?: string[] })?.missing ?? []) : [];

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumb={<Link to="/admin/roles" className="hover:underline">Roles</Link>}
        title={isNew ? 'New role' : <span className="flex items-center gap-2">{role.data!.name} {role.data!.isSystem && <Badge tone="blue">System</Badge>}</span>}
        subtitle={isNew ? 'Custom roles start empty; grant only what the job requires.' : <span className="mono">{role.data!.code} · {role.data!.assignmentCount} active assignment(s)</span>}
        actions={!isNew && !readOnly && !role.data!.isSystem ? <Button variant="danger" disabled={role.data!.totalAssignmentCount > 0} title={role.data!.totalAssignmentCount > 0 ? 'Revoke all assignments first' : undefined} onClick={() => { del.reset(); setConfirmDelete(true); }}>Delete role</Button> : undefined}
      />
      {holdsRole && !readOnly && <Alert tone="blue">You hold this role yourself, so you cannot change its permissions (another administrator must).</Alert>}
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (valid) save.mutate(); }}>
        <Card title="Details">
          <div className="grid gap-3 sm:grid-cols-2">
            {isNew && (
              <Field label="Code" htmlFor="r-code" required hint="Upper-case letters, digits, underscore. Cannot be changed later.">
                <Input id="r-code" value={c.code} onChange={(e) => set({ code: e.target.value.toUpperCase() })} maxLength={41} />
              </Field>
            )}
            <Field label="Name" htmlFor="r-name" required>
              <Input id="r-name" value={c.name} onChange={(e) => set({ name: e.target.value })} maxLength={120} disabled={readOnly} />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Description" htmlFor="r-desc">
                <Textarea id="r-desc" rows={2} value={c.description} onChange={(e) => set({ description: e.target.value })} maxLength={1000} disabled={readOnly} />
              </Field>
            </div>
          </div>
        </Card>
        <Card title={`Permissions (${c.perms.size})`}>
          <PermissionMatrix catalogue={catalogue.data!} value={c.perms} onChange={(perms) => set({ perms })} readOnly={readOnly || holdsRole} />
        </Card>
        {save.error ? (
          <Alert tone="red" title={err?.code === 'SOD_VIOLATION' ? 'Separation of duties' : err?.code === 'PRIVILEGE_ESCALATION' ? 'Not allowed' : 'Could not save'}>
            {errorMessage(save.error)}
            {missing.length > 0 && <p className="mt-1">You do not hold: <span className="mono">{missing.join(', ')}</span></p>}
          </Alert>
        ) : null}
        {!readOnly && (
          <div className="flex justify-end gap-2">
            {dirty && <Button variant="secondary" onClick={() => { setDraft(null); save.reset(); }}>Discard changes</Button>}
            <Button type="submit" disabled={!valid || (!isNew && !dirty)} loading={save.isPending}>{isNew ? 'Create role' : 'Save changes'}</Button>
          </div>
        )}
      </form>
      <ConfirmDialog open={confirmDelete} title="Delete role" message={`Delete the custom role “${role.data?.name ?? ''}”? This cannot be undone.`} confirmLabel="Delete" variant="danger" loading={del.isPending} error={del.error} onConfirm={() => del.mutate()} onCancel={() => setConfirmDelete(false)} />
    </div>
  );
}
