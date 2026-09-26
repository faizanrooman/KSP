import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import { Badge, Button, Card, ConfirmDialog, DataTable, Field, Input, KeyValue, PageHeader, useToast } from '@/components/ui';
import { ChangePasswordPage, MfaEnrollPanel } from '@/pages/AuthPages';

interface SessionRow {
  id: string;
  created_at: string;
  last_seen_at: string;
  ip: string | null;
  user_agent: string | null;
  mfa_verified: boolean;
  current: boolean;
}

export function ProfilePage() {
  const { me, refresh } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [revoke, setRevoke] = useState<SessionRow | null>(null);
  const [disabling, setDisabling] = useState(false);
  const [pw, setPw] = useState('');
  const [code, setCode] = useState('');
  const sessions = useQuery({ queryKey: ['auth', 'sessions'], queryFn: () => api.get<{ items: SessionRow[] }>('/auth/sessions') });
  const revokeMut = useMutation({
    mutationFn: (id: string) => api.delete(`/auth/sessions/${id}`),
    onSuccess: () => {
      toast.success('Session revoked');
      setRevoke(null);
      void qc.invalidateQueries({ queryKey: ['auth', 'sessions'] });
    },
  });
  const disableMut = useMutation({
    mutationFn: () => api.post('/auth/mfa/disable', { password: pw, code }),
    onSuccess: async () => {
      toast.success('Two-step verification disabled');
      setDisabling(false);
      await refresh();
    },
    onError: (e) => toast.error(e),
  });
  if (!me) return null;
  const u = me.user;

  return (
    <div className="space-y-5">
      <PageHeader title="My profile" subtitle="Account details, security settings and active sessions." />
      <div className="grid gap-5 xl:grid-cols-2">
        <Card title="Account">
          <KeyValue
            items={[
              { label: 'Name', value: u.fullName },
              { label: 'Username', value: u.username, mono: true },
              { label: 'Officer / badge ID', value: u.badgeNumber },
              { label: 'Rank', value: u.rank },
              { label: 'Email', value: u.email },
              { label: 'Home unit', value: u.homeOrgUnit.name },
            ]}
          />
          <div className="mt-4">
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-500">Roles</p>
            <ul className="space-y-1 text-sm">
              {me.roles.map((r) => (
                <li key={`${r.code}-${r.orgUnitId}`}>
                  <Badge tone="blue">{r.name}</Badge> <span className="text-ink-500">at</span> {r.orgUnitName}
                </li>
              ))}
            </ul>
          </div>
        </Card>
        <Card title="Two-step verification" actions={u.mfaEnabled ? <Badge tone="green">Enabled</Badge> : <Badge tone="amber">Not enabled</Badge>}>
          {u.mfaEnabled ? (
            disabling ? (
              <form
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  disableMut.mutate();
                }}
              >
                <Field label="Password" htmlFor="dpw" required>
                  <Input id="dpw" type="password" value={pw} onChange={(e) => setPw(e.target.value)} required />
                </Field>
                <Field label="Current authenticator code" htmlFor="dcode" required>
                  <Input id="dcode" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required />
                </Field>
                <div className="flex gap-2">
                  <Button type="submit" variant="danger" loading={disableMut.isPending}>
                    Disable
                  </Button>
                  <Button variant="secondary" onClick={() => setDisabling(false)}>
                    Cancel
                  </Button>
                </div>
              </form>
            ) : (
              <div className="space-y-3 text-sm text-ink-600">
                <p>Your account is protected by an authenticator app.</p>
                <Button variant="secondary" onClick={() => setDisabling(true)}>
                  Disable two-step verification
                </Button>
              </div>
            )
          ) : (
            <MfaEnrollPanel />
          )}
        </Card>
        <Card title="Change password">
          <ChangePasswordPage />
        </Card>
        <Card title="Active sessions" bodyClassName="p-0">
          <DataTable
            caption="Active sessions"
            rows={sessions.data?.items}
            loading={sessions.isLoading}
            error={sessions.error}
            onRetry={() => void sessions.refetch()}
            rowKey={(r) => r.id}
            columns={[
              { key: 'device', header: 'Device', render: (r) => <span className="line-clamp-2 max-w-xs text-xs">{r.user_agent ?? 'Unknown'}</span> },
              { key: 'ip', header: 'IP', render: (r) => <span className="mono">{r.ip ?? '—'}</span> },
              { key: 'seen', header: 'Last active', render: (r) => formatDateTime(r.last_seen_at) },
              {
                key: 'act',
                header: <span className="sr-only">Session actions</span>,
                render: (r) =>
                  r.current ? (
                    <Badge tone="green">This session</Badge>
                  ) : (
                    <Button size="sm" variant="secondary" onClick={() => setRevoke(r)}>
                      Revoke
                    </Button>
                  ),
              },
            ]}
          />
        </Card>
      </div>
      <ConfirmDialog
        open={!!revoke}
        title="Revoke session"
        message="The device using this session will be signed out immediately."
        confirmLabel="Revoke"
        variant="danger"
        loading={revokeMut.isPending}
        error={revokeMut.error}
        onCancel={() => setRevoke(null)}
        onConfirm={() => revoke && revokeMut.mutate(revoke.id)}
      />
    </div>
  );
}
