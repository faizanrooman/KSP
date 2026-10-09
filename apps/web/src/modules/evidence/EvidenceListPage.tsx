import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Film, Lock, MapPin, SlidersHorizontal } from 'lucide-react';
import { EVIDENCE_STATUSES, MEDIA_STATUSES, STORAGE_TIERS } from '@ksp/shared';
import { api } from '@/lib/api';
import { useUrlState } from '@/lib/hooks';
import { formatBytes, formatDateTime, formatDuration, titleCase } from '@/lib/format';
import { OrgUnitSelect } from '@/components/pickers';
import { Badge, Button, Card, DataTable, EmptyState, Field, Input, PageHeader, Pagination, Select, StatusBadge, clsx, type Column } from '@/components/ui';
import type { EvidenceListItem, Paged } from './types';

import { t as tr } from '@/lib/i18n';
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
      <div className="flex h-12 w-20 items-center justify-center rounded bg-ink-100 text-ink-400" role="img" aria-label={tr('{label}: no thumbnail', { label })}>
        <Film className="h-5 w-5" aria-hidden />
      </div>
    );
  }
  return <img src={url} alt={tr('Thumbnail of {label}', { label })} className="h-12 w-20 rounded bg-ink-900 object-cover" loading="lazy" />;
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
  // Phones show search, unit and status; the rest sits behind "More filters" (always visible from md up).
  const moreActive = (['mediaStatus', 'storageTier', 'recordedFrom', 'recordedTo', 'tag', 'legalHold', 'hasGps'] as const).filter((k) => s[k] !== '').length;
  const [moreOpen, setMoreOpen] = useState(moreActive > 0);

  const columns: Column<EvidenceListItem>[] = [
    { key: 'thumb', header: <span className="sr-only">{tr('Thumbnail')}</span>, render: (r) => <Thumb url={r.thumbnailUrl} label={r.evidenceNumber ?? r.id} />, className: 'hidden w-24 sm:table-cell' },
    {
      key: 'number',
      header: tr('Evidence'),
      sortKey: 'evidence_number',
      render: (r) => (
        <div className="min-w-[12rem] max-w-[20rem]">
          <p className="mono text-xs font-semibold text-brand-800">{r.evidenceNumber ?? '—'}</p>
          <p className="text-sm text-ink-900 [overflow-wrap:anywhere]">{r.title ?? <span className="text-ink-500">{tr('Untitled')}</span>}</p>
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
      header: tr('Status'),
      render: (r) => (
        <div className="flex flex-col items-start gap-1">
          <StatusBadge status={r.status} />
          <span className="whitespace-nowrap text-xs text-ink-500">{tr('Media:')}{' '}{titleCase(r.mediaStatus)}</span>
          <span className="whitespace-nowrap text-xs text-ink-500">{tr('Tier:')}{' '}{titleCase(r.storageTier)}</span>
          {r.legalHold && (
            <Badge tone="red">
              <Lock className="mr-1 h-3 w-3" aria-hidden />
              {tr('Legal hold')}
            </Badge>
          )}
        </div>
      ),
    },
    { key: 'unit', header: tr('Unit / officer'), className: 'min-w-[9rem]', render: (r) => (<div><p>{r.orgUnit.name}</p><p className="text-xs text-ink-500">{r.officer ? `${r.officer.fullName}${r.officer.badgeNumber ? ` (${r.officer.badgeNumber})` : ''}` : tr('Uploaded by {fullName}', { fullName: r.uploadedBy.fullName })}</p></div>) },
    { key: 'recorded', header: tr('Recorded'), sortKey: 'recorded_at', className: 'min-w-[7rem]', render: (r) => formatDateTime(r.recordedAt) },
    { key: 'duration', header: tr('Duration'), sortKey: 'duration_ms', className: 'hidden md:table-cell', render: (r) => formatDuration(r.durationMs) },
    { key: 'size', header: tr('Size'), sortKey: 'size_bytes', className: 'hidden md:table-cell', render: (r) => <span className="whitespace-nowrap">{formatBytes(r.sizeBytes)}</span> },
    { key: 'created', header: tr('Received'), sortKey: 'created_at', className: 'hidden min-w-[7rem] md:table-cell', render: (r) => formatDateTime(r.createdAt) },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title={tr('Evidence')} subtitle={tr('Video evidence within your jurisdiction. Every view is recorded in the chain of custody.')} />
      <Card>
        <form
          className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6"
          onSubmit={(e) => {
            e.preventDefault();
            const q = new FormData(e.currentTarget).get('q');
            set({ q: String(q ?? '').trim() });
          }}
        >
          <div className="col-span-2">
            <Field label={tr('Search')} htmlFor="ev-q">
              <Input id="ev-q" name="q" defaultValue={s.q} key={s.q} placeholder={tr('Evidence number, title, description, location…')} />
            </Field>
          </div>
          <Field label={tr('Unit')} htmlFor="ev-unit">
            <OrgUnitSelect id="ev-unit" value={s.orgUnitId} onChange={(v) => set({ orgUnitId: v })} />
          </Field>
          <Field label={tr('Status')} htmlFor="ev-status">
            <Select id="ev-status" value={s.status} onChange={(e) => set({ status: e.target.value })}>
              <option value="">{tr('All statuses')}</option>
              {EVIDENCE_STATUSES.map((x) => (
                <option key={x} value={x}>{titleCase(x)}</option>
              ))}
            </Select>
          </Field>
          <div className="col-span-2 md:hidden">
            <Button variant="secondary" size="sm" aria-expanded={moreOpen} aria-controls="ev-more" onClick={() => setMoreOpen((v) => !v)}>
              <SlidersHorizontal className="h-4 w-4" aria-hidden />
              {moreActive ? tr('More filters ({count} active)', { count: moreActive }) : tr('More filters')}
            </Button>
          </div>
          <div id="ev-more" className={clsx(moreOpen ? 'grid' : 'hidden', 'col-span-2 grid-cols-2 gap-3 md:contents')}>
          <Field label={tr('Media')} htmlFor="ev-media">
            <Select id="ev-media" value={s.mediaStatus} onChange={(e) => set({ mediaStatus: e.target.value })}>
              <option value="">{tr('Any')}</option>
              {MEDIA_STATUSES.map((x) => (
                <option key={x} value={x}>{titleCase(x)}</option>
              ))}
            </Select>
          </Field>
          <Field label={tr('Storage tier')} htmlFor="ev-tier">
            <Select id="ev-tier" value={s.storageTier} onChange={(e) => set({ storageTier: e.target.value })}>
              <option value="">{tr('Any')}</option>
              {STORAGE_TIERS.map((x) => (
                <option key={x} value={x}>{titleCase(x)}</option>
              ))}
            </Select>
          </Field>
          <Field label={tr('Recorded from')} htmlFor="ev-from">
            <Input id="ev-from" type="date" value={s.recordedFrom} onChange={(e) => set({ recordedFrom: e.target.value })} />
          </Field>
          <Field label={tr('Recorded to')} htmlFor="ev-to">
            <Input id="ev-to" type="date" value={s.recordedTo} onChange={(e) => set({ recordedTo: e.target.value })} />
          </Field>
          <Field label={tr('Tag')} htmlFor="ev-tag">
            <Input id="ev-tag" value={s.tag} onChange={(e) => set({ tag: e.target.value.toLowerCase() })} placeholder={tr('e.g. night patrol')} />
          </Field>
          <Field label={tr('Legal hold')} htmlFor="ev-hold">
            <Select id="ev-hold" value={s.legalHold} onChange={(e) => set({ legalHold: e.target.value })}>
              <option value="">{tr('Any')}</option>
              <option value="true">{tr('On hold')}</option>
              <option value="false">{tr('Not on hold')}</option>
            </Select>
          </Field>
          <Field label={tr('Location')} htmlFor="ev-gps">
            <Select id="ev-gps" value={s.hasGps} onChange={(e) => set({ hasGps: e.target.value })}>
              <option value="">{tr('Any')}</option>
              <option value="true">{tr('Has GPS')}</option>
              <option value="false">{tr('No GPS')}</option>
            </Select>
          </Field>
          </div>
          <div className="col-span-2 flex items-end gap-2 md:col-span-1">
            <Button type="submit">{tr('Search')}</Button>
            {filtered && (
              <Button variant="ghost" onClick={reset}>
                {tr('Clear')}
              </Button>
            )}
          </div>
        </form>
      </Card>
      <Card bodyClassName="p-0">
        <DataTable
          caption={tr('Evidence')}
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
              title={filtered ? tr('No evidence matches these filters') : tr('No evidence yet')}
              description={filtered ? tr('Try widening the date range or clearing filters.') : tr('Uploaded footage appears here once it is registered.')}
              action={filtered ? <Button variant="secondary" onClick={reset}>{tr('Clear filters')}</Button> : undefined}
            />
          }
        />
        {list.data && <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={(p) => set({ page: String(p) })} />}
      </Card>
    </div>
  );
}
