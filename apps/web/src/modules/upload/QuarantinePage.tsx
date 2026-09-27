import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { QUARANTINE_REASONS, type Page } from '@ksp/shared';
import { api } from '@/lib/api';
import { formatBytes, formatDateTime, formatDuration, shortHash } from '@/lib/format';
import { useUrlState } from '@/lib/hooks';
import { Alert, Badge, Button, Card, ConfirmDialog, DataTable, EmptyState, Field, PageHeader, Pagination, Select, Spinner, useToast, type Column } from '@/components/ui';

interface QuarantineItem {
  id: string;
  title: string | null;
  originalFilename: string;
  sizeBytes: number;
  sha256: string | null;
  statusReason: string | null;
  reasonCode: string | null;
  reasonMessage: string | null;
  duplicateOf: { id: string; evidenceNumber: string | null } | null;
  orgUnitName: string;
  uploadedBy: { id: string; name: string };
  containerFormat: string | null;
  videoCodec: string | null;
  durationMs: number | null;
  createdAt: string;
  quarantinedAt: string;
}

const DEFAULTS = { reason: '', page: '1' };

interface ReleaseStatus { requestId: string; evidenceId: string; status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED'; error: string | null; evidenceNumber: string | null }

/** Polls one asynchronous release (the worker re-hashes and registers the file) until it finishes. */
function PendingRelease({ requestId, filename, onDone }: { requestId: string; filename: string; onDone: (r: ReleaseStatus) => void }) {
  const q = useQuery({
    queryKey: ['uploads', 'release', requestId],
    queryFn: () => api.get<ReleaseStatus>(`/uploads/quarantine/releases/${requestId}`),
    refetchInterval: (qq) => (qq.state.data && ['COMPLETED', 'FAILED'].includes(qq.state.data.status) ? false : 2000),
  });
  const s = q.data;
  useEffect(() => { if (s && ['COMPLETED', 'FAILED'].includes(s.status)) onDone(s); }, [s?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  if (s?.status === 'FAILED') return <Alert tone="red" title={`Release of ${filename} failed`}>{s.error}</Alert>;
  if (s?.status === 'COMPLETED') return <Alert tone="green">{filename} released and registered{s.evidenceNumber ? ` as ${s.evidenceNumber}` : ''}.</Alert>;
  return <Alert tone="blue"><span className="inline-flex items-center gap-2"><Spinner /> Releasing {filename}: {s?.status === 'RUNNING' ? 'verifying the hash and moving it to immutable storage…' : 'queued…'}</span></Alert>;
}

export function QuarantinePage() {
  const [q, setQ] = useUrlState(DEFAULTS);
  const page = Number(q.page) || 1;
  const qc = useQueryClient();
  const toast = useToast();
  const [action, setAction] = useState<{ kind: 'release' | 'reject'; item: QuarantineItem } | null>(null);
  const [pending, setPending] = useState<Array<{ requestId: string; evidenceId: string; filename: string }>>([]);
  const list = useQuery({
    queryKey: ['uploads', 'quarantine', q],
    queryFn: () => api.get<Page<QuarantineItem>>('/uploads/quarantine', { reason: q.reason, page, pageSize: 25 }),
  });
  const decide = useMutation({
    mutationFn: ({ kind, id, reason }: { kind: 'release' | 'reject'; id: string; reason: string }) =>
      api.post<{ id: string; status: string; requestId?: string }>(`/uploads/quarantine/${id}/${kind}`, { reason }),
    onSuccess: (r, v) => {
      if (v.kind === 'release' && r.requestId) {
        setPending((p) => [...p, { requestId: r.requestId!, evidenceId: r.id, filename: action?.item.originalFilename ?? r.id }]);
        toast.success('Release queued — the file is verified and registered in the background');
      } else {
        toast.success('Rejected; record kept, staged file deleted');
        void qc.invalidateQueries({ queryKey: ['uploads'] });
      }
      setAction(null);
    },
  });

  const columns: Column<QuarantineItem>[] = [
    {
      key: 'file',
      header: 'File',
      render: (r) => (
        <div>
          <div className="font-medium text-ink-900">{r.originalFilename}</div>
          <div className="font-mono text-xs text-ink-500" title={r.sha256 ?? ''}>{r.sha256 ? `SHA-256 ${shortHash(r.sha256)}` : 'not hashed'}</div>
        </div>
      ),
    },
    {
      key: 'reason',
      header: 'Reason',
      render: (r) => (
        <div className="max-w-md">
          <Badge tone="red">{r.reasonCode ?? 'UNKNOWN'}</Badge>
          <p className="mt-1 text-xs text-ink-700">{r.reasonMessage}</p>
          {r.duplicateOf && (
            <p className="mt-1 text-xs">Original: <Link className="font-mono text-brand-700 underline" to={`/evidence/${r.duplicateOf.id}`}>{r.duplicateOf.evidenceNumber ?? r.duplicateOf.id}</Link></p>
          )}
        </div>
      ),
    },
    { key: 'media', header: 'Media', render: (r) => <span className="text-xs">{[r.videoCodec, r.durationMs ? formatDuration(r.durationMs) : null, formatBytes(r.sizeBytes)].filter(Boolean).join(' · ')}</span> },
    { key: 'station', header: 'Station / uploader', render: (r) => <span className="text-xs">{r.orgUnitName}<br />{r.uploadedBy.name}</span> },
    { key: 'when', header: 'Quarantined', render: (r) => formatDateTime(r.quarantinedAt), className: 'whitespace-nowrap' },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      render: (r) => (
        <div className="flex gap-1.5">
          <Button size="sm" variant="success" disabled={pending.some((x) => x.evidenceId === r.id)} onClick={() => setAction({ kind: 'release', item: r })}>Release</Button>
          <Button size="sm" variant="danger" disabled={pending.some((x) => x.evidenceId === r.id)} onClick={() => setAction({ kind: 'reject', item: r })}>Reject</Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Quarantine"
        subtitle="Uploads that failed validation (hash mismatch, corrupt or unsupported media, not a video, duplicate). Release registers the file as evidence; reject keeps the record but deletes the staged file. Every decision is recorded in the chain of custody."
      />
      {pending.length > 0 && (
        <div className="space-y-2" aria-live="polite">
          {pending.map((x) => <PendingRelease key={x.requestId} requestId={x.requestId} filename={x.filename} onDone={() => void qc.invalidateQueries({ queryKey: ['uploads', 'quarantine'] })} />)}
        </div>
      )}
      <Card>
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <Field label="Reason" htmlFor="q-reason">
            <Select id="q-reason" value={q.reason} onChange={(e) => setQ({ reason: e.target.value })}>
              <option value="">All reasons</option>
              {Object.keys(QUARANTINE_REASONS).map((k) => <option key={k} value={k}>{k}</option>)}
            </Select>
          </Field>
        </div>
        <DataTable
          caption="Quarantined uploads"
          columns={columns}
          rows={list.data?.items}
          rowKey={(r) => r.id}
          loading={list.isLoading}
          error={list.error}
          onRetry={() => void list.refetch()}
          empty={<EmptyState title="Quarantine is empty" description="No uploads in your jurisdiction are awaiting review." />}
        />
        {list.data && <Pagination page={page} pageSize={list.data.pageSize} total={list.data.total} onPage={(p) => setQ({ page: String(p) })} />}
      </Card>
      <ConfirmDialog
        open={!!action}
        title={action?.kind === 'release' ? 'Release and register this upload?' : 'Reject this upload?'}
        message={
          action && (
            <div className="space-y-2 text-sm">
              <p><strong>{action.item.originalFilename}</strong> — {action.item.reasonCode}: {action.item.reasonMessage}</p>
              {action.kind === 'release'
                ? <p>The file will be copied to immutable evidence storage, given an evidence number and processed for playback. The quarantine finding stays in the custody record.</p>
                : <p>The staged file will be deleted permanently. The evidence record and its audit trail are kept.</p>}
            </div>
          )
        }
        confirmLabel={action?.kind === 'release' ? 'Release' : 'Reject'}
        variant={action?.kind === 'release' ? 'success' : 'danger'}
        requireReason
        reasonLabel="Justification (recorded in the chain of custody)"
        minReason={5}
        loading={decide.isPending}
        error={decide.error}
        onConfirm={(reason) => action && decide.mutate({ kind: action.kind, id: action.item.id, reason })}
        onCancel={() => { setAction(null); decide.reset(); }}
      />
    </div>
  );
}
