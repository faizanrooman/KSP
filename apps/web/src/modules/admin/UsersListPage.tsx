import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ShieldCheck, UserPlus } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useUrlState } from '@/lib/hooks';
import { formatDateTime, titleCase } from '@/lib/format';
import { OrgUnitSelect } from '@/components/pickers';
import { Badge, Button, Card, DataTable, EmptyState, Field, Input, PageHeader, Pagination, Select, StatusBadge, type Column } from '@/components/ui';
import { useRoles } from './shared';
import { USER_STATUSES, type Paged, type UserListItem } from './types';

const DEFAULTS = { q: '', status: '', orgUnitId: '', roleCode: '', sort: 'fullName', page: '1', pageSize: '25' };

export function UsersListPage() {
  const [s, set, reset] = useUrlState(DEFAULTS);
  const { can } = useAuth();
  const navigate = useNavigate();
  const roles = useRoles(can('roles:read'));
  const query = useMemo(() => ({ q: s.q || undefined, status: s.status || undefined, orgUnitId: s.orgUnitId || undefined, roleCode: s.roleCode || undefined, sort: s.sort, page: s.page, pageSize: s.pageSize }), [s]);
  const list = useQuery({ queryKey: ['admin', 'users', query], queryFn: () => api.get<Paged<UserListItem>>('/users', query), placeholderData: keepPreviousData });
  const filtered = !!(s.q || s.status || s.orgUnitId || s.roleCode);

  const cols: Column<UserListItem>[] = [
    {
      key: 'name', header: 'Name', sortKey: 'fullName',
      render: (r) => (
        <div>
          <Link to={`/admin/users/${r.id}`} className="font-medium text-brand-800 hover:underline" onClick={(e) => e.stopPropagation()}>{r.fullName}</Link>
          <p className="mono text-xs text-ink-500">@{r.username}{r.badgeNumber ? ` · ${r.badgeNumber}` : ''}</p>
        </div>
      ),
    },
    { key: 'rank', header: 'Rank / designation', render: (r) => <span className="text-sm">{[r.rank, r.designation].filter(Boolean).join(' · ') || '—'}</span> },
    { key: 'unit', header: 'Home unit', render: (r) => r.homeOrgUnit.name },
    { key: 'roles', header: 'Roles', render: (r) => (<div className="flex flex-wrap gap-1">{r.roleCodes.length ? r.roleCodes.map((c) => <Badge key={c}>{titleCase(c)}</Badge>) : <span className="text-xs text-ink-500">None</span>}</div>) },
    {
      key: 'status', header: 'Status', sortKey: 'status',
      render: (r) => (
        <div className="flex flex-col items-start gap-1">
          <StatusBadge status={r.status} />
          {r.locked && r.status !== 'LOCKED' && <Badge tone="red">Locked out</Badge>}
          {r.mfaEnabled && <span className="inline-flex items-center gap-1 text-xs text-emerald-700"><ShieldCheck className="h-3 w-3" aria-hidden />MFA</span>}
        </div>
      ),
    },
    { key: 'last', header: 'Last sign-in', sortKey: 'lastLoginAt', render: (r) => <span className="whitespace-nowrap text-sm">{formatDateTime(r.lastLoginAt)}</span> },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Users"
        subtitle="Accounts whose home unit is within your jurisdiction."
        actions={can('users:manage') ? <Button icon={<UserPlus className="h-4 w-4" />} onClick={() => navigate('/admin/users/new')}>New user</Button> : undefined}
      />
      <Card>
        <form className="grid gap-3 md:grid-cols-2 xl:grid-cols-5" onSubmit={(e) => { e.preventDefault(); set({ q: String(new FormData(e.currentTarget).get('q') ?? '').trim() }); }}>
          <div className="xl:col-span-2">
            <Field label="Search" htmlFor="u-q">
              <Input id="u-q" name="q" defaultValue={s.q} key={s.q} placeholder="Name, username, badge or email…" />
            </Field>
          </div>
          <Field label="Unit (incl. sub-units)" htmlFor="u-org">
            <OrgUnitSelect id="u-org" scope="users:read" value={s.orgUnitId} onChange={(v) => set({ orgUnitId: v })} />
          </Field>
          <Field label="Status" htmlFor="u-status">
            <Select id="u-status" value={s.status} onChange={(e) => set({ status: e.target.value })}>
              <option value="">All statuses</option>
              {USER_STATUSES.map((x) => <option key={x} value={x}>{titleCase(x)}</option>)}
            </Select>
          </Field>
          <Field label="Role" htmlFor="u-role">
            <Select id="u-role" value={s.roleCode} onChange={(e) => set({ roleCode: e.target.value })} disabled={!roles.data}>
              <option value="">Any role</option>
              {roles.data?.items.map((r) => <option key={r.id} value={r.code}>{r.name}</option>)}
            </Select>
          </Field>
          <div className="flex items-end gap-2 md:col-span-2 xl:col-span-5">
            <Button type="submit">Search</Button>
            {filtered && <Button variant="ghost" onClick={reset}>Clear filters</Button>}
          </div>
        </form>
      </Card>
      <Card bodyClassName="p-0">
        <DataTable
          caption="Users"
          columns={cols}
          rows={list.data?.items}
          rowKey={(r) => r.id}
          loading={list.isFetching}
          error={list.error}
          onRetry={() => void list.refetch()}
          sort={s.sort}
          onSort={(sort) => set({ sort })}
          onRowClick={(r) => navigate(`/admin/users/${r.id}`)}
          empty={<EmptyState title={filtered ? 'No users match these filters' : 'No users in your jurisdiction'} action={filtered ? <Button variant="secondary" onClick={reset}>Clear filters</Button> : undefined} />}
        />
        {list.data && <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={(p) => set({ page: String(p) })} />}
      </Card>
    </div>
  );
}
