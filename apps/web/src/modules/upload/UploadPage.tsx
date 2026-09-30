import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent } from 'react';
import { Link } from 'react-router';
import { FolderUp, Pause, Play, Trash2, UploadCloud, X } from 'lucide-react';
import type { DeclaredUploadMetadata } from '@ksp/shared';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatBytes } from '@/lib/format';
import { OrgUnitSelect, useOrgUnits } from '@/components/pickers';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Modal, PageHeader, ProgressBar, Textarea, clsx, useToast, type Tone } from '@/components/ui';
import { UploadEngine, filesFromDrop, forgetUpload, rememberedUploads, type ItemState, type UploadItem } from './engine';

const STATE_LABEL: Record<ItemState, { label: string; tone: Tone }> = {
  ready: { label: 'Ready', tone: 'gray' },
  hashing: { label: 'Preparing', tone: 'blue' },
  uploading: { label: 'Uploading', tone: 'blue' },
  paused: { label: 'Paused', tone: 'amber' },
  completing: { label: 'Finishing upload', tone: 'blue' },
  processing: { label: 'Validating', tone: 'blue' },
  registered: { label: 'Registered', tone: 'green' },
  quarantined: { label: 'Quarantined', tone: 'red' },
  rejected: { label: 'Rejected', tone: 'red' },
  failed: { label: 'Failed', tone: 'red' },
  cancelled: { label: 'Cancelled', tone: 'gray' },
};

function useEngine(engine: UploadEngine): UploadItem[] {
  return useSyncExternalStore((cb) => engine.subscribe(cb), () => engine.items);
}

function MetadataFields({ value, onChange, idPrefix, showTitle = true }: { value: DeclaredUploadMetadata; onChange: (m: DeclaredUploadMetadata) => void; idPrefix: string; showTitle?: boolean }) {
  const set = (k: keyof DeclaredUploadMetadata) => (e: { target: { value: string } }) => onChange({ ...value, [k]: e.target.value || undefined });
  const v = (k: keyof DeclaredUploadMetadata) => (value[k] ?? '') as string;
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {showTitle && (
        <Field label="Title" htmlFor={`${idPrefix}-title`}>
          <Input id={`${idPrefix}-title`} value={v('title')} onChange={set('title')} maxLength={300} />
        </Field>
      )}
      <Field label="Category" htmlFor={`${idPrefix}-category`} hint="e.g. PATROL, TRAFFIC, RAID">
        <Input id={`${idPrefix}-category`} value={v('category')} onChange={set('category')} maxLength={100} />
      </Field>
      <Field label="Recording officer badge" htmlFor={`${idPrefix}-badge`}>
        <Input id={`${idPrefix}-badge`} value={v('officerBadge')} onChange={set('officerBadge')} maxLength={64} />
      </Field>
      <Field label="Camera serial" htmlFor={`${idPrefix}-device`} hint="Officer defaults to the camera's assignee">
        <Input id={`${idPrefix}-device`} value={v('deviceSerial')} onChange={set('deviceSerial')} maxLength={128} />
      </Field>
      <Field label="Recorded at" htmlFor={`${idPrefix}-rec`} hint="Leave empty to use the file's timestamp">
        <Input id={`${idPrefix}-rec`} type="datetime-local" value={v('recordedAt')} onChange={set('recordedAt')} />
      </Field>
      <Field label="Incident at" htmlFor={`${idPrefix}-inc`}>
        <Input id={`${idPrefix}-inc`} type="datetime-local" value={v('incidentAt')} onChange={set('incidentAt')} />
      </Field>
      <Field label="Location" htmlFor={`${idPrefix}-loc`}>
        <Input id={`${idPrefix}-loc`} value={v('locationText')} onChange={set('locationText')} maxLength={500} />
      </Field>
      <Field label="Latitude" htmlFor={`${idPrefix}-lat`}>
        <Input id={`${idPrefix}-lat`} inputMode="decimal" value={String(value.latitude ?? '')} onChange={set('latitude')} />
      </Field>
      <Field label="Longitude" htmlFor={`${idPrefix}-lon`}>
        <Input id={`${idPrefix}-lon`} inputMode="decimal" value={String(value.longitude ?? '')} onChange={set('longitude')} />
      </Field>
      <div className="sm:col-span-2 lg:col-span-3">
        <Field label="Description / notes" htmlFor={`${idPrefix}-notes`}>
          <Textarea id={`${idPrefix}-notes`} rows={2} value={v('description')} onChange={set('description')} maxLength={5000} />
        </Field>
      </div>
    </div>
  );
}

function speed(bps: number) {
  return bps > 0 ? `${formatBytes(bps)}/s` : '';
}

export function UploadPage() {
  const { me } = useAuth();
  const toast = useToast();
  const engine = useMemo(() => new UploadEngine(), []);
  useEffect(() => () => engine.dispose(), [engine]);
  const items = useEngine(engine);
  const orgUnits = useOrgUnits();
  const [station, setStation] = useState('');
  const [label, setLabel] = useState('');
  const [defaults, setDefaults] = useState<DeclaredUploadMetadata>({});
  const [editing, setEditing] = useState<UploadItem | null>(null);
  const [editMeta, setEditMeta] = useState<DeclaredUploadMetadata>({});
  const [dragOver, setDragOver] = useState(false);
  const [starting, setStarting] = useState(false);
  const [started, setStarted] = useState(false);
  const [rejected, setRejected] = useState<string[]>([]);
  const [remembered, setRemembered] = useState(() => rememberedUploads());
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  // Default the station to the user's home unit when it is a station.
  useEffect(() => {
    if (station || !me || !orgUnits.data) return;
    const home = orgUnits.data.items.find((u) => u.id === me.user.homeOrgUnit.id && u.unitType === 'STATION');
    if (home) setStation(home.id);
  }, [me, orgUnits.data, station]);

  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (engine.items.some((i) => ['uploading', 'completing', 'hashing'].includes(i.state))) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [engine]);

  const add = (list: Array<{ file: File; relativePath: string }>) => {
    const bad = engine.add(list, defaults);
    setRejected(bad);
    setRemembered(rememberedUploads());
    if (started && station) engine.start(station, engine.batchId);
  };

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    add(await filesFromDrop(e.dataTransfer));
  };

  const start = async () => {
    if (!station) return;
    setStarting(true);
    try {
      const batch = await api.post<{ id: string }>('/uploads/batches', { orgUnitId: station, label: label || undefined, clientInfo: { client: 'web', agent: navigator.userAgent.slice(0, 200) } });
      engine.start(station, batch.id);
      setStarted(true);
    } catch (e) {
      toast.error(e);
    } finally {
      setStarting(false);
    }
  };

  const totals = useMemo(() => {
    const t = { bytes: 0, done: 0, speed: 0, active: 0 };
    for (const i of items) {
      if (i.state === 'cancelled') continue;
      t.bytes += i.file.size;
      t.done += i.bytesDone;
      t.speed += i.speedBps;
      if (['uploading', 'completing', 'hashing'].includes(i.state)) t.active++;
    }
    return t;
  }, [items]);
  const count = (s: ItemState) => items.filter((i) => i.state === s).length;
  const readyCount = count('ready');
  const pendingRemembered = remembered.filter((r) => !items.some((i) => i.key === r.key));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Upload evidence"
        subtitle="Resumable, chunked upload of body-worn and dash camera footage. Each chunk is SHA-256 verified; files are validated, hashed and registered automatically."
        actions={<Link to="/uploads" className="text-sm font-medium text-brand-700 hover:underline">Upload history</Link>}
      />

      {pendingRemembered.length > 0 && (
        <Alert tone="amber" title={`${pendingRemembered.length} unfinished upload(s) from an earlier session`}>
          <p>Add the same files again to resume where they stopped:</p>
          <ul className="mt-1 list-inside list-disc">
            {pendingRemembered.slice(0, 8).map((r) => (
              <li key={r.key}>
                {r.name} ({formatBytes(r.size)}){' '}
                <button type="button" className="text-xs text-brand-700 underline" onClick={() => { forgetUpload(r.key); setRemembered(rememberedUploads()); }}>
                  forget
                </button>
              </li>
            ))}
          </ul>
        </Alert>
      )}

      <Card title="1. Destination">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Police station" htmlFor="up-station" required>
            <OrgUnitSelect id="up-station" scope="evidence:upload" value={station} onChange={setStation} stationsOnly allowEmpty emptyLabel="Select station…" required disabled={started} />
          </Field>
          <Field label="Batch label" htmlFor="up-label" hint="Optional, e.g. shift or docking-station name">
            <Input id="up-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={200} disabled={started} />
          </Field>
        </div>
      </Card>

      <Card title="2. Default details" actions={<Button size="sm" variant="secondary" onClick={() => { engine.applyToAll(defaults); toast.success('Applied to all files not yet started'); }} disabled={!readyCount}>Apply to all</Button>}>
        <p className="mb-3 text-sm text-ink-600">Applied to files as they are added. Use “Apply to all” to update files already in the queue; edit a single file with “Details”.</p>
        <MetadataFields value={defaults} onChange={setDefaults} idPrefix="def" showTitle={false} />
      </Card>

      <Card title="3. Files">
        <div
          role="region"
          aria-label="Drop files or folders here"
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => void onDrop(e)}
          className={clsx('flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-8 text-center', dragOver ? 'border-brand-500 bg-brand-50' : 'border-ink-300')}
        >
          <UploadCloud className="h-10 w-10 text-ink-400" aria-hidden />
          <p className="text-sm text-ink-700">Drag and drop video files or whole folders here</p>
          <div className="flex gap-2">
            <Button variant="secondary" icon={<UploadCloud className="h-4 w-4" />} onClick={() => fileInput.current?.click()}>Choose files</Button>
            <Button variant="secondary" icon={<FolderUp className="h-4 w-4" />} onClick={() => folderInput.current?.click()}>Choose folder</Button>
          </div>
          <input ref={fileInput} type="file" multiple className="sr-only" aria-label="Choose files" accept="video/*,.mp4,.mov,.m4v,.mkv,.webm,.avi,.ts,.mts,.m2ts,.3gp,.wmv,.asf,.flv,.mpg,.mpeg"
            onChange={(e) => { add(Array.from(e.target.files ?? []).map((f) => ({ file: f, relativePath: f.name }))); e.target.value = ''; }} />
          <input ref={folderInput} type="file" multiple className="sr-only" aria-label="Choose folder" {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
            onChange={(e) => { add(Array.from(e.target.files ?? []).map((f) => ({ file: f, relativePath: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name }))); e.target.value = ''; }} />
        </div>
        {rejected.length > 0 && (
          <div className="mt-3">
            <Alert tone="amber" title={`${rejected.length} file(s) skipped — not an accepted video type`}>
              {rejected.slice(0, 10).join(', ')}{rejected.length > 10 ? '…' : ''}
            </Alert>
          </div>
        )}

        {items.length === 0 ? (
          <div className="mt-4"><EmptyState title="No files added yet" description="Accepted: MP4, MOV, M4V, MKV, WEBM, AVI, TS/MTS/M2TS, 3GP, WMV/ASF, FLV, MPG." /></div>
        ) : (
          <>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-md bg-ink-50 px-3 py-2 text-sm">
              <span>
                {items.length} file(s) · {formatBytes(totals.done)} of {formatBytes(totals.bytes)}
                {totals.speed > 0 && <> · {speed(totals.speed)}</>} · {count('registered')} registered · {count('quarantined')} quarantined · {count('failed')} failed
              </span>
              <span className="flex gap-2">
                {started && <Button size="sm" variant="secondary" icon={<Pause className="h-3.5 w-3.5" />} onClick={() => engine.pauseAll()} disabled={!totals.active && !readyCount}>Pause all</Button>}
                {started && <Button size="sm" variant="secondary" icon={<Play className="h-3.5 w-3.5" />} onClick={() => engine.resumeAll()} disabled={!count('paused')}>Resume all</Button>}
                {!started && <Button onClick={() => void start()} loading={starting} disabled={!station || !readyCount} icon={<UploadCloud className="h-4 w-4" />}>Start upload ({readyCount})</Button>}
              </span>
            </div>
            {!station && !started && <p className="mt-2 text-sm text-amber-700">Select the police station before starting.</p>}
            <ul className="mt-3 divide-y divide-ink-100" aria-label="Upload queue">
              {items.map((i) => {
                const st = STATE_LABEL[i.state];
                const pct = i.file.size ? i.bytesDone / i.file.size : 0;
                return (
                  <li key={i.key} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-medium text-ink-900" title={i.relativePath}>{i.relativePath}</span>
                        <Badge tone={st.tone}>{st.label}</Badge>
                        {i.resumed && <Badge tone="purple">Resumed</Badge>}
                        {i.metadata.title && <span className="text-xs text-ink-500">“{i.metadata.title}”</span>}
                      </div>
                      <div className="mt-1 flex items-center gap-3">
                        <div className="w-full max-w-md"><ProgressBar value={pct} label={`Upload progress for ${i.file.name}`} /></div>
                        <span className="whitespace-nowrap text-xs text-ink-600">
                          {formatBytes(i.bytesDone)} / {formatBytes(i.file.size)}
                          {i.totalChunks ? ` · ${i.doneParts}/${i.totalChunks} chunks` : ''} {speed(i.speedBps)}
                          {i.attempts > 0 && i.state === 'uploading' ? ` · ${i.attempts} retries` : ''}
                        </span>
                      </div>
                      {i.state === 'registered' && i.evidenceId && (
                        <p className="mt-1 text-sm text-emerald-800">Registered as <Link className="font-mono font-medium underline" to={`/evidence/${i.evidenceId}`}>{i.evidenceNumber ?? i.evidenceId}</Link></p>
                      )}
                      {i.state === 'quarantined' && <p className="mt-1 text-sm text-red-800">Quarantined — {i.reasonCode ?? 'review'}: {i.reasonMessage}</p>}
                      {i.state === 'failed' && <p className="mt-1 text-sm text-red-800">{i.error}</p>}
                    </div>
                    <div className="flex shrink-0 gap-1.5">
                      {i.state === 'ready' && !started && (
                        <Button size="sm" variant="secondary" onClick={() => { setEditing(i); setEditMeta(i.metadata); }}>Details</Button>
                      )}
                      {['uploading', 'hashing'].includes(i.state) && <Button size="sm" variant="secondary" icon={<Pause className="h-3.5 w-3.5" />} onClick={() => engine.pause(i.key)} aria-label={`Pause ${i.file.name}`}>Pause</Button>}
                      {(i.state === 'paused' || i.state === 'failed') && started && <Button size="sm" variant="secondary" icon={<Play className="h-3.5 w-3.5" />} onClick={() => engine.resume(i.key)} aria-label={`Resume ${i.file.name}`}>{i.state === 'failed' ? 'Retry' : 'Resume'}</Button>}
                      {['ready', 'uploading', 'paused', 'failed', 'hashing'].includes(i.state) && started && (
                        <Button size="sm" variant="ghost" icon={<X className="h-3.5 w-3.5" />} onClick={() => void engine.cancel(i.key)} aria-label={`Cancel ${i.file.name}`}>Cancel</Button>
                      )}
                      {!started && i.state === 'ready' && <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => engine.remove(i.key)} aria-label={`Remove ${i.file.name}`}>Remove</Button>}
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </Card>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={`Details — ${editing?.file.name ?? ''}`}
        size="xl"
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
            <Button onClick={() => { if (editing) engine.setMetadata(editing.key, editMeta); setEditing(null); }}>Save</Button>
          </>
        }
      >
        <MetadataFields value={editMeta} onChange={setEditMeta} idPrefix="item" />
      </Modal>
      {orgUnits.error && <Alert tone="red" title="Could not load stations">{errorMessage(orgUnits.error)}</Alert>}
    </div>
  );
}
