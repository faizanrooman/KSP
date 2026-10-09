/**
 * Evidence tab "Chain of custody": ledger-verified timeline (keyset pages of 200, "Load more"; the whole chain is
 * verified server-side on every request) + signed PDF report download (always complete).
 */
import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { CheckCircle2, ChevronDown, ChevronRight, Download, Eye, ShieldAlert, XCircle } from 'lucide-react';
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

// Routine reads that repeat many times per session. In the key-events view every unbroken stretch of them between
// two milestones collapses into one expandable row naming who read the item, so ingest, links, plays, exports and
// holds stay visible; every event remains one click away, verification is unchanged, and an event that does not
// verify (or did not succeed) is never collapsed.
const ROUTINE = new Set(['EVIDENCE_VIEWED', 'AI_RESULTS_VIEWED']);
type Row = { kind: 'event'; e: CustodyEvent } | { kind: 'run'; events: CustodyEvent[] };

function keyRows(events: CustodyEvent[]): Row[] {
  const rows: Row[] = [];
  const routine = (e: CustodyEvent) => ROUTINE.has(e.action) && e.verified && e.outcome === 'SUCCESS';
  for (const e of events) {
    const prev = rows[rows.length - 1];
    if (routine(e) && prev?.kind === 'run') prev.events.push(e);
    else if (routine(e) && prev?.kind === 'event' && routine(prev.e)) rows[rows.length - 1] = { kind: 'run', events: [prev.e, e] };
    else rows.push({ kind: 'event', e });
  }
  return rows;
}

function EventRow({ e, onOpen }: { e: CustodyEvent; onOpen: (e: CustodyEvent) => void }) {
  const routine = ROUTINE.has(e.action);
  return (
    <li className="relative">
      <span className="absolute -left-[27px] top-1 rounded-full bg-white" aria-hidden>
        {e.verified ? <CheckCircle2 className={routine ? 'h-4 w-4 text-ink-400' : 'h-4 w-4 text-emerald-600'} /> : <XCircle className="h-4 w-4 text-red-600" />}
      </span>
      <button type="button" className="w-full rounded-md p-2 text-left hover:bg-ink-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500" onClick={() => onOpen(e)}>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className={routine ? 'text-ink-700' : 'font-semibold text-ink-900'}>{titleCase(e.action)}</span>
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
  );
}

function RunRow({ events, onOpen }: { events: CustodyEvent[]; onOpen: (e: CustodyEvent) => void }) {
  const [expanded, setExpanded] = useState(false);
  const first = events[0]!;
  const last = events[events.length - 1]!;
  return (
    <li className="relative">
      <span className="absolute -left-[27px] top-1 rounded-full bg-white text-ink-400" aria-hidden><Eye className="h-4 w-4" /></span>
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded((x) => !x)}
        className="flex w-full items-start gap-1.5 rounded-md p-2 text-left text-sm text-ink-700 hover:bg-ink-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
        {expanded ? <ChevronDown className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : <ChevronRight className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
        <span>
          {t('Routine views ×{count} · {names}', { count: events.length, names: [...new Set(events.map((e) => e.actor.name ?? e.actor.id ?? '—'))].join(', ') })}
          <span className="block text-xs text-ink-500">{t('{from} – {to} · ledger #{firstSeq}–#{lastSeq}, all verified', { from: formatDateTime(first.occurredAt), to: formatDateTime(last.occurredAt), firstSeq: first.seq, lastSeq: last.seq })}</span>
        </span>
      </button>
      {expanded && <ol className="ml-2 space-y-1 border-l border-dashed border-ink-200 pl-5">{events.map((e) => <EventRow key={e.seq} e={e} onOpen={onOpen} />)}</ol>}
    </li>
  );
}

export function CustodyTab({ evidence }: { evidence: EvidenceSummary }) {
  const [view, setView] = useState<'key' | 'custody' | 'all'>('key');
  const filter = view === 'all' ? 'all' : 'custody';
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
          {t('All {count} ledger events for this item were recomputed and are linked to their predecessors (ledger head seq {seq}, verified {date}).', { count: v.eventsChecked, seq: v.ledgerHead?.seq ?? '—', date: formatDateTime(v.verifiedAt) })}
        </Alert>
      ) : (
        <Alert tone="red" title={t('Chain BROKEN')}>
          {t('Ledger events {seqs} do not verify: the audit ledger was modified outside the application. A critical alert should be raised; report to the compliance team immediately.', { seqs: v.brokenSeqs.join(', ') })}
        </Alert>
      )}
      <Card
        title={t('Chain of custody')}
        actions={
          <div className="flex items-center gap-2">
            <label className="sr-only" htmlFor="custody-filter">{t('Show')}</label>
            <select id="custody-filter" className="rounded-md border border-ink-300 px-2 py-1 text-xs" value={view} onChange={(e) => setView(e.target.value as 'key' | 'custody' | 'all')} aria-label={t('Show')}>
              <option value="key">{t('Key events')}</option>
              <option value="custody">{t('Every custody event')}</option>
              <option value="all">{t('All linked events')}</option>
            </select>
            <a
              className="inline-flex items-center gap-1.5 rounded-md bg-brand-700 px-2.5 py-1 text-xs font-medium text-white shadow-sm hover:bg-brand-800"
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
            {view === 'key'
              ? keyRows(events).map((r) => (r.kind === 'run' ? <RunRow key={`run-${r.events[0]!.seq}`} events={r.events} onOpen={setOpen} /> : <EventRow key={r.e.seq} e={r.e} onOpen={setOpen} />))
              : events.map((e) => <EventRow key={e.seq} e={e} onOpen={setOpen} />)}
          </ol>
        )}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-ink-600">
          <span role="status" aria-live="polite">{filter === 'custody' ? t('Showing {shown} of {total} custody events', { shown: events.length, total }) : t('Showing {shown} of {total} linked events', { shown: events.length, total })}</span>
          {q.hasNextPage && (
            <Button size="sm" variant="secondary" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
              {t('Load more ({next} of {remaining} remaining)', { next: Math.min(PAGE_SIZE, total - events.length), remaining: total - events.length })}
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
