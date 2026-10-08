import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, X } from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import { formatBytes, formatDateTime, formatDuration, titleCase } from '@/lib/format';
import type { EvidenceSummary } from '@/lib/extensions';
import { Alert, Badge, Button, Card, Field, Input, KeyValue, Textarea, useToast } from '@/components/ui';
import { evidenceKey, type EvidenceDetail } from './types';

import { t as tr } from '@/lib/i18n';
const TAG_RE = /^[a-z0-9][a-z0-9 _:.-]{0,62}$/;

function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const off = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
}

function MetadataForm({ ev, onDone }: { ev: EvidenceDetail; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({ title: ev.title ?? '', description: ev.description ?? '', category: ev.category ?? '', incidentAt: toLocalInput(ev.incidentAt), locationText: ev.locationText ?? '' });
  const save = useMutation({
    mutationFn: () =>
      api.patch<EvidenceDetail>(`/evidence/${ev.id}`, {
        title: f.title.trim() || null,
        description: f.description.trim() || null,
        category: f.category.trim() || null,
        incidentAt: f.incidentAt ? new Date(f.incidentAt).toISOString() : null,
        locationText: f.locationText.trim() || null,
      }),
    onSuccess: (data) => {
      qc.setQueryData(evidenceKey(ev.id), data);
      void qc.invalidateQueries({ queryKey: ['evidence', 'list'] });
      toast.success('Metadata saved (recorded in the chain of custody)');
      onDone();
    },
  });
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Field label={tr('Title')} htmlFor="md-title">
        <Input id="md-title" value={f.title} maxLength={300} onChange={(e) => setF({ ...f, title: e.target.value })} />
      </Field>
      <Field label={tr('Description')} htmlFor="md-desc">
        <Textarea id="md-desc" rows={4} value={f.description} maxLength={10000} onChange={(e) => setF({ ...f, description: e.target.value })} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={tr('Category')} htmlFor="md-cat">
          <Input id="md-cat" value={f.category} maxLength={100} onChange={(e) => setF({ ...f, category: e.target.value })} placeholder={tr('e.g. TRAFFIC, PUBLIC_ORDER')} />
        </Field>
        <Field label={tr('Incident time')} htmlFor="md-inc">
          <Input id="md-inc" type="datetime-local" value={f.incidentAt} onChange={(e) => setF({ ...f, incidentAt: e.target.value })} />
        </Field>
      </div>
      <Field label={tr('Location')} htmlFor="md-loc">
        <Input id="md-loc" value={f.locationText} maxLength={500} onChange={(e) => setF({ ...f, locationText: e.target.value })} />
      </Field>
      {save.error ? <Alert tone="red">{errorMessage(save.error)}</Alert> : null}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onDone} disabled={save.isPending}>
          {tr('Cancel')}
        </Button>
        <Button type="submit" loading={save.isPending}>
          {tr('Save changes')}
        </Button>
      </div>
    </form>
  );
}

function TagEditor({ ev }: { ev: EvidenceDetail }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [tag, setTag] = useState('');
  const normalized = tag.trim().toLowerCase().replace(/\s+/g, ' ');
  const invalid = normalized !== '' && !TAG_RE.test(normalized);
  const refresh = () => void qc.invalidateQueries({ queryKey: evidenceKey(ev.id) });
  const add = useMutation({ mutationFn: () => api.post(`/evidence/${ev.id}/tags`, { tag: normalized }), onSuccess: () => { setTag(''); refresh(); }, onError: (e) => toast.error(e) });
  const remove = useMutation({ mutationFn: (t: string) => api.delete(`/evidence/${ev.id}/tags/${encodeURIComponent(t)}`), onSuccess: refresh, onError: (e) => toast.error(e) });
  return (
    <div className="space-y-2">
      <ul className="flex flex-wrap gap-1.5" aria-label={tr('Tags')}>
        {ev.tags.length === 0 && <li className="text-sm text-ink-500">{tr('No tags')}</li>}
        {ev.tags.map((t) => (
          <li key={t.tag}>
            <Badge tone={t.source === 'MANUAL' ? 'blue' : 'purple'}>
              {t.tag}
              {t.source !== 'MANUAL' && <span className="ml-1 opacity-70">({titleCase(t.source)})</span>}
              {ev.permissions.canEdit && t.source === 'MANUAL' && (
                <button type="button" className="ml-1 rounded hover:bg-brand-100" aria-label={`Remove tag ${t.tag}`} onClick={() => remove.mutate(t.tag)} disabled={remove.isPending}>
                  <X className="h-3 w-3" />
                </button>
              )}
            </Badge>
          </li>
        ))}
      </ul>
      {ev.permissions.canEdit && (
        <form
          className="flex items-start gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (normalized && !invalid) add.mutate();
          }}
        >
          <div className="flex-1">
            <label htmlFor="tag-new" className="sr-only">{tr('New tag')}</label>
            <Input id="tag-new" value={tag} onChange={(e) => setTag(e.target.value)} placeholder={tr('Add a tag…')} maxLength={63} aria-invalid={invalid} />
            {invalid && <p className="mt-1 text-xs text-red-700">{tr('Letters, digits, space and _ : . - only; must start with a letter or digit.')}</p>}
          </div>
          <Button type="submit" variant="secondary" disabled={!normalized || invalid} loading={add.isPending}>
            {tr('Add')}
          </Button>
        </form>
      )}
    </div>
  );
}

export function OverviewTab({ evidence }: { evidence: EvidenceSummary }) {
  const ev = evidence as EvidenceDetail;
  const [editing, setEditing] = useState(false);
  const hasGps = ev.gpsLatitude !== null && ev.gpsLongitude !== null;
  const osm = hasGps ? `https://www.openstreetmap.org/?mlat=${ev.gpsLatitude}&mlon=${ev.gpsLongitude}#map=17/${ev.gpsLatitude}/${ev.gpsLongitude}` : null;
  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <div className="space-y-4 xl:col-span-2">
        <Card title={tr('Description')} actions={ev.permissions.canEdit && !editing ? <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>{tr('Edit')}</Button> : undefined}>
          {editing ? (
            <MetadataForm ev={ev} onDone={() => setEditing(false)} />
          ) : (
            <KeyValue
              items={[
                { label: tr('Title'), value: ev.title },
                { label: tr('Category'), value: ev.category },
                { label: tr('Incident time'), value: formatDateTime(ev.incidentAt) },
                { label: tr('Location'), value: ev.locationText },
                { label: tr('Description'), value: ev.description ? <span className="whitespace-pre-wrap">{ev.description}</span> : null },
              ]}
            />
          )}
        </Card>
        <Card title={tr('Technical metadata')}>
          <KeyValue
            columns={3}
            items={[
              { label: tr('Original file'), value: ev.originalFilename, mono: true },
              { label: tr('MIME type'), value: ev.mimeType },
              { label: tr('Size'), value: formatBytes(ev.sizeBytes) },
              {
                label: tr('Recorded start'),
                value: (
                  <span>
                    {formatDateTime(ev.recordedAt)}
                    {ev.recordedAtSource && <span className="ml-1 text-xs text-ink-500">({ev.recordedAtSource === 'CONTAINER_TAG' ? 'camera clock in file' : 'declared at upload'})</span>}
                    {ev.recordedAtFlagged && (
                      <span className="ml-1"><Badge tone="amber">{tr('Time discrepancy')}</Badge> <span className="text-xs text-ink-700">{tr('declared')}{' '}{formatDateTime(ev.declaredRecordedAt ?? null)}{' '}{tr('— differs by')}{' '}{Math.round((ev.recordedAtDiscrepancySeconds ?? 0) / 60)}{' '}{tr('min')}</span></span>
                    )}
                  </span>
                ),
              },
              { label: tr('Recorded end'), value: formatDateTime(ev.recordedEndAt) },
              { label: tr('Duration'), value: formatDuration(ev.durationMs) },
              { label: tr('Container'), value: ev.containerFormat },
              { label: tr('Video codec'), value: ev.videoCodec },
              { label: tr('Audio codec'), value: ev.audioCodec },
              { label: tr('Resolution'), value: ev.width && ev.height ? `${ev.width}×${ev.height}` : null },
              { label: tr('Frame rate'), value: ev.frameRate ? `${ev.frameRate} fps` : null },
              { label: tr('Bit rate'), value: ev.bitRate ? `${Math.round(ev.bitRate / 1000)} kbit/s` : null },
              { label: tr('Media processing'), value: <>{titleCase(ev.mediaStatus)}{ev.mediaError ? <span className="block text-xs text-red-700">{ev.mediaError}</span> : null}</> },
              { label: tr('Registered'), value: formatDateTime(ev.registeredAt) },
              ev.duplicateOf && { label: tr('Duplicate of'), value: <Link className="text-brand-700 hover:underline" to={`/evidence/${ev.duplicateOf.id}`}>{ev.duplicateOf.evidenceNumber ?? ev.duplicateOf.id}</Link> },
            ]}
          />
          {Object.keys(ev.deviceMetadata ?? {}).length > 0 && (
            <details className="mt-4 text-sm">
              <summary className="cursor-pointer text-ink-600">{tr('Device / container tags')}</summary>
              <pre className="mono mt-2 max-h-64 overflow-auto rounded bg-ink-50 p-2 text-xs">{JSON.stringify(ev.deviceMetadata, null, 2)}</pre>
            </details>
          )}
        </Card>
      </div>
      <div className="space-y-4">
        <Card title={tr('People & device')}>
          <KeyValue
            columns={1}
            items={[
              { label: tr('Recording officer'), value: ev.officer ? `${ev.officer.fullName}${ev.officer.badgeNumber ? ` (${ev.officer.badgeNumber})` : ''}` : null },
              { label: tr('Uploaded by'), value: ev.uploadedBy.fullName },
              { label: tr('Unit'), value: ev.orgUnit.name },
              { label: tr('Device'), value: ev.device ? `${ev.device.serialNumber}${ev.device.make ? ` · ${ev.device.make} ${ev.device.model ?? ''}` : ''}` : null },
            ]}
          />
        </Card>
        <Card title={tr('Location')}>
          {hasGps ? (
            <KeyValue
              columns={1}
              items={[
                { label: tr('Coordinates'), value: `${ev.gpsLatitude!.toFixed(6)}, ${ev.gpsLongitude!.toFixed(6)}`, mono: true },
                { label: tr('Source'), value: ev.gpsSource ? titleCase(ev.gpsSource) : null },
                { label: tr('Map'), value: <a className="inline-flex items-center gap-1 text-brand-700 hover:underline" href={osm!} target="_blank" rel="noreferrer noopener">{tr('Open in OpenStreetMap')}{' '}<ExternalLink className="h-3.5 w-3.5" aria-hidden /></a> },
              ]}
            />
          ) : (
            <p className="text-sm text-ink-500">{tr('No GPS position recorded for this footage.')}</p>
          )}
        </Card>
        <Card title={tr('Tags')}>
          <TagEditor ev={ev} />
        </Card>
        <Card title={tr('Linked cases')}>
          {ev.cases.length === 0 ? (
            <p className="text-sm text-ink-500">{tr('Not linked to any case')}{' '}{ev.hiddenCaseCount ? ` you can see (${ev.hiddenCaseCount} restricted)` : ''}.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {ev.cases.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-2">
                  <Link className="text-brand-700 hover:underline" to={`/cases/${c.id}`}>
                    <span className="mono">{c.caseNumber}</span> — {c.title}
                  </Link>
                  <Badge>{titleCase(c.status)}</Badge>
                </li>
              ))}
              {ev.hiddenCaseCount > 0 && <li className="text-xs text-ink-500">+{ev.hiddenCaseCount}{' '}{tr('case(s) outside your access')}</li>}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
