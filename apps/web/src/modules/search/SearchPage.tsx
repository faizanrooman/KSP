/**
 * Advanced evidence search. All state (criteria JSON, page, sort) lives in the URL so searches are shareable
 * and survive reload. Results are permission-filtered by the API; AI output that no human reviewer approved is
 * only included when the user ticks "Include unreviewed AI results", and is labelled as such.
 */
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Bookmark, Film, Filter, Lock, MapPin, Save, Search, Sparkles, Trash2, X } from 'lucide-react';
import { AI_TASKS, EVIDENCE_STATUSES, MEDIA_STATUSES, STORAGE_TIERS } from '@ksp/shared';
import { useUrlState } from '@/lib/hooks';
import { errorMessage } from '@/lib/api';
import { formatDateTime, formatDuration, formatTimecode, titleCase } from '@/lib/format';
import { OrgUnitSelect } from '@/components/pickers';
import { Alert, Badge, Button, Card, Checkbox, EmptyState, ErrorState, Field, Input, Modal, PageHeader, Pagination, Select, Spinner, StatusBadge, useToast } from '@/components/ui';
import {
  compactCriteria, countCriteria, decodeCriteria, encodeCriteria, momentLink, SEARCH_SORTS, useDeleteSavedSearch, useSavedSearches, useSaveSearch, useSearch,
  type FacetName, type SearchCriteria, type SearchItem, type SearchSort,
} from './api';

import { t as tr } from '@/lib/i18n';
const DEFAULTS = { c: '', page: '1', sort: '' };
const PAGE_SIZE = 25;
const SORT_LABEL: Record<SearchSort, string> = {
  relevance: 'Relevance', '-recorded_at': 'Recorded (newest)', recorded_at: 'Recorded (oldest)', '-created_at': 'Uploaded (newest)', created_at: 'Uploaded (oldest)',
};
const FACET_LABEL: Record<FacetName, string> = { station: 'Station', status: 'Status', storageTier: 'Storage tier', tag: 'Tag', aiLabel: 'AI label (approved)' };

const list = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean);
const num = (v: string) => (v.trim() === '' ? undefined : Number(v));
const toIso = (v: string) => (v ? new Date(v).toISOString() : undefined);
/** ISO -> value for <input type="datetime-local"> in local time */
const toLocal = (v: string | undefined) => {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  const off = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
};

/** Flat string form model for the advanced panel. */
interface Draft {
  text: string; evidenceNumber: string; orgUnitId: string; officerBadge: string; deviceSerial: string; recordedFrom: string; recordedTo: string;
  createdFrom: string; createdTo: string; lat: string; lon: string; radiusKm: string; tags: string; tagMode: 'any' | 'all'; categories: string;
  statuses: string[]; mediaStatuses: string[]; storageTiers: string[]; legalHold: '' | 'true' | 'false'; caseNumber: string; firNumber: string;
  firYear: string; firOrgUnitId: string; aiTasks: string[]; aiLabels: string; aiColors: string; plateText: string; watchlist: string; minConfidence: string;
  includeUnreviewed: boolean;
}

function toDraft(c: SearchCriteria): Draft {
  return {
    text: c.text ?? '', evidenceNumber: c.evidenceNumber ?? '', orgUnitId: c.orgUnitIds?.[0] ?? '', officerBadge: c.officerBadge ?? '', deviceSerial: c.deviceSerial ?? '',
    recordedFrom: toLocal(c.recordedFrom), recordedTo: toLocal(c.recordedTo), createdFrom: toLocal(c.createdFrom), createdTo: toLocal(c.createdTo),
    lat: c.location ? String(c.location.lat) : '', lon: c.location ? String(c.location.lon) : '', radiusKm: c.location ? String(c.location.radiusKm) : '',
    tags: (c.tags ?? []).join(', '), tagMode: c.tagMode ?? 'any', categories: (c.categories ?? []).join(', '), statuses: c.statuses ?? [], mediaStatuses: c.mediaStatuses ?? [],
    storageTiers: c.storageTiers ?? [], legalHold: c.legalHold === undefined ? '' : c.legalHold ? 'true' : 'false', caseNumber: c.caseNumber ?? '', firNumber: c.firNumber ?? '',
    firYear: c.firYear ? String(c.firYear) : '', firOrgUnitId: c.firOrgUnitId ?? '', aiTasks: c.ai?.tasks ?? [], aiLabels: (c.ai?.labels ?? []).join(', '),
    aiColors: (c.ai?.colors ?? []).join(', '), plateText: c.ai?.plateText ?? '', watchlist: (c.ai?.watchlistEntryIds ?? []).join(', '),
    minConfidence: c.ai?.minConfidence !== undefined ? String(Math.round(c.ai.minConfidence * 100)) : '', includeUnreviewed: c.ai?.reviewStatus === 'ANY_NON_REJECTED',
  };
}

/** Returns criteria or an error message for the form. */
function fromDraft(d: Draft, keep: SearchCriteria): { criteria?: SearchCriteria; error?: string; field?: keyof Draft } {
  const c: SearchCriteria = {
    text: d.text.trim() || undefined, evidenceNumber: d.evidenceNumber.trim() || undefined, orgUnitIds: d.orgUnitId ? [d.orgUnitId] : undefined,
    officerBadge: d.officerBadge.trim() || undefined, deviceSerial: d.deviceSerial.trim() || undefined, officerIds: keep.officerIds, deviceIds: keep.deviceIds,
    uploadedBy: keep.uploadedBy, caseIds: keep.caseIds, bbox: keep.bbox,
    recordedFrom: toIso(d.recordedFrom), recordedTo: toIso(d.recordedTo), createdFrom: toIso(d.createdFrom), createdTo: toIso(d.createdTo),
    tags: list(d.tags).map((t) => t.toLowerCase()), tagMode: d.tagMode, categories: list(d.categories), statuses: d.statuses, mediaStatuses: d.mediaStatuses,
    storageTiers: d.storageTiers, legalHold: d.legalHold === '' ? undefined : d.legalHold === 'true', caseNumber: d.caseNumber.trim() || undefined,
    firNumber: d.firNumber.trim() || undefined, firYear: num(d.firYear), firOrgUnitId: d.firOrgUnitId || undefined,
  };
  if ((c.firYear || c.firOrgUnitId) && !c.firNumber) return { error: 'Enter the FIR number to filter by FIR year or station.', field: 'firNumber' };
  if (d.lat || d.lon || d.radiusKm) {
    const lat = num(d.lat);
    const lon = num(d.lon);
    const r = num(d.radiusKm);
    if (lat === undefined || lon === undefined || r === undefined || [lat, lon, r].some((x) => Number.isNaN(x))) return { error: 'Location needs latitude, longitude and radius (km).', field: lat === undefined || Number.isNaN(lat) ? 'lat' : lon === undefined || Number.isNaN(lon) ? 'lon' : 'radiusKm' };
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180 || r <= 0 || r > 500) return { error: 'Latitude −90..90, longitude −180..180, radius 0–500 km.', field: lat < -90 || lat > 90 ? 'lat' : lon < -180 || lon > 180 ? 'lon' : 'radiusKm' };
    c.location = { lat, lon, radiusKm: r };
    c.bbox = undefined;
  }
  const minConf = num(d.minConfidence);
  if (minConf !== undefined && (Number.isNaN(minConf) || minConf < 0 || minConf > 100)) return { error: 'Minimum confidence must be 0–100 %.', field: 'minConfidence' };
  const ai = {
    tasks: d.aiTasks, labels: list(d.aiLabels), colors: list(d.aiColors), plateText: d.plateText.trim() || undefined, watchlistEntryIds: list(d.watchlist),
    minConfidence: minConf === undefined ? undefined : minConf / 100, reviewStatus: d.includeUnreviewed ? ('ANY_NON_REJECTED' as const) : ('APPROVED' as const),
  };
  const hasAi = ai.tasks.length || ai.labels.length || ai.colors.length || ai.plateText || ai.watchlistEntryIds.length || ai.minConfidence !== undefined || d.includeUnreviewed;
  if (hasAi) c.ai = ai;
  if (ai.watchlistEntryIds.some((x) => !/^[0-9a-f-]{36}$/i.test(x))) return { error: 'Watchlist entry ids must be UUIDs.', field: 'watchlist' };
  return { criteria: compactCriteria(c) };
}

function toggle(arr: string[], v: string) {
  return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
}

function CheckGroup({ legend, values, selected, onChange }: { legend: string; values: readonly string[]; selected: string[]; onChange: (v: string[]) => void }) {
  return (
    <fieldset>
      <legend className="label">{legend}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {values.map((v) => (
          <Checkbox key={v} label={titleCase(v)} checked={selected.includes(v)} onChange={() => onChange(toggle(selected, v))} />
        ))}
      </div>
    </fieldset>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3 border-t border-ink-100 pt-3 first:border-t-0 first:pt-0">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-500">{title}</h3>
      {children}
    </section>
  );
}

function AdvancedPanel({ initial, onApply, onClose }: { initial: SearchCriteria; onApply: (c: SearchCriteria) => void; onClose: () => void }) {
  const [d, setD] = useState<Draft>(() => toDraft(initial));
  const [error, setError] = useState<string | null>(null);
  const [badField, setBadField] = useState<keyof Draft | null>(null);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const r = fromDraft(d, initial);
    setBadField(r.field ?? null);
    if (r.error) {
      setError(r.error);
      // The message sits next to Apply, far from the offending field: mark that field and move focus to it.
      if (r.field) document.getElementById(`adv-${r.field}`)?.focus();
      return;
    }
    setError(null);
    onApply(r.criteria!);
  };
  const inp = (k: keyof Draft, label: string, props: Record<string, unknown> = {}) => (
    <Field label={label} htmlFor={`adv-${k}`} error={badField === k ? error : undefined}>
      <Input id={`adv-${k}`} value={d[k] as string} onChange={(e) => set(k, e.target.value as never)} {...props} />
    </Field>
  );
  return (
    <Card title={tr('Advanced filters')} actions={<Button variant="ghost" size="sm" icon={<X className="h-4 w-4" />} onClick={onClose} aria-label={tr('Close advanced filters')} />}>
      <form onSubmit={submit} className="space-y-4">
        <Section title={tr('Identity & people')}>
          <div className="grid gap-3 md:grid-cols-3">
            {inp('evidenceNumber', 'Evidence number (prefix)', { placeholder: tr('KSP-CUBBONPARK-2026-') })}
            <Field label={tr('Station / jurisdiction')} htmlFor="adv-org">
              <OrgUnitSelect id="adv-org" value={d.orgUnitId} onChange={(v) => set('orgUnitId', v)} />
            </Field>
            {inp('officerBadge', 'Officer badge number', { placeholder: tr('KSP-FO-1001') })}
            {inp('deviceSerial', 'Device serial')}
            {inp('caseNumber', 'Case number (prefix)')}
            <div className="grid grid-cols-3 gap-2">
              <div className="col-span-3 md:col-span-1">{inp('firNumber', 'FIR number')}</div>
              <div className="col-span-3 md:col-span-1">{inp('firYear', 'FIR year', { inputMode: 'numeric', placeholder: '2026' })}</div>
              <div className="col-span-3 md:col-span-1">
                <Field label={tr('FIR station')} htmlFor="adv-firorg">
                  <OrgUnitSelect id="adv-firorg" value={d.firOrgUnitId} onChange={(v) => set('firOrgUnitId', v)} stationsOnly emptyLabel={tr('Any')} />
                </Field>
              </div>
            </div>
          </div>
        </Section>
        <Section title={tr('Time')}>
          <div className="grid gap-3 md:grid-cols-4">
            {inp('recordedFrom', 'Recorded from', { type: 'datetime-local' })}
            {inp('recordedTo', 'Recorded to', { type: 'datetime-local' })}
            {inp('createdFrom', 'Uploaded from', { type: 'datetime-local' })}
            {inp('createdTo', 'Uploaded to', { type: 'datetime-local' })}
          </div>
        </Section>
        <Section title={tr('Location (radius)')}>
          <div className="grid gap-3 md:grid-cols-3">
            {inp('lat', 'Latitude', { inputMode: 'decimal', placeholder: '12.9763' })}
            {inp('lon', 'Longitude', { inputMode: 'decimal', placeholder: '77.5929' })}
            {inp('radiusKm', 'Radius (km)', { inputMode: 'decimal', placeholder: '1' })}
          </div>
        </Section>
        <Section title={tr('Classification & lifecycle')}>
          <div className="grid gap-3 md:grid-cols-3">
            {inp('tags', 'Tags (comma separated)')}
            <Field label={tr('Match tags')} htmlFor="adv-tagmode">
              <Select id="adv-tagmode" value={d.tagMode} onChange={(e) => set('tagMode', e.target.value as 'any' | 'all')}>
                <option value="any">{tr('Any of the tags')}</option>
                <option value="all">{tr('All of the tags')}</option>
              </Select>
            </Field>
            {inp('categories', 'Categories (comma separated)')}
            <Field label={tr('Legal hold')} htmlFor="adv-hold">
              <Select id="adv-hold" value={d.legalHold} onChange={(e) => set('legalHold', e.target.value as Draft['legalHold'])}>
                <option value="">{tr('Any')}</option>
                <option value="true">{tr('Under legal hold')}</option>
                <option value="false">{tr('Not on hold')}</option>
              </Select>
            </Field>
          </div>
          <CheckGroup legend="Evidence status" values={EVIDENCE_STATUSES} selected={d.statuses} onChange={(v) => set('statuses', v)} />
          <CheckGroup legend="Processing state" values={MEDIA_STATUSES} selected={d.mediaStatuses} onChange={(v) => set('mediaStatuses', v)} />
          <CheckGroup legend="Storage tier (all tiers are searchable)" values={STORAGE_TIERS.filter((t) => t !== 'STAGING')} selected={d.storageTiers} onChange={(v) => set('storageTiers', v)} />
        </Section>
        <Section title={tr('AI-derived (reviewed results)')}>
          <CheckGroup legend="AI task" values={AI_TASKS} selected={d.aiTasks} onChange={(v) => set('aiTasks', v)} />
          <div className="grid gap-3 md:grid-cols-3">
            {inp('aiLabels', 'Objects / labels', { placeholder: tr('person, car, knife') })}
            {inp('aiColors', 'Colours', { placeholder: tr('red, white') })}
            {inp('plateText', 'Licence plate (prefix)', { placeholder: tr('KA01AB') })}
            {inp('watchlist', 'Watchlist entry ids')}
            {inp('minConfidence', 'Minimum confidence (%)', { inputMode: 'numeric', placeholder: '70' })}
          </div>
          <Checkbox
            label={tr('Include unreviewed AI results')}
            description={tr('Adds AI detections that no human reviewer has approved yet (rejected results are never included). Such matches are labelled “Unreviewed AI” and must not be relied on without review.')}
            checked={d.includeUnreviewed}
            onChange={(v) => set('includeUnreviewed', v)}
          />
        </Section>
        {error && <Alert tone="red">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setD(toDraft({}))}>{tr('Clear form')}</Button>
          <Button type="submit" icon={<Filter className="h-4 w-4" />}>{tr('Apply filters')}</Button>
        </div>
      </form>
    </Card>
  );
}

function Snippet({ parts }: { parts: Array<{ text: string; hit: boolean }> }) {
  return (
    <p className="text-sm text-ink-600">
      {parts.map((p, i) => (p.hit ? <mark key={i} className="rounded bg-amber-100 px-0.5 text-ink-900">{p.text}</mark> : <span key={i}>{p.text}</span>))}
    </p>
  );
}

function ResultCard({ item }: { item: SearchItem }) {
  const m = item.matches;
  return (
    <li className="flex gap-4 rounded-lg border border-ink-200 bg-white p-3">
      <Link to={`/evidence/${item.id}`} className="shrink-0" aria-label={`Open ${item.evidenceNumber ?? 'evidence'}`}>
        {item.thumbnailUrl ? (
          <img src={item.thumbnailUrl} alt="" className="h-20 w-32 rounded bg-ink-900 object-cover" loading="lazy" />
        ) : (
          <div className="flex h-20 w-32 items-center justify-center rounded bg-ink-100 text-ink-400"><Film className="h-6 w-6" aria-hidden /></div>
        )}
      </Link>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link to={`/evidence/${item.id}`} className="mono text-xs font-semibold text-brand-800 hover:underline">{item.evidenceNumber ?? item.id}</Link>
          <StatusBadge status={item.status} />
          {item.storageTier !== 'ACTIVE' && <Badge tone="blue">{titleCase(item.storageTier)}</Badge>}
          {item.legalHold && <Badge tone="amber"><Lock className="mr-1 inline h-3 w-3" aria-hidden />{tr('Legal hold')}</Badge>}
          {m.score !== null && <span className="text-xs text-ink-500">{tr('score')}{' '}{m.score}</span>}
        </div>
        <p className="font-medium text-ink-900 [overflow-wrap:anywhere]">{item.title ?? <span className="text-ink-500">{tr('Untitled')}</span>}</p>
        {m.snippet && <Snippet parts={m.snippet} />}
        <p className="text-xs text-ink-500">
          {item.orgUnit.name}
          {item.recordedAt ? ` · recorded ${formatDateTime(item.recordedAt)}` : ' · recording time unknown'}
          {item.durationMs ? ` · ${formatDuration(item.durationMs)}` : ''}
          {item.officer && <> · {item.officer.fullName}{item.officer.badgeNumber ? ` (${item.officer.badgeNumber})` : ''}</>}
        </p>
        {item.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">{item.tags.map((t) => <Badge key={t}>{t}</Badge>)}</div>
        )}
        {m.ai.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 pt-1" role="group" aria-label={tr('Matching AI moments')}>
            <Sparkles className="h-3.5 w-3.5 text-brand-700" aria-hidden />
            {m.ai.map((a) => (
              <Link
                key={a.detectionId}
                to={momentLink(item.id, a.frameTimeMs)}
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs hover:underline ${a.unreviewed ? 'border-amber-400 bg-amber-50 text-amber-900' : 'border-brand-200 bg-brand-50 text-brand-800'}`}
                title={`Jump to ${formatTimecode(a.frameTimeMs)}`}
              >
                {a.label}
                {a.colorName ? ` · ${a.colorName}` : ''}
                {a.plateText ? ` · ${a.plateText}` : ''} · {Math.round(a.confidence * 100)}% @ {formatTimecode(a.frameTimeMs)}
                {a.unreviewed && <span className="font-semibold">{' '}{tr('· Unreviewed AI')}</span>}
              </Link>
            ))}
            {m.aiTotal > m.ai.length && <span className="text-xs text-ink-500">+{m.aiTotal - m.ai.length}{' '}{tr('more')}</span>}
          </div>
        )}
      </div>
    </li>
  );
}

function SavedSearchesMenu({ onPick }: { onPick: (c: SearchCriteria) => void }) {
  const saved = useSavedSearches();
  const del = useDeleteSavedSearch();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" icon={<Bookmark className="h-4 w-4" />} onClick={() => setOpen(true)}>{tr('Saved searches')}</Button>
      <Modal open={open} onClose={() => setOpen(false)} title={tr('Saved searches')}>
        {saved.isLoading ? <Spinner /> : saved.error ? <ErrorState error={saved.error} onRetry={() => void saved.refetch()} /> : !saved.data?.items.length ? (
          <EmptyState title={tr('No saved searches')} description={tr('Run a search and choose “Save search” to keep it here.')} />
        ) : (
          <ul className="divide-y divide-ink-100">
            {saved.data.items.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-2 py-2">
                <button type="button" className="text-left text-sm font-medium text-brand-800 hover:underline" onClick={() => { onPick(s.criteria); setOpen(false); }}>
                  {s.name}
                  <span className="block text-xs font-normal text-ink-500">{countCriteria(s.criteria)}{' '}{tr('filter(s)')}{' '}{s.criteria.text ? ` · “${s.criteria.text}”` : ''}</span>
                </button>
                <Button variant="ghost" size="sm" icon={<Trash2 className="h-4 w-4" />} aria-label={`Delete saved search ${s.name}`} loading={del.isPending && del.variables === s.id} onClick={() => del.mutate(s.id)} />
              </li>
            ))}
          </ul>
        )}
        {del.error && <Alert tone="red">{errorMessage(del.error)}</Alert>}
      </Modal>
    </>
  );
}

function SaveSearchButton({ criteria }: { criteria: SearchCriteria }) {
  const save = useSaveSearch();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  // Enter in the name field saves, like the button (the field is not inside a <form>).
  const submit = () => {
    if (!name.trim() || save.isPending) return;
    save.mutate({ name: name.trim(), criteria }, { onSuccess: () => { setOpen(false); toast.success('Search saved'); } });
  };
  return (
    <>
      <Button variant="secondary" icon={<Save className="h-4 w-4" />} onClick={() => { setName(criteria.text ?? ''); save.reset(); setOpen(true); }}>{tr('Save search')}</Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={tr('Save this search')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>{tr('Cancel')}</Button>
            <Button loading={save.isPending} disabled={!name.trim()} onClick={submit}>{tr('Save')}</Button>
          </>
        }
      >
        <Field label={tr('Name')} htmlFor="saved-name" required>
          <Input id="saved-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} autoFocus />
        </Field>
        <p className="mt-2 text-xs text-ink-500">{tr('Saved searches store the criteria only; results are re-evaluated against your access every time.')}</p>
        {save.error && <div className="mt-2"><Alert tone="red">{errorMessage(save.error)}</Alert></div>}
      </Modal>
    </>
  );
}

export function SearchPage() {
  const [url, setUrl] = useUrlState(DEFAULTS);
  const criteria = useMemo(() => decodeCriteria(url.c), [url.c]);
  const page = Math.max(1, Number(url.page) || 1);
  const sort = (SEARCH_SORTS as readonly string[]).includes(url.sort) ? (url.sort as SearchSort) : undefined;
  const q = useSearch(criteria, page, PAGE_SIZE, sort);
  const [text, setText] = useState(criteria.text ?? '');
  const [advanced, setAdvanced] = useState(false);
  useEffect(() => setText(criteria.text ?? ''), [criteria.text]);

  const apply = (c: SearchCriteria) => setUrl({ c: encodeCriteria(c), page: '1' });
  const submitText = (e: FormEvent) => {
    e.preventDefault();
    apply({ ...criteria, text: text.trim() || undefined });
  };
  const addFacet = (f: FacetName, key: string) => {
    const c = { ...criteria };
    if (f === 'station') c.orgUnitIds = [key];
    if (f === 'status') c.statuses = [...new Set([...(c.statuses ?? []), key])];
    if (f === 'storageTier') c.storageTiers = [...new Set([...(c.storageTiers ?? []), key])];
    if (f === 'tag') c.tags = [...new Set([...(c.tags ?? []), key])];
    if (f === 'aiLabel') c.ai = { ...(c.ai ?? {}), labels: [...new Set([...(c.ai?.labels ?? []), key])] };
    apply(c);
  };
  const active = countCriteria(criteria);
  const data = q.data;

  return (
    <div className="space-y-4">
      <PageHeader title={tr('Search evidence')} subtitle={tr('Full-text, metadata, location, case/FIR and AI-derived search across all storage tiers — limited to evidence you are authorised to see.')} />
      <form onSubmit={submitText} className="flex flex-wrap items-end gap-2" role="search">
        <div className="min-w-[16rem] flex-1">
          <label htmlFor="search-text" className="sr-only">{tr('Search text')}</label>
          <Input id="search-text" value={text} onChange={(e) => setText(e.target.value)} placeholder={tr('Words, evidence number, file name… e.g. robbery "MG Road" -traffic')} maxLength={200} />
        </div>
        <Button type="submit" icon={<Search className="h-4 w-4" />}>{tr('Search')}</Button>
        <Button variant="secondary" icon={<Filter className="h-4 w-4" />} onClick={() => setAdvanced((v) => !v)} aria-expanded={advanced}>
          {tr('Filters')}{' '}{active ? ` (${active})` : ''}
        </Button>
        <SavedSearchesMenu onPick={apply} />
        <SaveSearchButton criteria={criteria} />
        {(active > 0 || criteria.text) && <Button variant="ghost" onClick={() => { setText(''); setUrl({ c: '', page: '1', sort: '' }); }}>{tr('Reset')}</Button>}
      </form>
      {advanced && <AdvancedPanel key={url.c} initial={criteria} onApply={(c) => { apply(c); setAdvanced(false); }} onClose={() => setAdvanced(false)} />}
      {criteria.ai?.reviewStatus === 'ANY_NON_REJECTED' && (
        <Alert tone="amber" title={tr('Unreviewed AI results included')}>{tr('Matches marked “Unreviewed AI” come from detections that no human reviewer has approved. Verify them before relying on them.')}</Alert>
      )}
      {criteria.location && (
        <p className="flex items-center gap-1 text-xs text-ink-600"><MapPin className="h-3.5 w-3.5" aria-hidden />{tr('Within')}{' '}{criteria.location.radiusKm}{' '}{tr('km of')}{' '}{criteria.location.lat}, {criteria.location.lon}</p>
      )}
      <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <aside aria-label={tr('Facets')} className="grid content-start gap-3 sm:grid-cols-2 lg:grid-cols-1">
          {data?.facets ? (
            (Object.keys(FACET_LABEL) as FacetName[]).map((f) =>
              data.facets![f].length ? (
                <Card key={f} title={FACET_LABEL[f]} bodyClassName="p-2">
                  <ul className="space-y-0.5">
                    {data.facets![f].map((b) => (
                      <li key={b.key}>
                        <button type="button" onClick={() => addFacet(f, b.key)} className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-sm hover:bg-ink-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500">
                          <span className="truncate" title={b.label}>{f === 'status' || f === 'storageTier' ? titleCase(b.label) : b.label}</span>
                          <span className="ml-2 text-xs text-ink-500">{b.count}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </Card>
              ) : null,
            )
          ) : q.isLoading ? <Spinner label={tr('Loading facets…')} /> : null}
          {data?.facetsTruncated && <p className="text-xs text-ink-500">{tr('Facets computed over the first 10,000 matches.')}</p>}
        </aside>
        <section aria-label={tr('Results')} className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-ink-600" aria-live="polite">
              {data ? `${data.total.toLocaleString('en-IN')}${data.totalApprox ? '+' : ''} result${data.total === 1 && !data.totalApprox ? '' : 's'}` : ' '}
              {data && <span className="text-ink-500"> · {data.tookMs}{' '}{tr('ms')}</span>}
              {q.isFetching && !q.isLoading && <span className="ml-2 text-ink-500">{tr('Updating…')}</span>}
            </p>
            <label className="flex items-center gap-2 text-sm">
              <span className="text-ink-600">{tr('Sort')}</span>
              <Select value={sort ?? ''} onChange={(e) => setUrl({ sort: e.target.value, page: '1' })} aria-label={tr('Sort results')}>
                <option value="">{tr('Default (')}{criteria.text ? 'relevance' : 'recorded, newest'})</option>
                {SEARCH_SORTS.map((s) => <option key={s} value={s}>{SORT_LABEL[s]}</option>)}
              </Select>
            </label>
          </div>
          {q.isLoading ? (
            <Spinner label={tr('Searching…')} />
          ) : q.error ? (
            <ErrorState error={q.error} onRetry={() => void q.refetch()} title={tr('Search failed')} />
          ) : !data?.items.length ? (
            <EmptyState title={tr('No matching evidence')} description={active || criteria.text ? 'Try fewer filters or different words. Only evidence you are authorised to see is searched.' : 'No evidence is visible to you yet.'} />
          ) : (
            <>
              <ul className="space-y-2">{data.items.map((it) => <ResultCard key={it.id} item={it} />)}</ul>
              <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onPage={(p) => setUrl({ page: String(p) })} />
            </>
          )}
        </section>
      </div>
    </div>
  );
}
