import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, RotateCw } from 'lucide-react';
import { INTEGRATION_SCOPES } from '@ksp/shared';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { OrgUnitSelect } from '@/components/pickers';
import { Alert, Badge, Button, Card, Checkbox, ConfirmDialog, CopyButton, DataTable, EmptyState, Field, Input, Modal, PageHeader, StatusBadge, Textarea, useToast, type Column } from '@/components/ui';
import type { ApiClient } from './types';

import { t } from '@/lib/i18n';
interface SecretResult { client: ApiClient; clientId: string; clientSecret: string }

function SecretOnceModal({ result, onClose }: { result: SecretResult; onClose: () => void }) {
  return (
    <Modal open onClose={onClose} title={t('Client credentials')} footer={<Button onClick={onClose}>{t('I have stored the secret')}</Button>}>
      <div className="space-y-3 text-sm">
        <Alert tone="amber" title={t('Shown only once')}>{t('Copy the secret now and store it in the client system\'s secret store. It cannot be displayed again; rotate it if it is lost.')}</Alert>
        <div><p className="text-xs text-ink-500">{t('Client ID')}</p><div className="flex items-center gap-2"><code className="mono break-all">{result.clientId}</code><CopyButton value={result.clientId} label={t('Copy client ID')} /></div></div>
        <div><p className="text-xs text-ink-500">{t('Client secret')}</p><div className="flex items-center gap-2"><code className="mono break-all">{result.clientSecret}</code><CopyButton value={result.clientSecret} label={t('Copy secret')} /></div></div>
        <p className="text-xs text-ink-600">{t('Use HTTP Basic authentication (')}<span className="mono">{t('client_id:secret')}</span>{t(') against')}{' '}<span className="mono">{t('/api/v1/integration/*')}</span>.</p>
      </div>
    </Modal>
  );
}

export function ApiClientsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['api-clients'], queryFn: () => api.get<{ items: ApiClient[] }>('/api-clients') });
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<SecretResult | null>(null);
  const [revoking, setRevoking] = useState<ApiClient | null>(null);
  const [rotating, setRotating] = useState<ApiClient | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['api-clients'] });
  const revoke = useMutation({ mutationFn: ({ id, reason }: { id: string; reason: string }) => api.post(`/api-clients/${id}/revoke`, { reason }), onSuccess: () => { setRevoking(null); toast.success('Client revoked'); refresh(); } });
  const rotate = useMutation({ mutationFn: (id: string) => api.post<SecretResult>(`/api-clients/${id}/rotate-secret`), onSuccess: (r) => { setRotating(null); setSecret(r); refresh(); } });
  const cols: Column<ApiClient>[] = [
    { key: 'name', header: t('Client'), render: (r) => <div><p className="font-medium">{r.name}</p><p className="mono text-xs text-ink-500">{r.clientId}</p></div> },
    { key: 'scopes', header: t('Scopes'), render: (r) => <div className="flex flex-wrap gap-1">{r.scopes.map((s) => <Badge key={s}>{s}</Badge>)}</div> },
    { key: 'org', header: t('Jurisdiction'), render: (r) => r.orgUnit.name },
    { key: 'ips', header: t('Allowed IPs'), render: (r) => <span className="mono text-xs">{r.allowedIps.length ? r.allowedIps.join(', ') : t('any')}</span> },
    { key: 'rate', header: t('Rate'), render: (r) => <span className="text-xs">{r.rateLimitPerMinute}{t('/min')}</span> },
    { key: 'status', header: t('Status'), render: (r) => <StatusBadge status={r.status} /> },
    { key: 'used', header: t('Last used'), render: (r) => <span className="text-xs">{formatDateTime(r.lastUsedAt)}</span> },
    {
      key: 'act', header: <span className="sr-only">{t('Actions')}</span>,
      render: (r) => (r.status === 'REVOKED' ? null : (
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" icon={<RotateCw className="h-4 w-4" />} onClick={() => { rotate.reset(); setRotating(r); }}>{t('Rotate')}</Button>
          <Button size="sm" variant="ghost" onClick={() => { revoke.reset(); setRevoking(r); }}>{t('Revoke')}</Button>
        </div>
      )),
    },
  ];
  return (
    <div className="space-y-4">
      <PageHeader title={t('Integration API clients')} subtitle={t('Machine clients of the evidence search & retrieval REST API (/api/v1/integration).')} actions={<Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>{t('New client')}</Button>} />
      <Card bodyClassName="p-0">
        <DataTable caption={t('API clients')} columns={cols} rows={q.data?.items} rowKey={(r) => r.id} loading={q.isFetching} error={q.error} onRetry={() => void q.refetch()} empty={<EmptyState title={t('No API clients')} icon={<KeyRound className="h-8 w-8" />} />} />
      </Card>
      {creating && <CreateClientModal onClose={() => setCreating(false)} onCreated={(r) => { setCreating(false); setSecret(r); refresh(); }} />}
      {secret && <SecretOnceModal result={secret} onClose={() => setSecret(null)} />}
      <ConfirmDialog open={!!revoking} title={t('Revoke API client')} message={<>{t('Revoke')}{' '}<strong>{revoking?.name}</strong>{t('? It stops working immediately, including outstanding download links.')}</>} confirmLabel={t('Revoke')} variant="danger" requireReason loading={revoke.isPending} error={revoke.error} onConfirm={(reason) => revoking && revoke.mutate({ id: revoking.id, reason })} onCancel={() => setRevoking(null)} />
      <ConfirmDialog open={!!rotating} title={t('Rotate client secret')} message={t('A new secret is generated and shown once; the current secret stops working immediately.')} confirmLabel={t('Rotate secret')} loading={rotate.isPending} error={rotate.error} onConfirm={() => rotating && rotate.mutate(rotating.id)} onCancel={() => setRotating(null)} />
    </div>
  );
}

function CreateClientModal({ onClose, onCreated }: { onClose: () => void; onCreated: (r: SecretResult) => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [orgUnitId, setOrgUnitId] = useState('');
  const [scopes, setScopes] = useState<string[]>(['evidence:read']);
  const [ips, setIps] = useState('');
  const [expires, setExpires] = useState('');
  const [rate, setRate] = useState('60');
  const m = useMutation({
    mutationFn: () => api.post<SecretResult>('/api-clients', {
      name: name.trim(), description: description.trim() || null, orgUnitId, scopes, allowedIps: ips.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean),
      expiresAt: expires ? new Date(`${expires}T23:59:59`).toISOString() : null, rateLimitPerMinute: Number(rate),
    }),
    onSuccess: onCreated,
  });
  return (
    <Modal open onClose={onClose} title={t('New API client')} size="lg" footer={<><Button variant="secondary" onClick={onClose}>{t('Cancel')}</Button><Button onClick={() => m.mutate()} loading={m.isPending} disabled={name.trim().length < 3 || !orgUnitId || !scopes.length}>{t('Create')}</Button></>}>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label={t('Name')} required htmlFor="ac-name"><Input id="ac-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('e.g. CCTNS bridge (Bengaluru)')} /></Field>
        <Field label={t('Jurisdiction (org unit)')} required htmlFor="ac-org" hint={t('The client only sees evidence/cases within this unit\'s subtree.')}><OrgUnitSelect id="ac-org" scope="integrations:manage" value={orgUnitId} onChange={setOrgUnitId} emptyLabel={t('Select unit')} /></Field>
        <div className="md:col-span-2"><Field label={t('Description')} htmlFor="ac-desc"><Textarea id="ac-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} /></Field></div>
        <fieldset className="md:col-span-2">
          <legend className="text-sm font-medium text-ink-800">{t('Scopes')}</legend>
          <p className="text-xs text-ink-500">{t('You can only give a client rights you hold yourself at the chosen unit (e.g. an Integration officer holding evidence access). Every client is audited.')}</p>
          <div className="mt-1 flex flex-wrap gap-4">
            {INTEGRATION_SCOPES.map((s) => <Checkbox key={s} label={s} checked={scopes.includes(s)} onChange={(v) => setScopes((x) => (v ? [...x, s] : x.filter((y) => y !== s)))} />)}
          </div>
        </fieldset>
        <Field label={t('Allowed IPs / CIDRs')} htmlFor="ac-ips" hint={t('Comma or space separated; empty = any address (not recommended).')}><Input id="ac-ips" value={ips} onChange={(e) => setIps(e.target.value)} placeholder="10.20.0.0/16, 192.0.2.10" /></Field>
        <Field label={t('Expires on')} htmlFor="ac-exp"><Input id="ac-exp" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} /></Field>
        <Field label={t('Rate limit (requests/minute)')} htmlFor="ac-rate"><Input id="ac-rate" type="number" min={1} max={10000} value={rate} onChange={(e) => setRate(e.target.value)} /></Field>
      </div>
      {m.error ? <div className="mt-3"><Alert tone="red">{errorMessage(m.error)}</Alert></div> : null}
    </Modal>
  );
}
