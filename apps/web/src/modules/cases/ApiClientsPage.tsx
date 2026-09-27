import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, RotateCw } from 'lucide-react';
import { INTEGRATION_SCOPES } from '@ksp/shared';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { OrgUnitSelect } from '@/components/pickers';
import { Alert, Badge, Button, Card, Checkbox, ConfirmDialog, CopyButton, DataTable, EmptyState, Field, Input, Modal, PageHeader, StatusBadge, Textarea, useToast, type Column } from '@/components/ui';
import type { ApiClient } from './types';

interface SecretResult { client: ApiClient; clientId: string; clientSecret: string }

function SecretOnceModal({ result, onClose }: { result: SecretResult; onClose: () => void }) {
  return (
    <Modal open onClose={onClose} title="Client credentials" footer={<Button onClick={onClose}>I have stored the secret</Button>}>
      <div className="space-y-3 text-sm">
        <Alert tone="amber" title="Shown only once">Copy the secret now and store it in the client system's secret store. It cannot be displayed again; rotate it if it is lost.</Alert>
        <div><p className="text-xs text-ink-500">Client ID</p><div className="flex items-center gap-2"><code className="mono break-all">{result.clientId}</code><CopyButton value={result.clientId} label="Copy client ID" /></div></div>
        <div><p className="text-xs text-ink-500">Client secret</p><div className="flex items-center gap-2"><code className="mono break-all">{result.clientSecret}</code><CopyButton value={result.clientSecret} label="Copy secret" /></div></div>
        <p className="text-xs text-ink-600">Use HTTP Basic authentication (<span className="mono">client_id:secret</span>) against <span className="mono">/api/v1/integration/*</span>.</p>
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
    { key: 'name', header: 'Client', render: (r) => <div><p className="font-medium">{r.name}</p><p className="mono text-xs text-ink-500">{r.clientId}</p></div> },
    { key: 'scopes', header: 'Scopes', render: (r) => <div className="flex flex-wrap gap-1">{r.scopes.map((s) => <Badge key={s}>{s}</Badge>)}</div> },
    { key: 'org', header: 'Jurisdiction', render: (r) => r.orgUnit.name },
    { key: 'ips', header: 'Allowed IPs', render: (r) => <span className="mono text-xs">{r.allowedIps.length ? r.allowedIps.join(', ') : 'any'}</span> },
    { key: 'rate', header: 'Rate', render: (r) => <span className="text-xs">{r.rateLimitPerMinute}/min</span> },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'used', header: 'Last used', render: (r) => <span className="text-xs">{formatDateTime(r.lastUsedAt)}</span> },
    {
      key: 'act', header: <span className="sr-only">Actions</span>,
      render: (r) => (r.status === 'REVOKED' ? null : (
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" icon={<RotateCw className="h-4 w-4" />} onClick={() => { rotate.reset(); setRotating(r); }}>Rotate</Button>
          <Button size="sm" variant="ghost" onClick={() => { revoke.reset(); setRevoking(r); }}>Revoke</Button>
        </div>
      )),
    },
  ];
  return (
    <div className="space-y-4">
      <PageHeader title="Integration API clients" subtitle="Machine clients of the evidence search & retrieval REST API (/api/v1/integration)." actions={<Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>New client</Button>} />
      <Card bodyClassName="p-0">
        <DataTable caption="API clients" columns={cols} rows={q.data?.items} rowKey={(r) => r.id} loading={q.isFetching} error={q.error} onRetry={() => void q.refetch()} empty={<EmptyState title="No API clients" icon={<KeyRound className="h-8 w-8" />} />} />
      </Card>
      {creating && <CreateClientModal onClose={() => setCreating(false)} onCreated={(r) => { setCreating(false); setSecret(r); refresh(); }} />}
      {secret && <SecretOnceModal result={secret} onClose={() => setSecret(null)} />}
      <ConfirmDialog open={!!revoking} title="Revoke API client" message={<>Revoke <strong>{revoking?.name}</strong>? It stops working immediately, including outstanding download links.</>} confirmLabel="Revoke" variant="danger" requireReason loading={revoke.isPending} error={revoke.error} onConfirm={(reason) => revoking && revoke.mutate({ id: revoking.id, reason })} onCancel={() => setRevoking(null)} />
      <ConfirmDialog open={!!rotating} title="Rotate client secret" message="A new secret is generated and shown once; the current secret stops working immediately." confirmLabel="Rotate secret" loading={rotate.isPending} error={rotate.error} onConfirm={() => rotating && rotate.mutate(rotating.id)} onCancel={() => setRotating(null)} />
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
    <Modal open onClose={onClose} title="New API client" size="lg" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => m.mutate()} loading={m.isPending} disabled={name.trim().length < 3 || !orgUnitId || !scopes.length}>Create</Button></>}>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Name" required htmlFor="ac-name"><Input id="ac-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. CCTNS bridge (Bengaluru)" /></Field>
        <Field label="Jurisdiction (org unit)" required htmlFor="ac-org" hint="The client only sees evidence/cases within this unit's subtree."><OrgUnitSelect id="ac-org" value={orgUnitId} onChange={setOrgUnitId} emptyLabel="Select unit" /></Field>
        <div className="md:col-span-2"><Field label="Description" htmlFor="ac-desc"><Textarea id="ac-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} /></Field></div>
        <fieldset className="md:col-span-2">
          <legend className="text-sm font-medium text-ink-800">Scopes</legend>
          <div className="mt-1 flex flex-wrap gap-4">
            {INTEGRATION_SCOPES.map((s) => <Checkbox key={s} label={s} checked={scopes.includes(s)} onChange={(v) => setScopes((x) => (v ? [...x, s] : x.filter((y) => y !== s)))} />)}
          </div>
        </fieldset>
        <Field label="Allowed IPs / CIDRs" htmlFor="ac-ips" hint="Comma or space separated; empty = any address (not recommended)."><Input id="ac-ips" value={ips} onChange={(e) => setIps(e.target.value)} placeholder="10.20.0.0/16, 192.0.2.10" /></Field>
        <Field label="Expires on" htmlFor="ac-exp"><Input id="ac-exp" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} /></Field>
        <Field label="Rate limit (requests/minute)" htmlFor="ac-rate"><Input id="ac-rate" type="number" min={1} max={10000} value={rate} onChange={(e) => setRate(e.target.value)} /></Field>
      </div>
      {m.error ? <div className="mt-3"><Alert tone="red">{errorMessage(m.error)}</Alert></div> : null}
    </Modal>
  );
}
