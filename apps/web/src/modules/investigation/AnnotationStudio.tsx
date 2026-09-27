/**
 * Single-video review: EvidencePlayer with bookmarks as markers and REGION annotations drawn as overlays
 * (percentage coordinates inside the frame box, so they follow zoom/pan). Create bookmarks/annotations at the
 * current time; drag a region box on the paused frame; click any list entry to seek.
 * Keyboard alternative for regions (WCAG 2.1.1): the frame is focusable while a region draft is open — arrow keys
 * move the box, Shift+arrow keys resize it, Enter sets it, Escape stops drawing — and X/Y/W/H inputs (percent of
 * the frame) edit it numerically. Changes are announced in a polite live region.
 */
import { useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent, type PointerEvent as RPointerEvent } from 'react';
import { BookmarkPlus, Pencil, Square, StickyNote, Trash2, X } from 'lucide-react';
import { EvidencePlayer, type EvidencePlayerHandle, type PlayerMarker } from '@/modules/video';
import { api, errorMessage } from '@/lib/api';
import { formatTimecode } from '@/lib/format';
import { Alert, Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, Field, Input, Select, Spinner, Textarea, useToast } from '@/components/ui';
import { useAnnotations, useBookmarks, useWsMutation, type AnnotationRow, type Region } from './api';
import { activeAt, clampRegion, DEFAULT_REGION, describeRegion, nudgeRegion, regionFromDrag } from './geometry';

const COLORS = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#a855f7'];

/** Black or white text, whichever contrasts more with the (user-chosen) label background. */
function labelText(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#fff';
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1]!.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const L = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  return (L + 0.05) / 0.05 > 1.05 / (L + 0.05) ? '#000' : '#fff';
}

interface Props {
  evidenceId: string;
  workspaceId?: string;
  editable: boolean;
  initialTimeMs?: number;
}

type Draft = { kind: 'NOTE' | 'HIGHLIGHT' | 'REGION'; startMs: number; endMs: string; body: string; color: string; region: Region | null; editingId?: string };

export function AnnotationStudio({ evidenceId, workspaceId, editable, initialTimeMs }: Props) {
  const player = useRef<EvidencePlayerHandle>(null);
  const [now, setNow] = useState(initialTimeMs ?? 0);
  const bookmarks = useBookmarks(evidenceId, workspaceId);
  const annotations = useAnnotations(evidenceId, workspaceId);
  const toast = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [drag, setDrag] = useState<{ a: { x: number; y: number }; b: { x: number; y: number } } | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [bmLabel, setBmLabel] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<AnnotationRow | null>(null);
  const [announce, setAnnounce] = useState('');

  const addBookmark = useWsMutation((v: { label: string; timeMs: number }) => api.post('/workspaces/bookmarks', { evidenceId, workspaceId, ...v }));
  const delBookmark = useWsMutation((id: string) => api.delete(`/workspaces/bookmarks/${id}`));
  const saveAnn = useWsMutation((d: Draft) => {
    const body = {
      startMs: d.startMs,
      endMs: d.endMs.trim() === '' ? null : Math.round(Number(d.endMs) * 1000),
      body: d.body.trim() || null,
      color: d.color,
      ...(d.kind === 'REGION' ? { region: d.region } : {}),
    };
    return d.editingId ? api.patch(`/workspaces/annotations/${d.editingId}`, body) : api.post('/workspaces/annotations', { evidenceId, workspaceId, kind: d.kind, ...body });
  });
  const delAnn = useWsMutation((id: string) => api.delete(`/workspaces/annotations/${id}`));

  const markers = useMemo<PlayerMarker[]>(
    () => [
      ...(bookmarks.data?.items ?? []).map((b) => ({ timeMs: b.timeMs, label: b.label, color: '#f59e0b' })),
      ...(annotations.data?.items ?? []).map((a) => ({ timeMs: a.startMs, label: `${a.kind.toLowerCase()}: ${a.body ?? ''}`.trim(), color: a.color ?? '#3b82f6' })),
    ],
    [bookmarks.data, annotations.data],
  );
  const visibleRegions = (annotations.data?.items ?? []).filter((a) => a.kind === 'REGION' && a.region && activeAt(a, now) && a.id !== draft?.editingId);

  const seek = (ms: number) => {
    player.current?.pause();
    player.current?.seek(ms);
    setNow(ms);
  };
  const startDraft = (kind: Draft['kind']) => {
    player.current?.pause();
    const t = Math.round(player.current?.getTime() ?? now);
    setDraft({ kind, startMs: t, endMs: kind === 'NOTE' ? '' : ((t + 3000) / 1000).toFixed(3), body: '', color: COLORS[0]!, region: null });
    setDrawing(kind === 'REGION');
  };
  const editDraft = (a: AnnotationRow) => {
    seek(a.startMs);
    setDraft({ kind: a.kind, startMs: a.startMs, endMs: a.endMs === null ? '' : (a.endMs / 1000).toFixed(3), body: a.body ?? '', color: a.color ?? COLORS[0]!, region: a.region, editingId: a.id });
    setDrawing(false);
  };

  const pointer = (e: RPointerEvent<HTMLDivElement>) => ({ x: e.clientX, y: e.clientY });
  const onDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (!drawing) return;
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ a: pointer(e), b: pointer(e) });
  };
  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (!drawing || !drag) return;
    e.stopPropagation();
    setDrag({ ...drag, b: pointer(e) });
  };
  const onUp = (e: RPointerEvent<HTMLDivElement>) => {
    if (!drawing || !drag || !overlayRef.current) return;
    e.stopPropagation();
    const r = overlayRef.current.getBoundingClientRect();
    const region = regionFromDrag({ left: r.left, top: r.top, width: r.width, height: r.height }, drag.a, pointer(e));
    setDrag(null);
    if (region) {
      setDraft((d) => (d ? { ...d, region } : d));
      setDrawing(false);
    }
  };
  const liveRegion = (() => {
    if (drag && overlayRef.current) {
      const r = overlayRef.current.getBoundingClientRect();
      return regionFromDrag({ left: r.left, top: r.top, width: r.width, height: r.height }, drag.a, drag.b, 0);
    }
    return draft?.kind === 'REGION' ? draft.region : null;
  })();

  const regionDraft = draft?.kind === 'REGION';
  const setRegion = (region: Region, message: string) => {
    setDraft((d) => (d ? { ...d, region } : d));
    setAnnounce(`${message}: ${describeRegion(region)}`);
  };
  /** Keyboard editing on the focused frame. Handled keys stop here so the player's shortcuts do not fire. */
  const onRegionKey = (e: RKeyboardEvent<HTMLDivElement>) => {
    if (!draft || draft.kind !== 'REGION' || e.ctrlKey || e.metaKey || e.altKey) return;
    const cur = draft.region;
    if (e.key === 'Enter' || e.key === ' ') {
      const reg = cur ?? DEFAULT_REGION;
      setRegion(reg, 'Region set');
      setDrawing(false);
      document.getElementById('an-body')?.focus();
    } else if (e.key === 'Escape') {
      setDrawing(false);
      setAnnounce(cur ? `Region kept: ${describeRegion(cur)}` : 'No region set');
    } else {
      const next = cur ? nudgeRegion(cur, e.key, e.shiftKey) : e.key.startsWith('Arrow') ? DEFAULT_REGION : null;
      if (!next) return;
      player.current?.pause();
      setRegion(next, cur ? (e.shiftKey ? 'Resized' : 'Moved') : 'Region created');
    }
    e.preventDefault();
    e.stopPropagation();
  };
  const onRegionInput = (k: keyof Region, raw: string) => {
    const v = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(v)) return;
    const next = clampRegion({ ...(draft?.region ?? DEFAULT_REGION), [k]: v / 100 });
    setDraft((d) => (d ? { ...d, region: next } : d));
  };

  const box = (reg: Region, color: string, label?: string, dashed?: boolean) => (
    <div
      className="pointer-events-none absolute border-2"
      style={{ left: `${reg.x * 100}%`, top: `${reg.y * 100}%`, width: `${reg.w * 100}%`, height: `${reg.h * 100}%`, borderColor: color, borderStyle: dashed ? 'dashed' : 'solid' }}
    >
      {label && <span className="absolute -top-5 left-0 max-w-[16rem] truncate rounded px-1 text-[11px]" style={{ background: color, color: labelText(color) }}>{label}</span>}
    </div>
  );

  const overlays = (
    <div
      ref={overlayRef}
      className={`absolute inset-0 outline-none focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-400 ${drawing ? 'pointer-events-auto cursor-crosshair' : 'pointer-events-none'}`}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onKeyDown={regionDraft ? onRegionKey : undefined}
      tabIndex={regionDraft ? 0 : undefined}
      role={regionDraft ? 'application' : undefined}
      aria-roledescription={regionDraft ? 'region editor' : undefined}
      aria-label={regionDraft ? 'Region editor: drag to draw a region on the frame, or use arrow keys to move and Shift+arrow keys to resize; Enter sets the region, Escape stops drawing' : undefined}
      aria-keyshortcuts={regionDraft ? 'ArrowLeft ArrowRight ArrowUp ArrowDown Shift+ArrowLeft Shift+ArrowRight Shift+ArrowUp Shift+ArrowDown Enter Escape' : undefined}
    >
      {visibleRegions.map((a) => <div key={a.id}>{box(a.region!, a.color ?? '#ef4444', a.body ?? 'Region')}</div>)}
      {liveRegion && box(liveRegion, draft?.color ?? '#ef4444', 'New region', true)}
    </div>
  );

  const submitDraft = () => {
    if (!draft) return;
    if (draft.kind === 'REGION' && !draft.region) return toast.error('Draw the region on the paused frame first');
    if (draft.kind === 'NOTE' && !draft.body.trim()) return toast.error('A note needs text');
    saveAnn.mutate(draft, { onSuccess: () => { setDraft(null); setDrawing(false); toast.success(draft.editingId ? 'Annotation updated' : 'Annotation saved'); } });
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_22rem]">
      <div className="space-y-3">
        <EvidencePlayer ref={player} evidenceId={evidenceId} markers={markers} overlays={overlays} onTimeUpdate={setNow} initialTimeMs={initialTimeMs} />
        {editable && (
          <div className="flex flex-wrap items-end gap-2">
            <Field label={`Bookmark at ${formatTimecode(now)}`} htmlFor="bm-label">
              <Input id="bm-label" value={bmLabel} onChange={(e) => setBmLabel(e.target.value)} placeholder="e.g. Suspect enters frame" maxLength={200} />
            </Field>
            <Button
              icon={<BookmarkPlus className="h-4 w-4" />}
              disabled={!bmLabel.trim()}
              loading={addBookmark.isPending}
              onClick={() => addBookmark.mutate({ label: bmLabel.trim(), timeMs: Math.round(player.current?.getTime() ?? now) }, { onSuccess: () => { setBmLabel(''); toast.success('Bookmark added'); } })}
            >
              Add bookmark
            </Button>
            <span className="mx-1 h-8 w-px bg-ink-200" aria-hidden />
            <Button variant="secondary" icon={<StickyNote className="h-4 w-4" />} onClick={() => startDraft('NOTE')}>Note</Button>
            <Button variant="secondary" icon={<Pencil className="h-4 w-4" />} onClick={() => startDraft('HIGHLIGHT')}>Highlight</Button>
            <Button variant="secondary" icon={<Square className="h-4 w-4" />} onClick={() => startDraft('REGION')}>Region</Button>
          </div>
        )}
        {addBookmark.error && <Alert tone="red">{errorMessage(addBookmark.error)}</Alert>}
        {draft && (
          <Card title={`${draft.editingId ? 'Edit' : 'New'} ${draft.kind.toLowerCase()} at ${formatTimecode(draft.startMs)}`} actions={<Button variant="ghost" size="sm" icon={<X className="h-4 w-4" />} aria-label="Cancel annotation" onClick={() => { setDraft(null); setDrawing(false); }} />}>
            <div className="grid gap-3 md:grid-cols-3">
              <Field label="Start (s)" htmlFor="an-start">
                <Input id="an-start" inputMode="decimal" value={(draft.startMs / 1000).toFixed(3)} onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v >= 0) setDraft({ ...draft, startMs: Math.round(v * 1000) }); }} />
              </Field>
              <Field label="End (s, optional)" htmlFor="an-end">
                <Input id="an-end" inputMode="decimal" value={draft.endMs} onChange={(e) => setDraft({ ...draft, endMs: e.target.value })} />
              </Field>
              <Field label="Colour" htmlFor="an-color">
                <Select id="an-color" value={draft.color} onChange={(e) => setDraft({ ...draft, color: e.target.value })}>
                  {COLORS.map((c) => <option key={c} value={c}>{c}</option>)}
                </Select>
              </Field>
              <div className="md:col-span-3">
                <Field label={draft.kind === 'NOTE' ? 'Note' : 'Description (optional)'} htmlFor="an-body" required={draft.kind === 'NOTE'}>
                  <Textarea id="an-body" rows={2} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} maxLength={5000} />
                </Field>
              </div>
            </div>
            {draft.kind === 'REGION' && (
              <>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                  {draft.region ? <Badge tone="green">Region set ({Math.round(draft.region.w * 100)}% × {Math.round(draft.region.h * 100)}%)</Badge> : <Badge tone="amber">No region yet</Badge>}
                  <Button size="sm" variant="secondary" onClick={() => { player.current?.pause(); setDrawing(true); }} aria-pressed={drawing}>
                    {drawing ? 'Drag on the frame…' : draft.region ? 'Redraw region' : 'Draw region'}
                  </Button>
                  <span className="text-xs text-ink-500">Keyboard: focus the frame, arrows move, Shift+arrows resize, Enter sets — or type the values below.</span>
                </div>
                <fieldset className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-4">
                  <legend className="sr-only">Region position and size (percent of the frame)</legend>
                  {(['x', 'y', 'w', 'h'] as const).map((k) => (
                    <Field key={k} label={{ x: 'Region left (%)', y: 'Region top (%)', w: 'Region width (%)', h: 'Region height (%)' }[k]} htmlFor={`an-region-${k}`}>
                      <Input
                        id={`an-region-${k}`}
                        type="number"
                        min={k === 'w' || k === 'h' ? 1 : 0}
                        max={100}
                        step={0.1}
                        value={draft.region ? String(Math.round(draft.region[k] * 1000) / 10) : ''}
                        placeholder={String(DEFAULT_REGION[k] * 100)}
                        onChange={(e) => onRegionInput(k, e.target.value)}
                      />
                    </Field>
                  ))}
                </fieldset>
              </>
            )}
            {saveAnn.error && <div className="mt-2"><Alert tone="red">{errorMessage(saveAnn.error)}</Alert></div>}
            <div className="mt-3 flex justify-end">
              <Button loading={saveAnn.isPending} onClick={submitDraft}>{draft.editingId ? 'Save changes' : 'Save annotation'}</Button>
            </div>
          </Card>
        )}
      </div>
      <div className="space-y-3">
        <Card title="Bookmarks" bodyClassName="p-2">
          {bookmarks.isLoading ? <Spinner /> : bookmarks.error ? <ErrorState error={bookmarks.error} onRetry={() => void bookmarks.refetch()} /> : !bookmarks.data?.items.length ? (
            <EmptyState title="No bookmarks" />
          ) : (
            <ul className="divide-y divide-ink-100">
              {bookmarks.data.items.map((b) => (
                <li key={b.id} className="flex items-center gap-2 py-1.5">
                  <button type="button" className="mono text-xs text-brand-700 hover:underline" onClick={() => seek(b.timeMs)}>{formatTimecode(b.timeMs)}</button>
                  <span className="flex-1 truncate text-sm">{b.label}<span className="block text-xs text-ink-500">{b.user.fullName}{b.workspaceId ? '' : ' · personal'}</span></span>
                  {b.canDelete && editable && <Button size="sm" variant="ghost" icon={<Trash2 className="h-4 w-4" />} aria-label={`Delete bookmark ${b.label}`} onClick={() => delBookmark.mutate(b.id)} />}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Annotations" bodyClassName="p-2">
          {annotations.isLoading ? <Spinner /> : annotations.error ? <ErrorState error={annotations.error} onRetry={() => void annotations.refetch()} /> : !annotations.data?.items.length ? (
            <EmptyState title="No annotations" />
          ) : (
            <ul className="divide-y divide-ink-100">
              {annotations.data.items.map((a) => (
                <li key={a.id} className="py-1.5">
                  <div className="flex items-center gap-2">
                    <span className="h-3 w-3 shrink-0 rounded-sm" style={{ background: a.color ?? '#3b82f6' }} aria-hidden />
                    <button type="button" className="mono text-xs text-brand-700 hover:underline" onClick={() => seek(a.startMs)}>
                      {formatTimecode(a.startMs)}{a.endMs !== null ? `–${formatTimecode(a.endMs)}` : ''}
                    </button>
                    <Badge>{a.kind.toLowerCase()}</Badge>
                    <span className="flex-1" />
                    {a.canEdit && editable && (
                      <>
                        <Button size="sm" variant="ghost" icon={<Pencil className="h-4 w-4" />} aria-label="Edit annotation" onClick={() => editDraft(a)} />
                        <Button size="sm" variant="ghost" icon={<Trash2 className="h-4 w-4" />} aria-label="Delete annotation" onClick={() => setConfirmDelete(a)} />
                      </>
                    )}
                  </div>
                  {a.body && <p className="mt-0.5 text-sm text-ink-700">{a.body}</p>}
                  <p className="text-xs text-ink-500">{a.author.fullName}{a.workspaceId ? '' : ' · shared on evidence'}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announce}</div>
      <ConfirmDialog
        open={!!confirmDelete}
        title="Delete annotation"
        message="The annotation is hidden from views but kept (with your name and the time) in the evidence audit trail."
        confirmLabel="Delete"
        variant="danger"
        loading={delAnn.isPending}
        error={delAnn.error}
        onConfirm={() => confirmDelete && delAnn.mutate(confirmDelete.id, { onSuccess: () => setConfirmDelete(null) })}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}
