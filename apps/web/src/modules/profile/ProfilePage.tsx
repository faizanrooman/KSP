import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import { Badge, Button, Card, ConfirmDialog, DataTable, Field, Input, KeyValue, PageHeader, useToast } from '@/components/ui';
import { ChangePasswordPage, MfaEnrollPanel } from '@/pages/AuthPages';

import { t } from '@/lib/i18n';
interface SessionRow {
  id: string;
  created_at: string;
  last_seen_at: string;
  ip: string | null;
  user_agent: string | null;
  mfa_verified: boolean;
  current: boolean;
}

/** "Chrome on Linux" from a raw user-agent string (the full string stays available as a tooltip). */
function describeAgent(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : null;
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : null;
  if (!browser && !os) return ua.slice(0, 60);
  return [browser ?? 'Browser', os && `on ${os}`].filter(Boolean).join(' ');
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
      <PageHeader title={t('My profile')} subtitle={t('Account details, security settings and active sessions.')} />
      <div className="grid gap-5 xl:grid-cols-2">
        <Card title={t('Account')}>
          <KeyValue
            items={[
              { label: t('Name'), value: u.fullName },
              { label: t('Username'), value: u.username, mono: true },
              { label: t('Officer / badge ID'), value: u.badgeNumber },
              { label: t('Rank'), value: u.rank },
              { label: t('Email'), value: u.email },
              { label: t('Home unit'), value: u.homeOrgUnit.name },
            ]}
          />
          <div className="mt-4">
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-500">{t('Roles')}</p>
            <ul className="space-y-1 text-sm">
              {me.roles.map((r) => (
                <li key={`${r.code}-${r.orgUnitId}`}>
                  <Badge tone="blue">{r.name}</Badge> <span className="text-ink-500">{t('at')}</span> {r.orgUnitName}
                </li>
              ))}
            </ul>
          </div>
        </Card>
        <Card title={t('Two-step verification')} actions={u.mfaEnabled ? <Badge tone="green">{t('Enabled')}</Badge> : <Badge tone="amber">{t('Not enabled')}</Badge>}>
          {u.mfaEnabled ? (
            disabling ? (
              <form
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  disableMut.mutate();
                }}
              >
                <Field label={t('Password')} htmlFor="dpw" required>
                  <Input id="dpw" type="password" value={pw} onChange={(e) => setPw(e.target.value)} required />
                </Field>
                <Field label={t('Current authenticator code')} htmlFor="dcode" required>
                  <Input id="dcode" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required />
                </Field>
                <div className="flex gap-2">
                  <Button type="submit" variant="danger" loading={disableMut.isPending}>
                    {t('Disable')}
                  </Button>
                  <Button variant="secondary" onClick={() => setDisabling(false)}>
                    {t('Cancel')}
                  </Button>
                </div>
              </form>
            ) : (
              <div className="space-y-3 text-sm text-ink-600">
                <p>{t('Your account is protected by an authenticator app.')}</p>
                <Button variant="secondary" onClick={() => setDisabling(true)}>
                  {t('Disable two-step verification')}
                </Button>
              </div>
            )
          ) : (
            <MfaEnrollPanel />
          )}
        </Card>
        <Card title={t('Change password')}>
          <ChangePasswordPage />
        </Card>
        <Card title={t('Active sessions')} bodyClassName="p-0">
          <DataTable
            caption={t('Active sessions')}
            rows={sessions.data?.items}
            loading={sessions.isLoading}
            error={sessions.error}
            onRetry={() => void sessions.refetch()}
            rowKey={(r) => r.id}
            columns={[
              { key: 'device', header: t('Device'), render: (r) => <span className="text-sm" title={r.user_agent ?? undefined}>{describeAgent(r.user_agent)}</span> },
              { key: 'ip', header: t('IP'), render: (r) => <span className="mono">{r.ip ?? '—'}</span> },
              { key: 'seen', header: t('Last active'), className: 'whitespace-nowrap', render: (r) => formatDateTime(r.last_seen_at) },
              {
                key: 'act',
                header: <span className="sr-only">{t('Session actions')}</span>,
                render: (r) =>
                  r.current ? (
                    <Badge tone="green" className="whitespace-nowrap">{t('This session')}</Badge>
                  ) : (
                    <Button size="sm" variant="secondary" onClick={() => setRevoke(r)}>
                      {t('Revoke')}
                    </Button>
                  ),
              },
            ]}
          />
        </Card>
      </div>
      <ConfirmDialog
        open={!!revoke}
        title={t('Revoke session')}
        message={t('The device using this session will be signed out immediately.')}
        confirmLabel={t('Revoke')}
        variant="danger"
        loading={revokeMut.isPending}
        error={revokeMut.error}
        onCancel={() => setRevoke(null)}
        onConfirm={() => revoke && revokeMut.mutate(revoke.id)}
      />
    </div>
  );
}
