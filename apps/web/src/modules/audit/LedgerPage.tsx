/** Compliance: verify the audit ledger hash chain and the signed checkpoints. */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, ShieldCheck } from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime, shortHash } from '@/lib/format';
import { Alert, Badge, Button, Card, DataTable, EmptyState, Field, Input, KeyValue, PageHeader, useToast, type Column } from '@/components/ui';

interface Checkpoint {
  id: number;
  headSeq: number;
  headHash: string;
  createdAt: string;
  keyId: string;
  algorithm: string;
  certFingerprint: string | null;
  verifiedFromSeq: number | null;
  chainOk: boolean | null;
}
interface VerifyResult {
  ok: boolean;
  chainOk: boolean;
  checkpointsOk: boolean;
  checked: number;
  firstBadSeq: number | null;
  headSeq: number | null;
  headHash: string | null;
  checkpoints: Array<{ id: number; headSeq: number; createdAt: string; signatureValid: boolean; headMatches: boolean }>;
  verifiedAt: string;
  durationMs: number;
}
interface CheckpointVerification {
  signatureValid: boolean;
  headMatches: boolean;
  chain: { ok: boolean; checked: number; firstBadSeq: number | null };
  ok: boolean;
}

export function LedgerPage() {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [cpResults, setCpResults] = useState<Record<number, CheckpointVerification | 'error'>>({});
  const cps = useQuery({ queryKey: ['audit', 'checkpoints'], queryFn: () => api.get<{ items: Checkpoint[]; ledgerHead: { seq: number; hash: string } | null }>('/audit/checkpoints', { limit: 100 }) });
  const verify = useMutation({ mutationFn: () => api.post<VerifyResult>('/audit/verify', { from: from ? Number(from) : undefined, to: to ? Number(to) : undefined }) });
  const create = useMutation({
    mutationFn: () => api.post<{ created: boolean; reason?: string }>('/audit/checkpoints', {}),
    onSuccess: (r) => {
      if (r.created) toast.success('Checkpoint signed');
      else toast.info(r.reason ?? 'No checkpoint created');
      void qc.invalidateQueries({ queryKey: ['audit', 'checkpoints'] });
    },
    onError: (e) => toast.error(e),
  });
  const verifyCp = useMutation({
    mutationFn: (id: number) => api.get<CheckpointVerification>(`/audit/checkpoints/${id}/verify`),
    onSuccess: (r, id) => setCpResults((s) => ({ ...s, [id]: r })),
    onError: (_e, id) => setCpResults((s) => ({ ...s, [id]: 'error' })),
  });
  const cols: Column<Checkpoint>[] = [
    { key: 'id', header: 'ID', render: (r) => <span className="mono">{r.id}</span> },
    { key: 'at', header: 'Signed', render: (r) => formatDateTime(r.createdAt) },
    { key: 'seq', header: 'Head seq', render: (r) => <span className="mono">{r.headSeq}</span> },
    { key: 'hash', header: 'Head hash', render: (r) => <code className="mono text-xs" title={r.headHash}>{shortHash(r.headHash, 16)}</code> },
    { key: 'key', header: 'Key', render: (r) => <span className="text-xs">{r.keyId} · {r.algorithm}</span> },
    {
      key: 'v', header: 'Verification', render: (r) => {
        const res = cpResults[r.id];
        if (!can('audit:verify')) return '—';
        if (res === 'error') return <Badge tone="red">Error</Badge>;
        if (res) return res.ok ? <Badge tone="green">Valid</Badge> : <Badge tone="red">{!res.signatureValid ? 'Bad signature' : !res.headMatches ? 'Head mismatch' : `Chain broken at ${res.chain.firstBadSeq}`}</Badge>;
        return <Button size="sm" variant="secondary" loading={verifyCp.isPending && verifyCp.variables === r.id} onClick={() => verifyCp.mutate(r.id)}>Verify</Button>;
      },
    },
  ];
  const v = verify.data;
  return (
    <div className="space-y-4">
      <PageHeader
        title="Ledger verification"
        subtitle="Recompute the SHA-256 hash chain of the audit ledger and check it against the signed checkpoints."
        actions={
          <div className="flex gap-2">
            {can('audit:export') && (
              <a className="inline-flex items-center gap-1.5 rounded-md border border-ink-300 bg-white px-3.5 py-2 text-sm font-medium text-ink-800 shadow-sm hover:bg-ink-50" href="/api/v1/audit/checkpoints/export" download>
                <Download className="h-4 w-4" aria-hidden /> Export checkpoints
              </a>
            )}
            {can('audit:verify') && <Button variant="secondary" loading={create.isPending} onClick={() => create.mutate()}>Sign checkpoint now</Button>}
          </div>
        }
      />
      {can('audit:verify') ? (
        <Card title="Verify the chain">
          <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); verify.mutate(); }}>
            <Field label="From seq (optional)" htmlFor="lv-from"><Input id="lv-from" inputMode="numeric" value={from} onChange={(e) => setFrom(e.target.value.replace(/\D/g, ''))} /></Field>
            <Field label="To seq (optional)" htmlFor="lv-to"><Input id="lv-to" inputMode="numeric" value={to} onChange={(e) => setTo(e.target.value.replace(/\D/g, ''))} /></Field>
            <Button type="submit" icon={<ShieldCheck className="h-4 w-4" />} loading={verify.isPending}>Verify ledger</Button>
          </form>
          {verify.error ? <div className="mt-3"><Alert tone="red">{errorMessage(verify.error)}</Alert></div> : null}
          {v && (
            <div className="mt-4 space-y-3">
              {v.ok ? (
                <Alert tone="green" title="Ledger intact">{v.checked} events recomputed; {v.checkpoints.length} checkpoint(s) in range match and their signatures are valid.</Alert>
              ) : (
                <Alert tone="red" title="Verification FAILED">
                  {!v.chainOk ? `The hash chain breaks at seq ${v.firstBadSeq}. A critical AUDIT_CHAIN_BROKEN alert was raised.` : 'One or more checkpoints do not match the ledger or carry an invalid signature.'}
                </Alert>
              )}
              <KeyValue items={[
                { label: 'Events checked', value: v.checked },
                { label: 'Head seq', value: v.headSeq ?? '—' },
                { label: 'Head hash', value: v.headHash ?? '—', mono: true },
                { label: 'Verified', value: `${formatDateTime(v.verifiedAt)} (${v.durationMs} ms)` },
              ]} />
            </div>
          )}
        </Card>
      ) : (
        <Alert tone="blue">You can view checkpoints; verifying the ledger requires the audit:verify permission.</Alert>
      )}
      <Card title="Signed checkpoints" bodyClassName="p-0">
        <DataTable
          caption="Audit checkpoints"
          columns={cols}
          rows={cps.data?.items}
          rowKey={(r) => String(r.id)}
          loading={cps.isFetching}
          error={cps.error}
          onRetry={() => void cps.refetch()}
          empty={<EmptyState title="No checkpoints yet" description="The worker signs the ledger head every hour." />}
        />
      </Card>
      <Card title="External notarisation">
        <p className="text-sm text-ink-700">
          Export the checkpoints regularly to a location the database administrators cannot modify (WORM bucket in another account, notary service, or signed e-mail to the compliance officer).
          Anyone holding an exported checkpoint can later prove that ledger history up to that point has not been rewritten, by comparing its head hash and signature with the live ledger. See docs/AUDIT.md.
        </p>
      </Card>
    </div>
  );
}
