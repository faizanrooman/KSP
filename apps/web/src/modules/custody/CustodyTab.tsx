/**
 * Evidence tab "Chain of custody": ledger-verified timeline (keyset pages of 200, "Load more"; the whole chain is
 * verified server-side on every request) + signed PDF report download (always complete).
 */
import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { CheckCircle2, Download, ShieldAlert, XCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { formatDateTime, shortHash, titleCase } from '@/lib/format';
import type { EvidenceSummary } from '@/lib/extensions';
import { Alert, Badge, Button, Card, EmptyState, ErrorState, KeyValue, Modal, Spinner, StatusBadge } from '@/components/ui';

import { t } from '@/lib/i18n';
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
  page: { limit: number; filter: 'all' | 'custody'; total: number; hasMore: boolean; hasEarlier: boolean; nextAfter: number | null; prevBefore: number | null };
  verification: { chainIntact: boolean; eventsChecked: number; brokenSeqs: number[]; ledgerHead: { seq: number; hash: string } | null; verifiedAt: string };
}

const PAGE_SIZE = 200;

const ACTOR_LABEL: Record<string, string> = { USER: 'User', SYSTEM: 'System', API_CLIENT: 'API client', EXTERNAL_RECIPIENT: 'External recipient' };

export function CustodyTab({ evidence }: { evidence: EvidenceSummary }) {
  const [filter, setFilter] = useState<'custody' | 'all'>('custody');
  const [open, setOpen] = useState<CustodyEvent | null>(null);
  const q = useInfiniteQuery({
    queryKey: ['custody', evidence.id, filter],
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) => api.get<CustodyResponse>(`/custody/evidence/${evidence.id}`, { filter, limit: PAGE_SIZE, after: pageParam ?? undefined }),
    getNextPageParam: (last) => last.page.nextAfter,
  });
  if (q.isLoading) return <Spinner label={t('Verifying chain of custody…')} />;
  if (q.error && !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const pages = q.data!.pages;
  const d = pages[pages.length - 1]!;
  const events = pages.flatMap((p) => p.events);
  const total = d.page.total;
  const v = d.verification;
  return (
    <div className="space-y-4">
      {v.chainIntact ? (
        <Alert tone="green" title={t('Chain intact')}>
          {t('All')}{' '}{v.eventsChecked}{' '}{t('ledger events for this item were recomputed and are linked to their predecessors (ledger head seq')}{' '}{v.ledgerHead?.seq ?? '—'}{t(', verified')}{' '}{formatDateTime(v.verifiedAt)}).
        </Alert>
      ) : (
        <Alert tone="red" title={t('Chain BROKEN')}>
          {t('Ledger events')}{' '}{v.brokenSeqs.join(', ')}{' '}{t('do not verify: the audit ledger was modified outside the application. A critical alert should be raised; report to the compliance team immediately.')}
        </Alert>
      )}
      <Card
        title={t('Chain of custody')}
        actions={
          <div className="flex items-center gap-2">
            <label className="sr-only" htmlFor="custody-filter">{t('Show')}</label>
            <select id="custody-filter" className="rounded-md border border-ink-300 px-2 py-1 text-xs" value={filter} onChange={(e) => setFilter(e.target.value as 'custody' | 'all')} aria-label={t('Show')}>
              <option value="custody">{t('Custody events')}</option>
              <option value="all">{t('All linked events')}</option>
            </select>
            <a
              className="inline-flex items-center gap-1.5 rounded-md border border-ink-300 bg-white px-2.5 py-1 text-xs font-medium text-ink-800 shadow-sm hover:bg-ink-50"
              href={`/api/v1/custody/evidence/${evidence.id}/report.pdf`}
              download
            >
              <Download className="h-4 w-4" aria-hidden />{t('Signed report (PDF)')}
            </a>
          </div>
        }
      >
        {events.length === 0 ? (
          <EmptyState title={t('No events')} />
        ) : (
          <ol className="relative space-y-3 border-l border-ink-200 pl-5" aria-label={t('Custody timeline')}>
            {events.map((e) => (
              <li key={e.seq} className="relative">
                <span className="absolute -left-[27px] top-1 rounded-full bg-white" aria-hidden>
                  {e.verified ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <XCircle className="h-4 w-4 text-red-600" />}
                </span>
                <button type="button" className="w-full rounded-md p-2 text-left hover:bg-ink-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500" onClick={() => setOpen(e)}>
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium text-ink-900">{titleCase(e.action)}</span>
                    {e.outcome !== 'SUCCESS' && <StatusBadge status={e.outcome} />}
                    {!e.verified && <Badge tone="red">{t('Hash mismatch')}</Badge>}
                    <span className="text-ink-500">{formatDateTime(e.occurredAt)}</span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-4 text-xs text-ink-600">
                    <span>{e.actor.name ?? e.actor.id ?? '—'} ({t(ACTOR_LABEL[e.actor.type] ?? e.actor.type)})</span>
                    {e.ip && <span>{t('IP')}{' '}{e.ip}</span>}
                    <span className="mono">#{e.seq} · {shortHash(e.hash, 16)}</span>
                  </div>
                </button>
              </li>
            ))}
          </ol>
        )}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-ink-600">
          <span role="status" aria-live="polite">{t('Showing')}{' '}{events.length}{' '}{t('of')}{' '}{total} {filter === 'custody' ? t('custody') : t('linked')}{' '}{t('events')}</span>
          {q.hasNextPage && (
            <Button size="sm" variant="secondary" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
              {t('Load more (')}{Math.min(PAGE_SIZE, total - events.length)}{' '}{t('of')}{' '}{total - events.length}{' '}{t('remaining)')}
            </Button>
          )}
        </div>
        {q.error && q.data ? <div className="mt-2"><Alert tone="red">{t('Could not load more events.')}{' '}<Button size="sm" variant="ghost" onClick={() => void q.fetchNextPage()}>{t('Retry')}</Button></Alert></div> : null}
      </Card>
      {open && (
        <Modal open onClose={() => setOpen(null)} title={t('Ledger event #{seq}', { seq: open.seq })} size="lg">
          <div className="space-y-3 text-sm">
            <KeyValue
              columns={1}
              items={[
                { label: t('Action'), value: `${titleCase(open.action)} (${open.category})` },
                { label: t('Outcome'), value: <StatusBadge status={open.outcome} /> },
                { label: t('Time'), value: formatDateTime(open.occurredAt) },
                { label: t('Actor'), value: `${open.actor.name ?? '—'} · ${t(ACTOR_LABEL[open.actor.type] ?? open.actor.type)}${open.actor.username ? ` · @${open.actor.username}` : ''}` },
                { label: t('IP address'), value: open.ip ?? '—' },
                { label: t('Resource'), value: open.resourceType ? `${open.resourceType} ${open.resourceId ?? ''}` : '—', mono: true },
                { label: t('Hash'), value: open.hash, mono: true },
                { label: t('Previous hash'), value: open.prevHash, mono: true },
                { label: t('Verification'), value: open.verified ? <Badge tone="green">{t('Hash recomputed · linked')}</Badge> : <Badge tone="red"><ShieldAlert className="mr-1 inline h-3 w-3" aria-hidden />{t('Does not verify')}</Badge> },
              ]}
            />
            <div>
              <div className="mb-1 text-xs font-semibold uppercase text-ink-600">{t('Details')}</div>
              <pre className="max-h-64 overflow-auto rounded-md bg-ink-50 p-2 text-xs">{JSON.stringify(open.details, null, 2)}</pre>
            </div>
            <div className="flex justify-end"><Button variant="secondary" onClick={() => setOpen(null)}>{t('Close')}</Button></div>
          </div>
        </Modal>
      )}
    </div>
  );
}
