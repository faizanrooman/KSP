import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Plug, Plus } from 'lucide-react';
import { INTEGRATION_ADAPTERS, INTEGRATION_AUTH_TYPES, INTEGRATION_SYSTEM_TYPES } from '@ksp/shared';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime, titleCase } from '@/lib/format';
import { Alert, Badge, Button, Card, DataTable, EmptyState, ErrorState, Field, Input, Modal, PageHeader, Pagination, Select, Spinner, useToast, type Column } from '@/components/ui';
import { VerificationBadge } from './FirPages';
import type { IntegrationSystem, Paged, SyncLogItem } from './types';

import { t as tr } from '@/lib/i18n';
export function IntegrationsPage() {
  const q = useQuery({ queryKey: ['integrations', 'systems'], queryFn: () => api.get<{ items: IntegrationSystem[] }>('/integrations/systems') });
  const [editing, setEditing] = useState<IntegrationSystem | 'new' | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const cols: Column<IntegrationSystem>[] = [
    { key: 'name', header: tr('System'), render: (r) => <div><p className="font-medium">{r.name}</p><p className="mono text-xs text-ink-500">{r.code}</p></div> },
    { key: 'type', header: tr('Type'), render: (r) => titleCase(r.systemType) },
    { key: 'adapter', header: tr('Adapter'), render: (r) => <span className="mono text-sm">{r.adapter}</span> },
    { key: 'verified', header: tr('Contract'), render: (r) => <VerificationBadge status={r.verificationStatus} /> },
    { key: 'enabled', header: tr('State'), render: (r) => <Badge tone={r.enabled ? 'green' : 'gray'}>{r.enabled ? tr('Enabled') : tr('Disabled')}</Badge> },
    { key: 'last', header: tr('Last activity'), render: (r) => <div className="text-xs">{formatDateTime(r.lastSyncAt)}<p className="text-ink-500">{r.lastStatus ?? ''}</p></div> },
  ];
  const sel = q.data?.items.find((s) => s.id === selected) ?? null;
  return (
    <div className="space-y-4">
      <PageHeader title={tr('External integrations')} subtitle={tr('CCTNS, FIR systems, case diaries and digital evidence repositories.')} actions={<Button icon={<Plus className="h-4 w-4" />} onClick={() => setEditing('new')}>{tr('Add system')}</Button>} />
      <Alert tone="amber" title={tr('External API contracts are not defined in the specification')}>
        {tr('The')}<span className="mono">{tr('http-json')}</span>{' '}{tr('adapter implements an assumed contract and is')}{' '}<strong>{tr('UNVERIFIED')}</strong>{' '}{tr('until a live contract test (Test with probe) passes against the real system.')}{' '}<span className="mono">{tr('fixture')}</span>{tr('systems return synthetic data only.')}
      </Alert>
      <Card bodyClassName="p-0">
        <DataTable caption={tr('Integration systems')} columns={cols} rows={q.data?.items} rowKey={(r) => r.id} loading={q.isFetching} error={q.error} onRetry={() => void q.refetch()} onRowClick={(r) => setSelected(r.id)} empty={<EmptyState title={tr('No integrations configured')} icon={<Plug className="h-8 w-8" />} />} />
      </Card>
      {sel && <SystemPanel sys={sel} onEdit={() => setEditing(sel)} />}
      {editing && <SystemFormModal sys={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function SystemPanel({ sys, onEdit }: { sys: IntegrationSystem; onEdit: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [probe, setProbe] = useState({ stationCode: '', year: String(new Date().getFullYear()), firNumber: '', caseRef: '', evidenceRef: '' });
  const log = useQuery({ queryKey: ['integrations', 'log', sys.id, page], queryFn: () => api.get<Paged<SyncLogItem>>(`/integrations/systems/${sys.id}/log`, { page, pageSize: 20 }), placeholderData: keepPreviousData });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['integrations'] });
  };
  const toggle = useMutation({ mutationFn: () => api.post(`/integrations/systems/${sys.id}/${sys.enabled ? 'disable' : 'enable'}`), onSuccess: () => { toast.success(sys.enabled ? 'System disabled' : 'System enabled'); refresh(); }, onError: (e) => toast.error(e) });
  const test = useMutation({
    mutationFn: (withProbe: boolean) => {
      let p: Record<string, unknown> | undefined;
      if (withProbe) {
        if (sys.systemType === 'CCTNS' || sys.systemType === 'FIR') p = { stationCode: probe.stationCode.trim(), year: Number(probe.year), firNumber: probe.firNumber.trim() };
        else if (sys.systemType === 'CASE_DIARY') p = { caseRef: probe.caseRef.trim() };
        else p = { evidenceRef: probe.evidenceRef.trim() };
      }
      return api.post<{ ok: boolean; errorCode: string | null; error: string | null; steps: Array<{ step: string; ok: boolean; detail?: string }>; verified: boolean; note: string; latencyMs: number }>(`/integrations/systems/${sys.id}/test`, p ? { probe: p } : {});
    },
    onSuccess: refresh,
  });
  const isFir = sys.systemType === 'CCTNS' || sys.systemType === 'FIR';
  const logCols: Column<SyncLogItem>[] = [
    { key: 'at', header: tr('Time'), render: (r) => <span className="whitespace-nowrap text-xs">{formatDateTime(r.createdAt)}</span> },
    { key: 'op', header: tr('Operation'), render: (r) => <span className="text-xs">{r.direction} · {r.operation}{r.requestRef ? ` · ${r.requestRef}` : ''}</span> },
    { key: 'st', header: tr('Result'), render: (r) => <Badge tone={r.status === 'SUCCESS' ? 'green' : 'red'}>{titleCase(r.status)}</Badge> },
    { key: 'err', header: tr('Detail'), render: (r) => <span className="text-xs text-ink-700">{r.error ?? ''}</span> },
    { key: 'by', header: tr('By'), render: (r) => <span className="text-xs">{r.createdByName ?? '—'}</span> },
  ];
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card title={sys.name} actions={<div className="flex gap-2"><Button size="sm" variant="secondary" onClick={onEdit}>{tr('Edit')}</Button><Button size="sm" variant={sys.enabled ? 'danger' : 'success'} loading={toggle.isPending} onClick={() => toggle.mutate()}>{sys.enabled ? tr('Disable') : tr('Enable')}</Button></div>}>
        <dl className="space-y-1 text-sm">
          <div><dt className="inline text-ink-500">{tr('Base URL:')}{' '}</dt><dd className="mono inline break-all">{sys.baseUrl ?? '—'}</dd></div>
          <div><dt className="inline text-ink-500">{tr('Auth:')}{' '}</dt><dd className="inline">{sys.config?.authType ?? '—'}{sys.credentialsRef ? tr(' via secret {credentialsRef}', { credentialsRef: sys.credentialsRef }) : ''} {sys.config?.authType !== 'none' && <Badge tone={sys.credentialsPresent ? 'green' : 'red'}>{sys.credentialsPresent ? tr('secret present') : tr('secret missing')}</Badge>}</dd></div>
          <div><dt className="inline text-ink-500">{tr('Timeout / retries:')}{' '}</dt><dd className="inline">{sys.config?.timeoutMs}{' '}{tr('ms /')}{' '}{sys.config?.retries}</dd></div>
          <div><dt className="inline text-ink-500">{tr('Contract:')}{' '}</dt><dd className="inline"><VerificationBadge status={sys.verificationStatus} />{sys.verifiedAt ? tr(' since {verifiedAt}', { verifiedAt: formatDateTime(sys.verifiedAt) }) : ''}</dd></div>
        </dl>
      </Card>
      <Card title={tr('Test connection')} className="lg:col-span-2">
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <Button variant="secondary" icon={<Activity className="h-4 w-4" />} loading={test.isPending && test.variables === false} onClick={() => test.mutate(false)}>{tr('Health check')}</Button>
            {isFir ? (
              <>
                <Field label={tr('Probe station code')} htmlFor="pr-st"><Input id="pr-st" value={probe.stationCode} onChange={(e) => setProbe((p) => ({ ...p, stationCode: e.target.value }))} /></Field>
                <Field label={tr('Year')} htmlFor="pr-y"><Input id="pr-y" type="number" value={probe.year} onChange={(e) => setProbe((p) => ({ ...p, year: e.target.value }))} className="w-24" /></Field>
                <Field label={tr('FIR number')} htmlFor="pr-no"><Input id="pr-no" value={probe.firNumber} onChange={(e) => setProbe((p) => ({ ...p, firNumber: e.target.value }))} /></Field>
              </>
            ) : sys.systemType === 'CASE_DIARY' ? (
              <Field label={tr('Probe case reference')} htmlFor="pr-case"><Input id="pr-case" value={probe.caseRef} onChange={(e) => setProbe((p) => ({ ...p, caseRef: e.target.value }))} /></Field>
            ) : (
              <Field label={tr('Probe evidence reference')} htmlFor="pr-ev"><Input id="pr-ev" value={probe.evidenceRef} onChange={(e) => setProbe((p) => ({ ...p, evidenceRef: e.target.value }))} /></Field>
            )}
            <Button loading={test.isPending && test.variables === true} disabled={isFir ? !probe.stationCode || !probe.firNumber : sys.systemType === 'CASE_DIARY' ? !probe.caseRef : !probe.evidenceRef} onClick={() => test.mutate(true)}>{tr('Run contract test')}</Button>
          </div>
          {test.data && (
            <Alert tone={test.data.ok ? 'green' : 'red'} title={test.data.ok ? tr('Passed ({latencyMs} ms)', { latencyMs: test.data.latencyMs }) : tr('Failed: {errorCode}', { errorCode: test.data.errorCode })}>
              <ul className="list-disc pl-5">{test.data.steps.map((s, i) => <li key={i}>{s.step}: {s.ok ? tr('ok') : tr('failed')}{s.detail ? ` — ${s.detail}` : ''}</li>)}</ul>
              <p className="mt-1">{test.data.note}</p>
            </Alert>
          )}
          {test.error ? <Alert tone="red">{errorMessage(test.error)}</Alert> : null}
        </div>
      </Card>
      <Card title={tr('Sync log')} className="lg:col-span-3" bodyClassName="p-0">
        {log.isLoading ? <Spinner /> : log.error ? <ErrorState error={log.error} onRetry={() => void log.refetch()} /> : (
          <>
            <DataTable caption={tr('Sync log')} columns={logCols} rows={log.data?.items} rowKey={(r) => String(r.id)} empty={<EmptyState title={tr('No activity yet')} />} />
            {log.data && <Pagination page={log.data.page} pageSize={log.data.pageSize} total={log.data.total} onPage={setPage} />}
          </>
        )}
      </Card>
    </div>
  );
}

function SystemFormModal({ sys, onClose }: { sys: IntegrationSystem | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({
    code: sys?.code ?? '', name: sys?.name ?? '', systemType: sys?.systemType ?? 'CCTNS', adapter: sys?.adapter ?? 'http-json', baseUrl: sys?.baseUrl ?? '',
    credentialsRef: sys?.credentialsRef ?? '', authType: sys?.config?.authType ?? 'none', timeoutMs: String(sys?.config?.timeoutMs ?? 10000), retries: String(sys?.config?.retries ?? 2),
    stationMap: sys?.config ? Object.entries(sys.config.stationCodeMap).map(([k, v]) => `${k}=${v}`).join('\n') : '',
  });
  const upd = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const m = useMutation({
    mutationFn: () => {
      const stationCodeMap = Object.fromEntries(f.stationMap.split('\n').map((l) => l.split('=').map((x) => x.trim())).filter((p) => p.length === 2 && p[0] && p[1]));
      const config = { authType: f.authType, timeoutMs: Number(f.timeoutMs), retries: Number(f.retries), stationCodeMap };
      const common = { name: f.name.trim(), adapter: f.adapter, baseUrl: f.baseUrl.trim() || null, credentialsRef: f.credentialsRef.trim() || null, config };
      return sys ? api.patch(`/integrations/systems/${sys.id}`, common) : api.post('/integrations/systems', { ...common, code: f.code.trim(), systemType: f.systemType });
    },
    onSuccess: () => {
      toast.success(sys ? 'Integration updated' : 'Integration created (disabled, unverified)');
      void qc.invalidateQueries({ queryKey: ['integrations'] });
      onClose();
    },
  });
  return (
    <Modal open onClose={onClose} title={sys ? tr('Edit {name}', { name: sys.name }) : tr('Add integration system')} size="lg" footer={<><Button variant="secondary" onClick={onClose}>{tr('Cancel')}</Button><Button onClick={() => m.mutate()} loading={m.isPending} disabled={!f.name.trim() || (!sys && !f.code.trim())}>{tr('Save')}</Button></>}>
      <div className="grid gap-3 md:grid-cols-2">
        {!sys && <Field label={tr('Code')} required htmlFor="is-code" hint={tr('lowercase letters, digits, - and _')}><Input id="is-code" value={f.code} onChange={upd('code')} /></Field>}
        <Field label={tr('Name')} required htmlFor="is-name"><Input id="is-name" value={f.name} onChange={upd('name')} /></Field>
        {!sys && <Field label={tr('System type')} htmlFor="is-type"><Select id="is-type" value={f.systemType} onChange={upd('systemType')}>{INTEGRATION_SYSTEM_TYPES.map((t) => <option key={t} value={t}>{titleCase(t)}</option>)}</Select></Field>}
        <Field label={tr('Adapter')} htmlFor="is-adapter"><Select id="is-adapter" value={f.adapter} onChange={upd('adapter')}>{INTEGRATION_ADAPTERS.map((t) => <option key={t} value={t}>{t}</option>)}</Select></Field>
        <div className="md:col-span-2"><Field label={tr('Base URL')} htmlFor="is-url" hint={tr('https required in production. Private/link-local/metadata addresses are refused unless allow-listed by deployment config.')}><Input id="is-url" value={f.baseUrl} onChange={upd('baseUrl')} placeholder={tr('https://cctns.example.gov.in/api/v1')} /></Field></div>
        <Field label={tr('Authentication')} htmlFor="is-auth"><Select id="is-auth" value={f.authType} onChange={upd('authType')}>{INTEGRATION_AUTH_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</Select></Field>
        <Field label={tr('Secret reference')} htmlFor="is-cred" hint={tr('Name only (e.g. CCTNS_PROD). The secret is read from env KSP_SECRET_<NAME>; it is never stored here.')}><Input id="is-cred" value={f.credentialsRef} onChange={upd('credentialsRef')} /></Field>
        <Field label={tr('Timeout (ms)')} htmlFor="is-to"><Input id="is-to" type="number" min={200} max={60000} value={f.timeoutMs} onChange={upd('timeoutMs')} /></Field>
        <Field label={tr('Retries')} htmlFor="is-re"><Input id="is-re" type="number" min={0} max={5} value={f.retries} onChange={upd('retries')} /></Field>
        <div className="md:col-span-2"><Field label={tr('Station code map')} htmlFor="is-map" hint={tr('One per line: SOURCE_CODE=our_org_unit_code (default: identical codes)')}><textarea id="is-map" className="w-full rounded-md border border-ink-300 p-2 font-mono text-sm" rows={3} value={f.stationMap} onChange={upd('stationMap')} /></Field></div>
      </div>
      {sys && <p className="mt-2 text-xs text-ink-600">{tr('Changing adapter, URL, credentials or configuration resets verification.')}</p>}
      {m.error ? <div className="mt-3"><Alert tone="red">{errorMessage(m.error)}</Alert></div> : null}
    </Modal>
  );
}
