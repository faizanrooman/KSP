/** Evidence tab "Chain of custody": ledger-verified timeline + signed PDF report download. */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Download, ShieldAlert, XCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { formatDateTime, shortHash, titleCase } from '@/lib/format';
import type { EvidenceSummary } from '@/lib/extensions';
import { Alert, Badge, Button, Card, EmptyState, ErrorState, KeyValue, Modal, Spinner, StatusBadge } from '@/components/ui';

export interface CustodyEvent {
  seq: number;
  eventId: string;
  occurredAt: string;
  action: string;
  category: string;
  custody: boolean;
  outcome: string;
  actor: { type: string; id: string | null; username: string | null; name: string | null };
  ip: string | null;
  resourceType: string | null;
  resourceId: string | null;
  caseId: string | null;
  details: Record<string, unknown>;
  prevHash: string;
  hash: string;
  verified: boolean;
}

export interface CustodyResponse {
  evidence: { id: string; evidenceNumber: string | null; sha256: string | null; sha512: string | null; status: string };
  events: CustodyEvent[];
  verification: { chainIntact: boolean; eventsChecked: number; brokenSeqs: number[]; ledgerHead: { seq: number; hash: string } | null; verifiedAt: string };
}

const ACTOR_LABEL: Record<string, string> = { USER: 'User', SYSTEM: 'System', API_CLIENT: 'API client', EXTERNAL_RECIPIENT: 'External recipient' };

export function CustodyTab({ evidence }: { evidence: EvidenceSummary }) {
  const [filter, setFilter] = useState<'custody' | 'all'>('custody');
  const [open, setOpen] = useState<CustodyEvent | null>(null);
  const q = useQuery({ queryKey: ['custody', evidence.id], queryFn: () => api.get<CustodyResponse>(`/custody/evidence/${evidence.id}`) });
  if (q.isLoading) return <Spinner label="Verifying chain of custody…" />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const d = q.data!;
  const events = filter === 'custody' ? d.events.filter((e) => e.custody) : d.events;
  const v = d.verification;
  return (
    <div className="space-y-4">
      {v.chainIntact ? (
        <Alert tone="green" title="Chain intact">
          All {v.eventsChecked} ledger events for this item were recomputed and are linked to their predecessors (ledger head seq {v.ledgerHead?.seq ?? '—'}, verified {formatDateTime(v.verifiedAt)}).
        </Alert>
      ) : (
        <Alert tone="red" title="Chain BROKEN">
          Ledger events {v.brokenSeqs.join(', ')} do not verify: the audit ledger was modified outside the application. A critical alert should be raised; report to the compliance team immediately.
        </Alert>
      )}
      <Card
        title="Chain of custody"
        actions={
          <div className="flex items-center gap-2">
            <label className="sr-only" htmlFor="custody-filter">Show</label>
            <select id="custody-filter" className="rounded-md border border-ink-300 px-2 py-1 text-xs" value={filter} onChange={(e) => setFilter(e.target.value as 'custody' | 'all')}>
              <option value="custody">Custody events</option>
              <option value="all">All linked events</option>
            </select>
            <a
              className="inline-flex items-center gap-1.5 rounded-md border border-ink-300 bg-white px-2.5 py-1 text-xs font-medium text-ink-800 shadow-sm hover:bg-ink-50"
              href={`/api/v1/custody/evidence/${evidence.id}/report.pdf`}
              download
            >
              <Download className="h-4 w-4" aria-hidden /> Signed report (PDF)
            </a>
          </div>
        }
      >
        {events.length === 0 ? (
          <EmptyState title="No events" />
        ) : (
          <ol className="relative space-y-3 border-l border-ink-200 pl-5" aria-label="Custody timeline">
            {events.map((e) => (
              <li key={e.seq} className="relative">
                <span className="absolute -left-[27px] top-1 rounded-full bg-white" aria-hidden>
                  {e.verified ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <XCircle className="h-4 w-4 text-red-600" />}
                </span>
                <button type="button" className="w-full rounded-md p-2 text-left hover:bg-ink-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500" onClick={() => setOpen(e)}>
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium text-ink-900">{titleCase(e.action)}</span>
                    {e.outcome !== 'SUCCESS' && <StatusBadge status={e.outcome} />}
                    {!e.verified && <Badge tone="red">Hash mismatch</Badge>}
                    <span className="text-ink-500">{formatDateTime(e.occurredAt)}</span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-4 text-xs text-ink-600">
                    <span>{e.actor.name ?? e.actor.id ?? '—'} ({ACTOR_LABEL[e.actor.type] ?? e.actor.type})</span>
                    {e.ip && <span>IP {e.ip}</span>}
                    <span className="mono">#{e.seq} · {shortHash(e.hash, 16)}</span>
                  </div>
                </button>
              </li>
            ))}
          </ol>
        )}
      </Card>
      {open && (
        <Modal open onClose={() => setOpen(null)} title={`Ledger event #${open.seq}`} size="lg">
          <div className="space-y-3 text-sm">
            <KeyValue
              columns={1}
              items={[
                { label: 'Action', value: `${titleCase(open.action)} (${open.category})` },
                { label: 'Outcome', value: <StatusBadge status={open.outcome} /> },
                { label: 'Time', value: formatDateTime(open.occurredAt) },
                { label: 'Actor', value: `${open.actor.name ?? '—'} · ${ACTOR_LABEL[open.actor.type] ?? open.actor.type}${open.actor.username ? ` · @${open.actor.username}` : ''}` },
                { label: 'IP address', value: open.ip ?? '—' },
                { label: 'Resource', value: open.resourceType ? `${open.resourceType} ${open.resourceId ?? ''}` : '—', mono: true },
                { label: 'Hash', value: open.hash, mono: true },
                { label: 'Previous hash', value: open.prevHash, mono: true },
                { label: 'Verification', value: open.verified ? <Badge tone="green">Hash recomputed · linked</Badge> : <Badge tone="red"><ShieldAlert className="mr-1 inline h-3 w-3" aria-hidden />Does not verify</Badge> },
              ]}
            />
            <div>
              <div className="mb-1 text-xs font-semibold uppercase text-ink-600">Details</div>
              <pre className="max-h-64 overflow-auto rounded-md bg-ink-50 p-2 text-xs">{JSON.stringify(open.details, null, 2)}</pre>
            </div>
            <div className="flex justify-end"><Button variant="secondary" onClick={() => setOpen(null)}>Close</Button></div>
          </div>
        </Modal>
      )}
    </div>
  );
}
