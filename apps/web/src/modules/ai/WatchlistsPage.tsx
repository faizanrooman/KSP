/** Watchlists (ai:watchlist_manage): FACE lists with reference images (embedded by the AI worker), VEHICLE plate lists. */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useUrlState } from '@/lib/hooks';
import { formatDateTime } from '@/lib/format';
import { Alert, Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, Field, Input, Modal, PageHeader, Select, Spinner, Textarea, useToast } from '@/components/ui';
import { aiKeys, useWatchlist, useWatchlists, type WatchlistEntry } from './api';

const MAX_IMAGE = 2 * 1024 * 1024;

export function WatchlistsPage() {
  const q = useWatchlists();
  const [url, setUrl] = useUrlState({ list: '' });
  const [creating, setCreating] = useState(false);
  return (
    <div className="space-y-4">
      <PageHeader title="Watchlists" subtitle="Lists apply to evidence within their org unit's jurisdiction. Matches are suggestions that require dual human approval." actions={<Button icon={<Plus className="h-4 w-4" aria-hidden />} onClick={() => setCreating(true)}>New watchlist</Button>} />
      <div className="grid gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
        <Card title="Lists">
          {q.isLoading ? <Spinner /> : q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : !q.data!.items.length ? <EmptyState title="No watchlists" /> : (
            <ul className="space-y-1">
              {q.data!.items.map((w) => (
                <li key={w.id}>
                  <button type="button" onClick={() => setUrl({ list: w.id })} className={`w-full rounded px-2 py-1.5 text-left text-sm hover:bg-ink-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 ${url.list === w.id ? 'bg-brand-50 font-medium' : ''}`} aria-current={url.list === w.id || undefined}>
                    <div className="flex items-center justify-between gap-2"><span className="truncate">{w.name}</span><Badge tone={w.kind === 'FACE' ? 'purple' : 'amber'}>{w.kind === 'FACE' ? 'Faces' : 'Vehicles'}</Badge></div>
                    <div className="text-xs text-ink-500">{w.orgUnit.name} · {w.entries} entries</div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        {url.list ? <ListDetail id={url.list} onDeleted={() => setUrl({ list: '' })} /> : <Card><EmptyState title="Select a watchlist" /></Card>}
      </div>
      {creating && <CreateList onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setUrl({ list: id }); }} />}
    </div>
  );
}

function CreateList({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'FACE' | 'VEHICLE'>('VEHICLE');
  const [description, setDescription] = useState('');
  // Org units where the user holds a role; the API enforces ai:watchlist_manage at the chosen unit (404 otherwise).
  const orgs = [...new Map((me?.roles ?? []).map((r) => [r.orgUnitId, { id: r.orgUnitId, name: r.orgUnitName }])).values()];
  const [orgUnitId, setOrg] = useState(orgs[0]?.id ?? me?.user.homeOrgUnit.id ?? '');
  const m = useMutation({
    mutationFn: () => api.post<{ id: string }>('/ai/watchlists', { name, kind, orgUnitId, description: description || undefined }),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: aiKeys.watchlists }); onCreated(r.id); },
  });
  return (
    <Modal open title="New watchlist" onClose={onClose} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={name.trim().length < 2 || !orgUnitId} loading={m.isPending} onClick={() => m.mutate()}>Create</Button></>}>
      <div className="space-y-3">
        <Field label="Name" htmlFor="wl-name" required><Input id="wl-name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Kind" htmlFor="wl-kind"><Select id="wl-kind" value={kind} onChange={(e) => setKind(e.target.value as 'FACE' | 'VEHICLE')}><option value="VEHICLE">Vehicles (plates)</option><option value="FACE">Faces (reference images)</option></Select></Field>
        <Field label="Jurisdiction" htmlFor="wl-org" hint="The list applies to evidence in this org unit and below.">
          <Select id="wl-org" value={orgUnitId} onChange={(e) => setOrg(e.target.value)}>{orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select>
        </Field>
        <Field label="Description" htmlFor="wl-desc"><Textarea id="wl-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        {m.error && <Alert tone="red">{errorMessage(m.error)}</Alert>}
      </div>
    </Modal>
  );
}

function ListDetail({ id, onDeleted }: { id: string; onDeleted: () => void }) {
  const q = useWatchlist(id);
  const qc = useQueryClient();
  const toast = useToast();
  const [del, setDel] = useState(false);
  const [removeEntry, setRemoveEntry] = useState<WatchlistEntry | null>(null);
  const refresh = () => { void qc.invalidateQueries({ queryKey: aiKeys.watchlist(id) }); void qc.invalidateQueries({ queryKey: aiKeys.watchlists }); };
  const delList = useMutation({ mutationFn: () => api.delete(`/ai/watchlists/${id}`), onSuccess: () => { toast.success('Watchlist deleted'); void qc.invalidateQueries({ queryKey: aiKeys.watchlists }); onDeleted(); } });
  const delEntry = useMutation({ mutationFn: (e: WatchlistEntry) => api.delete(`/ai/watchlists/${id}/entries/${e.id}`), onSuccess: () => { setRemoveEntry(null); refresh(); } });
  const reembed = useMutation({ mutationFn: (e: WatchlistEntry) => api.post(`/ai/watchlists/${id}/entries/${e.id}/reembed`), onSuccess: refresh });
  if (q.isLoading) return <Card><Spinner /></Card>;
  if (q.error) return <Card><ErrorState error={q.error} onRetry={() => void q.refetch()} /></Card>;
  const w = q.data!;
  return (
    <Card title={`${w.name} (${w.kind === 'FACE' ? 'faces' : 'vehicles'})`} actions={<Button size="sm" variant="danger" icon={<Trash2 className="h-4 w-4" aria-hidden />} onClick={() => setDel(true)}>Delete list</Button>}>
      <p className="mb-3 text-sm text-ink-600">{w.orgUnit.name}{w.description ? ` — ${w.description}` : ''}</p>
      <AddEntry listId={id} kind={w.kind} onAdded={refresh} />
      {!w.entries.length ? <EmptyState title="No entries" /> : (
        <ul className="mt-4 divide-y divide-ink-100">
          {w.entries.map((e) => (
            <li key={e.id} className="flex items-center gap-3 py-2 text-sm">
              {e.imageUrl && <img src={e.imageUrl} alt={`Reference image for ${e.label}`} className="h-14 w-14 rounded object-cover" />}
              <div className="min-w-0 flex-1">
                <div className="font-medium">{e.label}{e.plate && <span className="mono ml-2 text-ink-600">{e.plate}</span>}</div>
                <div className="text-xs text-ink-500">
                  {w.kind === 'FACE' && <>Embedding: <Badge tone={e.embeddingStatus === 'READY' ? 'green' : e.embeddingStatus === 'FAILED' ? 'red' : 'amber'}>{e.embeddingStatus}</Badge>{e.model && ` ${e.model.code}@${e.model.version}`}{e.embeddingError && ` — ${e.embeddingError}`} · </>}
                  added {formatDateTime(e.createdAt)}
                </div>
              </div>
              {e.embeddingStatus === 'FAILED' && <Button size="sm" variant="ghost" icon={<RefreshCw className="h-4 w-4" aria-hidden />} loading={reembed.isPending} onClick={() => reembed.mutate(e)}>Retry</Button>}
              <Button size="sm" variant="ghost" aria-label={`Remove ${e.label}`} onClick={() => setRemoveEntry(e)} icon={<Trash2 className="h-4 w-4" aria-hidden />} />
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog open={del} title="Delete watchlist" message={`Delete "${w.name}" and its ${w.entries.length} entries? Past detections keep their labels.`} confirmLabel="Delete" variant="danger" loading={delList.isPending} error={delList.error} onCancel={() => setDel(false)} onConfirm={() => delList.mutate()} />
      <ConfirmDialog open={!!removeEntry} title="Remove entry" message={`Remove "${removeEntry?.label}" from the list?`} confirmLabel="Remove" variant="danger" loading={delEntry.isPending} error={delEntry.error} onCancel={() => setRemoveEntry(null)} onConfirm={() => delEntry.mutate(removeEntry!)} />
    </Card>
  );
}

function AddEntry({ listId, kind, onAdded }: { listId: string; kind: 'FACE' | 'VEHICLE'; onAdded: () => void }) {
  const [label, setLabel] = useState('');
  const [plate, setPlate] = useState('');
  const [notes, setNotes] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [fileErr, setFileErr] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: async () => {
      let imageBase64: string | undefined;
      if (file) {
        const buf = new Uint8Array(await file.arrayBuffer());
        let s = '';
        for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        imageBase64 = btoa(s);
      }
      return api.post(`/ai/watchlists/${listId}/entries`, { label, notes: notes || undefined, plate: kind === 'VEHICLE' ? plate : undefined, imageBase64 });
    },
    onSuccess: () => { setLabel(''); setPlate(''); setNotes(''); setFile(null); onAdded(); },
  });
  const ok = label.trim() && (kind === 'VEHICLE' ? plate.replace(/[^A-Za-z0-9]/g, '').length >= 2 : !!file && !fileErr);
  return (
    <form className="flex flex-wrap items-end gap-3 rounded border border-ink-200 p-3" onSubmit={(e) => { e.preventDefault(); if (ok) m.mutate(); }}>
      <Field label={kind === 'FACE' ? 'Name / reference' : 'Label'} htmlFor="we-label" required><Input id="we-label" value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
      {kind === 'VEHICLE' ? (
        <Field label="Plate" htmlFor="we-plate" required hint="Letters and digits; spaces/dashes ignored"><Input id="we-plate" value={plate} onChange={(e) => setPlate(e.target.value)} className="w-36 font-mono" /></Field>
      ) : (
        <Field label="Reference image (JPEG/PNG ≤ 2 MB, one clear frontal face)" htmlFor="we-img" required error={fileErr}>
          <input id="we-img" type="file" accept="image/jpeg,image/png" className="text-sm" onChange={(e) => { const f = e.target.files?.[0] ?? null; setFile(f); setFileErr(f && f.size > MAX_IMAGE ? 'Image larger than 2 MB' : null); }} />
        </Field>
      )}
      <Field label="Notes" htmlFor="we-notes"><Input id="we-notes" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      <Button type="submit" disabled={!ok} loading={m.isPending} icon={<Plus className="h-4 w-4" aria-hidden />}>Add</Button>
      {m.error && <div className="w-full"><Alert tone="red">{errorMessage(m.error)}</Alert></div>}
    </form>
  );
}
