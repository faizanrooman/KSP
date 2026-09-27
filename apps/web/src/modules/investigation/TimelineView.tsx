/** Incident reconstruction: lanes per recording + manual events, overlap list, chronological list. */
import { useState, type FormEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { Clock, Layers, Plus, Trash2 } from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime, formatDuration, formatTimecode } from '@/lib/format';
import { Alert, Badge, Button, Card, EmptyState, ErrorState, Field, Input, Select, Spinner, Textarea } from '@/components/ui';
import { useTimeline, useWsMutation, type TimelineEntry, type VisibleItem } from './api';
import { laneTimeAt, layoutTimeline } from './geometry';

interface Props {
  workspaceId: string;
  items: VisibleItem[];
  editable: boolean;
  onOpen: (itemId: string, timeMs: number) => void;
  onCompare: (itemIds: string[], offsets: Record<string, number>) => void;
}

const kindTone: Record<TimelineEntry['kind'], 'gray' | 'blue' | 'amber' | 'green'> = { RECORDING: 'blue', EVENT: 'green', BOOKMARK: 'amber', ANNOTATION: 'gray' };

function toLocalInput(d: Date) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
}

export function TimelineView({ workspaceId, items, editable, onOpen, onCompare }: Props) {
  const tl = useTimeline(workspaceId);
  const [form, setForm] = useState({ title: '', description: '', occurredAt: '', evidenceId: '', timeS: '' });
  const [formError, setFormError] = useState<string | null>(null);
  const addEvent = useWsMutation((b: Record<string, unknown>) => api.post(`/workspaces/${workspaceId}/timeline/events`, b));
  const delEvent = useWsMutation((id: string) => api.delete(`/workspaces/${workspaceId}/timeline/events/${id}`));
  const itemByEvidence = new Map(items.map((i) => [i.evidenceId, i]));

  if (tl.isLoading) return <Spinner label="Building timeline…" />;
  if (tl.error) return <ErrorState error={tl.error} onRetry={() => void tl.refetch()} />;
  const t = tl.data!;
  const layout = layoutTimeline(t);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!form.title.trim() || !form.occurredAt) return setFormError('Title and time are required.');
    const timeMs = form.timeS.trim() === '' ? null : Math.round(Number(form.timeS) * 1000);
    if (timeMs !== null && (!Number.isFinite(timeMs) || timeMs < 0)) return setFormError('Video time must be a positive number of seconds.');
    setFormError(null);
    addEvent.mutate(
      { title: form.title.trim(), description: form.description.trim() || null, occurredAt: new Date(form.occurredAt).toISOString(), evidenceId: form.evidenceId || null, timeMs: form.evidenceId ? timeMs : null },
      { onSuccess: () => setForm({ title: '', description: '', occurredAt: '', evidenceId: '', timeS: '' }) },
    );
  };

  const laneClick = (e: MouseEvent<HTMLDivElement>, lane: NonNullable<typeof layout>['lanes'][number]) => {
    if (!layout) return;
    const r = e.currentTarget.getBoundingClientRect();
    const l = t.lanes.find((x) => x.itemId === lane.itemId)!;
    onOpen(lane.itemId, laneTimeAt(l.start, l.durationMs, layout, (e.clientX - r.left) / r.width));
  };
  const laneKey = (e: KeyboardEvent<HTMLDivElement>, itemId: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen(itemId, 0);
    }
  };
  const entryTarget = (e: TimelineEntry): { itemId: string; ms: number } | null => {
    if (e.kind === 'RECORDING') return { itemId: e.itemId, ms: 0 };
    if (e.kind === 'BOOKMARK') return itemByEvidence.has(e.evidenceId) ? { itemId: itemByEvidence.get(e.evidenceId)!.id, ms: e.timeMs } : null;
    if (e.kind === 'ANNOTATION') return itemByEvidence.has(e.evidenceId) ? { itemId: itemByEvidence.get(e.evidenceId)!.id, ms: e.startMs } : null;
    if (e.kind === 'EVENT' && e.evidenceId && itemByEvidence.has(e.evidenceId)) return { itemId: itemByEvidence.get(e.evidenceId)!.id, ms: e.timeMs ?? 0 };
    return null;
  };
  const labelOf = (evidenceId: string) => itemByEvidence.get(evidenceId)?.evidence.evidenceNumber ?? evidenceId.slice(0, 8);

  return (
    <div className="space-y-4">
      {!layout ? (
        <EmptyState icon={<Clock className="h-6 w-6" />} title="Nothing to place on the timeline yet" description="Add evidence with a recording time, or add manual events." />
      ) : (
        <Card title="Reconstruction" actions={<span className="text-xs text-ink-500">{formatDateTime(t.range!.start)} → {formatDateTime(t.range!.end)}</span>}>
          <div className="space-y-2" role="list" aria-label="Timeline lanes">
            {layout.lanes.map((lane) => (
              <div key={lane.itemId} className="grid grid-cols-[minmax(0,13rem)_1fr] items-center gap-2" role="listitem">
                <span className="mono truncate text-xs" title={lane.label}>{lane.label}</span>
                <div
                  className="relative h-7 cursor-pointer rounded bg-ink-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500"
                  onClick={(e) => laneClick(e, lane)}
                  onKeyDown={(e) => laneKey(e, lane.itemId)}
                  tabIndex={0}
                  role="button"
                  aria-label={`${lane.label}: click a position to open the video at that moment`}
                >
                  <div className="absolute inset-y-1 rounded bg-brand-300/70" style={{ left: `${lane.left}%`, width: `${lane.width}%` }} />
                  {lane.marks.map((m) => (
                    <span
                      key={`${m.entry.kind}-${'id' in m.entry ? m.entry.id : ''}`}
                      className={`absolute top-0 h-7 w-1 -translate-x-1/2 rounded ${m.entry.kind === 'BOOKMARK' ? 'bg-amber-500' : 'bg-ink-700'}`}
                      style={{ left: `${m.left}%` }}
                      title={m.entry.kind === 'BOOKMARK' ? m.entry.label : m.entry.kind === 'ANNOTATION' ? (m.entry.body ?? m.entry.annotationKind) : ''}
                    />
                  ))}
                </div>
              </div>
            ))}
            <div className="grid grid-cols-[minmax(0,13rem)_1fr] items-center gap-2">
              <span className="text-xs font-medium text-ink-600">Events</span>
              <div className="relative h-7 rounded bg-emerald-50">
                {layout.events.map((ev) => (
                  <span key={ev.entry.id} className="absolute top-1 h-5 w-2 -translate-x-1/2 rounded-full bg-emerald-600" style={{ left: `${ev.left}%` }} title={`${ev.entry.title} — ${formatDateTime(ev.entry.at)}`} />
                ))}
              </div>
            </div>
          </div>
          <p className="mt-2 text-xs text-ink-500">Blue bars: recordings (wall-clock). Amber: bookmarks. Dark: annotations. Green: manual events.</p>
        </Card>
      )}

      {t.overlaps.length > 0 && (
        <Card title={<span className="inline-flex items-center gap-1.5"><Layers className="h-4 w-4" aria-hidden />Same moment, different angle</span>}>
          <ul className="divide-y divide-ink-100">
            {t.overlaps.map((o) => {
              const ia = itemByEvidence.get(o.a);
              const ib = itemByEvidence.get(o.b);
              return (
                <li key={`${o.a}-${o.b}`} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                  <span className="mono text-xs">{labelOf(o.a)}</span> @ {formatTimecode(o.aTimeMs)}
                  <span aria-hidden>↔</span>
                  <span className="mono text-xs">{labelOf(o.b)}</span> @ {formatTimecode(o.bTimeMs)}
                  <span className="text-ink-500">overlap {formatDuration(o.durationMs)} from {formatDateTime(o.start)}</span>
                  {ia && ib && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        const la = t.lanes.find((l) => l.evidenceId === o.a);
                        const lb = t.lanes.find((l) => l.evidenceId === o.b);
                        onCompare([ia.id, ib.id], { [ia.id]: la?.suggestedOffsetMs ?? 0, [ib.id]: lb?.suggestedOffsetMs ?? 0 });
                      }}
                    >
                      Compare aligned
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <Card title="Chronology">
        {!t.entries.length ? <EmptyState title="No entries" /> : (
          <ol className="space-y-1">
            {t.entries.map((e) => {
              const target = entryTarget(e);
              const key = `${e.kind}-${'id' in e ? e.id : e.itemId}`;
              return (
                <li key={key} className="flex items-start gap-3 rounded px-2 py-1.5 hover:bg-ink-50">
                  <span className="mono w-48 shrink-0 text-xs text-ink-500">{formatDateTime(e.at)}</span>
                  <Badge tone={kindTone[e.kind]}>{e.kind.toLowerCase()}</Badge>
                  <div className="min-w-0 flex-1 text-sm">
                    {e.kind === 'RECORDING' && <>Recording <span className="mono text-xs">{e.label}</span> until {formatDateTime(e.end)}</>}
                    {e.kind === 'EVENT' && (
                      <>
                        <span className="font-medium">{e.title}</span>
                        {e.description && <span className="block text-ink-600">{e.description}</span>}
                        {e.restricted && <span className="block text-xs text-ink-500">Linked evidence is restricted for you.</span>}
                        <span className="block text-xs text-ink-500">by {e.createdBy}</span>
                      </>
                    )}
                    {e.kind === 'BOOKMARK' && <>{e.label} <span className="text-xs text-ink-500">({labelOf(e.evidenceId)} @ {formatTimecode(e.timeMs)}, {e.user})</span></>}
                    {e.kind === 'ANNOTATION' && <>{e.annotationKind.toLowerCase()}: {e.body ?? '—'} <span className="text-xs text-ink-500">({labelOf(e.evidenceId)} @ {formatTimecode(e.startMs)}, {e.author})</span></>}
                  </div>
                  {target && <Button size="sm" variant="ghost" onClick={() => onOpen(target.itemId, target.ms)}>Open</Button>}
                  {e.kind === 'EVENT' && editable && <Button size="sm" variant="ghost" icon={<Trash2 className="h-4 w-4" />} aria-label={`Delete event ${e.title}`} onClick={() => delEvent.mutate(e.id)} />}
                </li>
              );
            })}
          </ol>
        )}
        {t.unplacedItems.length > 0 && <p className="mt-2 text-xs text-ink-500">{t.unplacedItems.length} item(s) have no recording time and cannot be placed.</p>}
        {delEvent.error && <Alert tone="red">{errorMessage(delEvent.error)}</Alert>}
      </Card>

      {editable && (
        <Card title="Add timeline event">
          <form onSubmit={submit} className="grid gap-3 md:grid-cols-2">
            <Field label="Title" htmlFor="te-title" required>
              <Input id="te-title" value={form.title} maxLength={200} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </Field>
            <Field label="Occurred at" htmlFor="te-at" required>
              <div className="flex gap-2">
                <Input id="te-at" type="datetime-local" step={1} value={form.occurredAt} onChange={(e) => setForm({ ...form, occurredAt: e.target.value })} />
                <Button variant="secondary" size="sm" onClick={() => setForm({ ...form, occurredAt: toLocalInput(new Date(t.range?.start ?? Date.now())) })}>Start</Button>
              </div>
            </Field>
            <Field label="Linked evidence (optional)" htmlFor="te-ev">
              <Select id="te-ev" value={form.evidenceId} onChange={(e) => setForm({ ...form, evidenceId: e.target.value })}>
                <option value="">None</option>
                {items.map((i) => <option key={i.id} value={i.evidenceId}>{i.evidence.evidenceNumber ?? i.evidenceId}</option>)}
              </Select>
            </Field>
            <Field label="Video time (s, optional)" htmlFor="te-time">
              <Input id="te-time" inputMode="decimal" value={form.timeS} disabled={!form.evidenceId} onChange={(e) => setForm({ ...form, timeS: e.target.value })} />
            </Field>
            <div className="md:col-span-2">
              <Field label="Description" htmlFor="te-desc">
                <Textarea id="te-desc" rows={2} value={form.description} maxLength={5000} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              </Field>
            </div>
            {(formError || addEvent.error) && <div className="md:col-span-2"><Alert tone="red">{formError ?? errorMessage(addEvent.error)}</Alert></div>}
            <div className="flex justify-end md:col-span-2">
              <Button type="submit" icon={<Plus className="h-4 w-4" />} loading={addEvent.isPending}>Add event</Button>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}
