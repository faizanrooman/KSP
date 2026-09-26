import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Film, Lock, MapPin } from 'lucide-react';
import { EVIDENCE_STATUSES, MEDIA_STATUSES, STORAGE_TIERS } from '@ksp/shared';
import { api } from '@/lib/api';
import { useUrlState } from '@/lib/hooks';
import { formatBytes, formatDateTime, formatDuration, titleCase } from '@/lib/format';
import { OrgUnitSelect } from '@/components/pickers';
import { Badge, Button, Card, DataTable, EmptyState, Field, Input, PageHeader, Pagination, Select, StatusBadge, type Column } from '@/components/ui';
import type { EvidenceListItem, Paged } from './types';

const DEFAULTS = {
  q: '', status: '', mediaStatus: '', orgUnitId: '', tag: '', legalHold: '', storageTier: '', recordedFrom: '', recordedTo: '', hasGps: '',
  sort: '-created_at', page: '1', pageSize: '25',
};

function toIsoStart(d: string) {
  return d ? new Date(`${d}T00:00:00+05:30`).toISOString() : undefined;
}
function toIsoEnd(d: string) {
  return d ? new Date(`${d}T23:59:59.999+05:30`).toISOString() : undefined;
}

export function Thumb({ url, label }: { url: string | null; label: string }) {
  if (!url) {
    return (
      <div className="flex h-12 w-20 items-center justify-center rounded bg-ink-100 text-ink-400" role="img" aria-label={`${label}: no thumbnail`}>
        <Film className="h-5 w-5" aria-hidden />
      </div>
    );
  }
  return <img src={url} alt={`Thumbnail of ${label}`} className="h-12 w-20 rounded bg-ink-900 object-cover" loading="lazy" />;
}

export function EvidenceListPage() {
  const [s, set, reset] = useUrlState(DEFAULTS);
  const navigate = useNavigate();
  const query = useMemo(
    () => ({
      q: s.q || undefined, status: s.status || undefined, mediaStatus: s.mediaStatus || undefined, orgUnitId: s.orgUnitId || undefined, tag: s.tag || undefined,
      legalHold: s.legalHold || undefined, storageTier: s.storageTier || undefined, hasGps: s.hasGps || undefined,
      recordedFrom: toIsoStart(s.recordedFrom), recordedTo: toIsoEnd(s.recordedTo), sort: s.sort, page: s.page, pageSize: s.pageSize,
    }),
    [s],
  );
  const list = useQuery({ queryKey: ['evidence', 'list', query], queryFn: () => api.get<Paged<EvidenceListItem>>('/evidence', query), placeholderData: keepPreviousData });
  const filtered = Object.entries(s).some(([k, v]) => !['sort', 'page', 'pageSize'].includes(k) && v !== '');

  const columns: Column<EvidenceListItem>[] = [
    { key: 'thumb', header: <span className="sr-only">Thumbnail</span>, render: (r) => <Thumb url={r.thumbnailUrl} label={r.evidenceNumber ?? r.id} />, className: 'w-24' },
    {
      key: 'number',
      header: 'Evidence',
      sortKey: 'evidence_number',
      render: (r) => (
        <div className="min-w-[14rem]">
          <p className="mono text-xs font-semibold text-brand-800">{r.evidenceNumber ?? '—'}</p>
          <p className="text-sm text-ink-900">{r.title ?? <span className="text-ink-500">Untitled</span>}</p>
          {r.tags.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {r.tags.slice(0, 4).map((t) => (
                <Badge key={t}>{t}</Badge>
              ))}
              {r.tags.length > 4 && <span className="text-xs text-ink-500">+{r.tags.length - 4}</span>}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <div className="flex flex-col items-start gap-1">
          <StatusBadge status={r.status} />
          <span className="text-xs text-ink-500">Media: {titleCase(r.mediaStatus)}</span>
          {r.legalHold && (
            <Badge tone="red">
              <Lock className="mr-1 h-3 w-3" aria-hidden />
              Legal hold
            </Badge>
          )}
        </div>
      ),
    },
    { key: 'unit', header: 'Unit / officer', render: (r) => (<div><p>{r.orgUnit.name}</p><p className="text-xs text-ink-500">{r.officer ? `${r.officer.fullName}${r.officer.badgeNumber ? ` (${r.officer.badgeNumber})` : ''}` : `Uploaded by ${r.uploadedBy.fullName}`}</p></div>) },
    { key: 'recorded', header: 'Recorded', sortKey: 'recorded_at', render: (r) => <span className="whitespace-nowrap">{formatDateTime(r.recordedAt)}</span> },
    { key: 'duration', header: 'Duration', sortKey: 'duration_ms', render: (r) => formatDuration(r.durationMs) },
    { key: 'size', header: 'Size', sortKey: 'size_bytes', render: (r) => <span className="whitespace-nowrap">{formatBytes(r.sizeBytes)}</span> },
    { key: 'tier', header: 'Tier', render: (r) => titleCase(r.storageTier) },
    { key: 'created', header: 'Received', sortKey: 'created_at', render: (r) => <span className="whitespace-nowrap">{formatDateTime(r.createdAt)}</span> },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title="Evidence" subtitle="Video evidence within your jurisdiction. Every view is recorded in the chain of custody." />
      <Card>
        <form
          className="grid gap-3 md:grid-cols-3 xl:grid-cols-6"
          onSubmit={(e) => {
            e.preventDefault();
            const q = new FormData(e.currentTarget).get('q');
            set({ q: String(q ?? '').trim() });
          }}
        >
          <div className="md:col-span-2">
            <Field label="Search" htmlFor="ev-q">
              <Input id="ev-q" name="q" defaultValue={s.q} key={s.q} placeholder="Evidence number, title, description, location…" />
            </Field>
          </div>
          <Field label="Unit" htmlFor="ev-unit">
            <OrgUnitSelect id="ev-unit" value={s.orgUnitId} onChange={(v) => set({ orgUnitId: v })} />
          </Field>
          <Field label="Status" htmlFor="ev-status">
            <Select id="ev-status" value={s.status} onChange={(e) => set({ status: e.target.value })}>
              <option value="">All statuses</option>
              {EVIDENCE_STATUSES.map((x) => (
                <option key={x} value={x}>{titleCase(x)}</option>
              ))}
            </Select>
          </Field>
          <Field label="Media" htmlFor="ev-media">
            <Select id="ev-media" value={s.mediaStatus} onChange={(e) => set({ mediaStatus: e.target.value })}>
              <option value="">Any</option>
              {MEDIA_STATUSES.map((x) => (
                <option key={x} value={x}>{titleCase(x)}</option>
              ))}
            </Select>
          </Field>
          <Field label="Storage tier" htmlFor="ev-tier">
            <Select id="ev-tier" value={s.storageTier} onChange={(e) => set({ storageTier: e.target.value })}>
              <option value="">Any</option>
              {STORAGE_TIERS.map((x) => (
                <option key={x} value={x}>{titleCase(x)}</option>
              ))}
            </Select>
          </Field>
          <Field label="Recorded from" htmlFor="ev-from">
            <Input id="ev-from" type="date" value={s.recordedFrom} onChange={(e) => set({ recordedFrom: e.target.value })} />
          </Field>
          <Field label="Recorded to" htmlFor="ev-to">
            <Input id="ev-to" type="date" value={s.recordedTo} onChange={(e) => set({ recordedTo: e.target.value })} />
          </Field>
          <Field label="Tag" htmlFor="ev-tag">
            <Input id="ev-tag" value={s.tag} onChange={(e) => set({ tag: e.target.value.toLowerCase() })} placeholder="e.g. night patrol" />
          </Field>
          <Field label="Legal hold" htmlFor="ev-hold">
            <Select id="ev-hold" value={s.legalHold} onChange={(e) => set({ legalHold: e.target.value })}>
              <option value="">Any</option>
              <option value="true">On hold</option>
              <option value="false">Not on hold</option>
            </Select>
          </Field>
          <Field label="Location" htmlFor="ev-gps">
            <Select id="ev-gps" value={s.hasGps} onChange={(e) => set({ hasGps: e.target.value })}>
              <option value="">Any</option>
              <option value="true">Has GPS</option>
              <option value="false">No GPS</option>
            </Select>
          </Field>
          <div className="flex items-end gap-2">
            <Button type="submit">Search</Button>
            {filtered && (
              <Button variant="ghost" onClick={reset}>
                Clear
              </Button>
            )}
          </div>
        </form>
      </Card>
      <Card bodyClassName="p-0">
        <DataTable
          caption="Evidence"
          columns={columns}
          rows={list.data?.items}
          rowKey={(r) => r.id}
          loading={list.isFetching}
          error={list.error}
          onRetry={() => void list.refetch()}
          sort={s.sort}
          onSort={(sort) => set({ sort })}
          onRowClick={(r) => navigate(`/evidence/${r.id}`)}
          empty={
            <EmptyState
              icon={<MapPin className="h-10 w-10" aria-hidden />}
              title={filtered ? 'No evidence matches these filters' : 'No evidence yet'}
              description={filtered ? 'Try widening the date range or clearing filters.' : 'Uploaded footage appears here once it is registered.'}
              action={filtered ? <Button variant="secondary" onClick={reset}>Clear filters</Button> : undefined}
            />
          }
        />
        {list.data && <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={(p) => set({ page: String(p) })} />}
      </Card>
    </div>
  );
}
