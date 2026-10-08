/** Compliance: audit log viewer (filters in the URL, keyset "load more", event detail with hash chain). */
import { useMemo, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { Download, FileDown, Filter } from 'lucide-react';
import { AUDIT_CATEGORIES } from '@ksp/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useUrlState } from '@/lib/hooks';
import { formatDateTime, shortHash, titleCase } from '@/lib/format';
import { Alert, Badge, Button, Card, DataTable, EmptyState, Field, Input, KeyValue, Modal, PageHeader, Select, Spinner, StatusBadge, type Column } from '@/components/ui';

import { t } from '@/lib/i18n';
export interface AuditEvent {
  seq: number;
  eventId: string;
  occurredAt: string;
  actor: { type: string; id: string | null; name: string | null; ip: string | null; userAgent: string | null; sessionId: string | null };
  action: string;
  category: string;
  outcome: string;
  resourceType: string | null;
  resourceId: string | null;
  evidenceId: string | null;
  caseId: string | null;
  orgUnitId: string | null;
  details: unknown;
  prevHash: string;
  hash: string;
}

const DEFAULTS = { from: '', to: '', actor: '', action: '', category: '', outcome: '', resourceType: '', resourceId: '', evidenceId: '', caseId: '', q: '' };
type Filters = typeof DEFAULTS;

function toQuery(f: Filters) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(f)) {
    if (!v) continue;
    out[k] = k === 'from' || k === 'to' ? new Date(v).toISOString() : v;
  }
  return out;
}

export function AuditLogPage() {
  const { can } = useAuth();
  const [f, setF, reset] = useUrlState(DEFAULTS);
  const [draft, setDraft] = useState<Filters>(f);
  const [selected, setSelected] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const query = useMemo(() => toQuery(f), [f]);
  const q = useInfiniteQuery({
    queryKey: ['audit', 'events', query],
    queryFn: ({ pageParam }) => api.get<{ items: AuditEvent[]; nextCursor: string | null }>('/audit/events', { ...query, limit: 50, before: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const rows = q.data?.pages.flatMap((p) => p.items);
  const cols: Column<AuditEvent>[] = [
    { key: 'seq', header: t('Seq'), render: (r) => <span className="mono">{r.seq}</span> },
    { key: 'at', header: t('Time'), render: (r) => <span className="whitespace-nowrap">{formatDateTime(r.occurredAt)}</span> },
    { key: 'action', header: t('Action'), render: (r) => <span className="font-medium">{titleCase(r.action)}</span> },
    { key: 'cat', header: t('Category'), render: (r) => <Badge>{r.category}</Badge> },
    { key: 'outcome', header: t('Outcome'), render: (r) => <StatusBadge status={r.outcome} /> },
    { key: 'actor', header: t('Actor'), render: (r) => <span>{r.actor.name ?? r.actor.id ?? '—'} <span className="text-ink-500">({titleCase(r.actor.type)})</span></span> },
    { key: 'res', header: t('Resource'), render: (r) => (r.resourceType ? <span className="text-xs">{r.resourceType} <span className="mono">{shortHash(r.resourceId, 10)}</span></span> : '—') },
    { key: 'hash', header: t('Hash'), render: (r) => <code className="mono text-xs" title={r.hash}>{shortHash(r.hash, 10)}</code> },
  ];
  const apply = () => setF(draft);
  return (
    <div className="space-y-4">
      <PageHeader
        title={t('Audit log')}
        subtitle={t('Tamper-evident ledger of every action in the system. Viewing is itself audited.')}
        actions={can('audit:export') ? <Button variant="secondary" icon={<FileDown className="h-4 w-4" />} onClick={() => setExporting(true)}>{t('Export')}</Button> : undefined}
      />
      <Card title={<span className="inline-flex items-center gap-1.5"><Filter className="h-4 w-4" aria-hidden />{' '}{t('Filters')}</span>}>
        <form className="grid grid-cols-1 gap-3 md:grid-cols-4" onSubmit={(e) => { e.preventDefault(); apply(); }}>
          <Field label={t('From')} htmlFor="af-from"><Input id="af-from" type="datetime-local" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} /></Field>
          <Field label={t('To')} htmlFor="af-to"><Input id="af-to" type="datetime-local" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} /></Field>
          <Field label={t('Actor (username or id)')} htmlFor="af-actor"><Input id="af-actor" value={draft.actor} onChange={(e) => setDraft({ ...draft, actor: e.target.value })} /></Field>
          <Field label={t('Action(s), comma separated')} htmlFor="af-action"><Input id="af-action" value={draft.action} placeholder={t('e.g. EVIDENCE_DOWNLOADED')} onChange={(e) => setDraft({ ...draft, action: e.target.value.toUpperCase() })} /></Field>
          <Field label={t('Category')} htmlFor="af-cat">
            <Select id="af-cat" value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })}>
              <option value="">{t('All')}</option>
              {AUDIT_CATEGORIES.map((c) => <option key={c} value={c}>{titleCase(c)}</option>)}
            </Select>
          </Field>
          <Field label={t('Outcome')} htmlFor="af-out">
            <Select id="af-out" value={draft.outcome} onChange={(e) => setDraft({ ...draft, outcome: e.target.value })}>
              <option value="">{t('All')}</option>
              <option value="SUCCESS">{t('Success')}</option>
              <option value="FAILURE">{t('Failure')}</option>
              <option value="DENIED">{t('Denied')}</option>
            </Select>
          </Field>
          <Field label={t('Resource type')} htmlFor="af-rt"><Input id="af-rt" value={draft.resourceType} onChange={(e) => setDraft({ ...draft, resourceType: e.target.value })} /></Field>
          <Field label={t('Resource id')} htmlFor="af-rid"><Input id="af-rid" value={draft.resourceId} onChange={(e) => setDraft({ ...draft, resourceId: e.target.value })} /></Field>
          <Field label={t('Evidence id')} htmlFor="af-ev"><Input id="af-ev" value={draft.evidenceId} onChange={(e) => setDraft({ ...draft, evidenceId: e.target.value.trim() })} /></Field>
          <Field label={t('Case id')} htmlFor="af-case"><Input id="af-case" value={draft.caseId} onChange={(e) => setDraft({ ...draft, caseId: e.target.value.trim() })} /></Field>
          <Field label={t('Search details')} htmlFor="af-q"><Input id="af-q" value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })} /></Field>
          <div className="flex items-end gap-2">
            <Button type="submit">{t('Apply')}</Button>
            <Button variant="ghost" onClick={() => { reset(); setDraft(DEFAULTS); }}>{t('Clear')}</Button>
          </div>
        </form>
      </Card>
      <Card bodyClassName="p-0">
        <DataTable
          caption={t('Audit events')}
          columns={cols}
          rows={rows}
          rowKey={(r) => String(r.seq)}
          loading={q.isFetching}
          error={q.error}
          onRetry={() => void q.refetch()}
          onRowClick={(r) => setSelected(r.seq)}
          empty={<EmptyState title={t('No audit events match')} description={t('Adjust the filters.')} />}
        />
        {q.hasNextPage && (
          <div className="border-t border-ink-100 p-3 text-center">
            <Button variant="secondary" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{t('Load more')}</Button>
          </div>
        )}
      </Card>
      {selected !== null && <EventDrawer seq={selected} onClose={() => setSelected(null)} />}
      {exporting && <ExportDialog filters={query} onClose={() => setExporting(false)} />}
    </div>
  );
}

function EventDrawer({ seq, onClose }: { seq: number; onClose: () => void }) {
  const q = useQuery({ queryKey: ['audit', 'event', seq], queryFn: () => api.get<AuditEvent & { verification: { hashOk: boolean; linkOk: boolean; verified: boolean } }>(`/audit/events/${seq}`) });
  const e = q.data;
  return (
    <Modal open onClose={onClose} title={`Audit event #${seq}`} size="lg">
      {q.isLoading ? <Spinner /> : q.error || !e ? <Alert tone="red">{t('Could not load the event.')}</Alert> : (
        <div className="space-y-3 text-sm">
          {e.verification.verified ? <Alert tone="green" title={t('Verified')}>{t('Hash recomputed from the row contents and linked to event #')}{seq - 1}.</Alert> : <Alert tone="red" title={t('Does not verify')}>{!e.verification.hashOk ? 'The row contents no longer match its hash.' : 'The previous-hash link is broken.'}</Alert>}
          <KeyValue
            columns={1}
            items={[
              { label: t('Event id'), value: e.eventId, mono: true },
              { label: t('Time'), value: formatDateTime(e.occurredAt) },
              { label: t('Action'), value: `${e.action} (${e.category})` },
              { label: t('Outcome'), value: <StatusBadge status={e.outcome} /> },
              { label: t('Actor'), value: `${e.actor.name ?? '—'} · ${e.actor.type} · ${e.actor.id ?? '—'}` },
              { label: t('IP / user agent'), value: `${e.actor.ip ?? '—'} · ${e.actor.userAgent ?? '—'}` },
              { label: t('Resource'), value: e.resourceType ? `${e.resourceType} ${e.resourceId ?? ''}` : '—', mono: true },
              { label: t('Evidence / case'), value: `${e.evidenceId ?? '—'} / ${e.caseId ?? '—'}`, mono: true },
              { label: t('Hash'), value: e.hash, mono: true },
              { label: t('Previous hash'), value: e.prevHash, mono: true },
            ]}
          />
          <pre className="max-h-72 overflow-auto rounded-md bg-ink-50 p-2 text-xs">{JSON.stringify(e.details, null, 2)}</pre>
        </div>
      )}
    </Modal>
  );
}

function ExportDialog({ filters, onClose }: { filters: Record<string, string>; onClose: () => void }) {
  const [format, setFormat] = useState<'csv' | 'json'>('csv');
  const m = useMutation({ mutationFn: () => api.post<{ id: string; rowCount: number; sha256: string; sizeBytes: number; truncated: boolean; downloadUrl: string }>('/audit/export', { format, filters }) });
  return (
    <Modal
      open
      onClose={onClose}
      title={t('Export audit events')}
      footer={<><Button variant="secondary" onClick={onClose}>{t('Close')}</Button>{!m.data && <Button loading={m.isPending} onClick={() => m.mutate()}>{t('Generate export')}</Button>}</>}
    >
      <div className="space-y-3 text-sm">
        <p>{t('The export uses the filters currently applied (')}{Object.keys(filters).length ? Object.keys(filters).join(', ') : 'none — the whole ledger in your scope'}{t('). It is stored, hashed and recorded in the audit trail.')}</p>
        <Field label={t('Format')} htmlFor="ae-format">
          <Select id="ae-format" value={format} onChange={(e) => setFormat(e.target.value as 'csv' | 'json')} disabled={!!m.data}>
            <option value="csv">{t('CSV (spreadsheet-safe)')}</option>
            <option value="json">{t('JSON')}</option>
          </Select>
        </Field>
        {m.error ? <Alert tone="red">{(m.error as Error).message}</Alert> : null}
        {m.data && (
          <Alert tone="green" title={`${m.data.rowCount} events exported`}>
            <div className="space-y-1">
              <div>{t('SHA-256 of the file:')}{' '}<code className="mono break-all text-xs">{m.data.sha256}</code></div>
              {m.data.truncated && <div>{t('The export was truncated at the row limit; narrow the filters.')}</div>}
              <a className="inline-flex items-center gap-1 text-brand-700 underline" href={m.data.downloadUrl} download><Download className="h-4 w-4" aria-hidden />{' '}{t('Download')}</a>
            </div>
          </Alert>
        )}
      </div>
    </Modal>
  );
}
