/**
 * Investigation workspace: evidence grid, synchronised multi-video comparison (SyncPlayer, offsets persisted),
 * single-video review with bookmarks/annotations, incident timeline, related evidence and members.
 * Evidence the current user cannot see is shown as a restricted placeholder — the workspace never grants access.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Archive, ArchiveRestore, Film, Link2, Lock, Pencil, Plus, Trash2, UserMinus, UserPlus } from 'lucide-react';
import { SyncPlayer, type SyncItem } from '@/modules/video';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useUrlState } from '@/lib/hooks';
import { formatDateTime, formatDuration, formatTimecode, titleCase } from '@/lib/format';
import { UserPicker, type UserOption } from '@/components/pickers';
import { Alert, Badge, Button, Card, Checkbox, ConfirmDialog, EmptyState, ErrorState, Field, Input, Modal, PageHeader, Select, Spinner, StatusBadge, Tabs, Textarea, useToast } from '@/components/ui';
import { useRelated } from '@/modules/search/api';
import { canEdit, RELATIONS, useItems, useRelations, useWorkspace, useWsMutation, type RelationType, type VisibleItem, type WorkspaceDetail, type WsRole } from './api';
import { AnnotationStudio } from './AnnotationStudio';
import { EvidencePicker } from './EvidencePicker';
import { TimelineView } from './TimelineView';

import { t as tr } from '@/lib/i18n';
type TabId = 'evidence' | 'compare' | 'review' | 'timeline' | 'related' | 'members';
const URL_DEFAULTS = { tab: 'evidence', item: '', t: '' };

function EvidenceGrid({ ws, items, restrictedCount, editable, onReview }: { ws: WorkspaceDetail; items: VisibleItem[]; restrictedCount: number; editable: boolean; onReview: (itemId: string) => void }) {
  const [picker, setPicker] = useState(false);
  const [remove, setRemove] = useState<VisibleItem | null>(null);
  const [notes, setNotes] = useState<{ id: string; value: string } | null>(null);
  const toast = useToast();
  const add = useWsMutation((ids: string[]) => api.post<{ added: string[] }>(`/workspaces/${ws.id}/items`, { evidenceIds: ids }));
  const del = useWsMutation((id: string) => api.delete(`/workspaces/${ws.id}/items/${id}`));
  const patch = useWsMutation((v: { id: string; notes: string }) => api.patch(`/workspaces/${ws.id}/items/${v.id}`, { notes: v.notes || null }));
  const exclude = useMemo(() => new Set(items.map((i) => i.evidenceId)), [items]);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink-600">{items.length}{' '}{tr('item(s)')}{' '}{restrictedCount ? ` · ${restrictedCount} restricted` : ''}</p>
        {editable && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setPicker(true)}>{tr('Add evidence')}</Button>}
      </div>
      {restrictedCount > 0 && (
        <Alert tone="blue" title={tr('Restricted items')}>
          {restrictedCount}{' '}{tr('item(s) in this workspace were added by colleagues but are outside your access. They are listed without any details; being a workspace member does not grant access to evidence.')}
        </Alert>
      )}
      {!items.length ? (
        <EmptyState icon={<Film className="h-6 w-6" />} title={tr('No evidence yet')} description={editable ? 'Add evidence you are authorised to see.' : 'The workspace editors have not added evidence you can see.'} />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((it) => (
            <li key={it.id} className="flex flex-col rounded-lg border border-ink-200 bg-white">
              {it.evidence.thumbnailUrl ? (
                <img src={it.evidence.thumbnailUrl} alt="" className="h-36 w-full rounded-t-lg bg-ink-900 object-cover" loading="lazy" />
              ) : (
                <div className="flex h-36 items-center justify-center rounded-t-lg bg-ink-100 text-ink-400"><Film className="h-8 w-8" aria-hidden /></div>
              )}
              <div className="flex flex-1 flex-col gap-1 p-3">
                <Link to={`/evidence/${it.evidenceId}`} className="mono text-xs font-semibold text-brand-800 hover:underline">{it.evidence.evidenceNumber ?? it.evidenceId}</Link>
                <p className="text-sm font-medium">{it.evidence.title ?? 'Untitled'}</p>
                <p className="text-xs text-ink-500">{it.evidence.orgUnit.name} · {formatDateTime(it.evidence.recordedAt)} · {formatDuration(it.evidence.durationMs)}</p>
                <p className="text-xs text-ink-500">{tr('Sync offset')}{' '}{it.syncOffsetMs >= 0 ? '+' : '−'}{formatTimecode(Math.abs(it.syncOffsetMs))}{' '}{tr('· added by')}{' '}{it.addedBy.fullName}</p>
                {notes?.id === it.id ? (
                  <div className="space-y-1">
                    <label htmlFor={`notes-${it.id}`} className="sr-only">{tr('Notes')}</label>
                    <Textarea id={`notes-${it.id}`} rows={2} value={notes.value} maxLength={2000} onChange={(e) => setNotes({ id: it.id, value: e.target.value })} />
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="secondary" onClick={() => setNotes(null)}>{tr('Cancel')}</Button>
                      <Button size="sm" loading={patch.isPending} onClick={() => patch.mutate({ id: it.id, notes: notes.value.trim() }, { onSuccess: () => setNotes(null) })}>{tr('Save')}</Button>
                    </div>
                  </div>
                ) : (
                  it.notes && <p className="whitespace-pre-wrap text-sm text-ink-700">{it.notes}</p>
                )}
                <div className="mt-auto flex flex-wrap gap-1 pt-2">
                  <Button size="sm" variant="secondary" onClick={() => onReview(it.id)}>{tr('Review')}</Button>
                  {editable && <Button size="sm" variant="ghost" icon={<Pencil className="h-4 w-4" />} onClick={() => setNotes({ id: it.id, value: it.notes ?? '' })}>{tr('Notes')}</Button>}
                  {editable && <Button size="sm" variant="ghost" icon={<Trash2 className="h-4 w-4" />} onClick={() => setRemove(it)}>{tr('Remove')}</Button>}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      <EvidencePicker
        open={picker}
        onClose={() => setPicker(false)}
        exclude={exclude}
        loading={add.isPending}
        onPick={(ids) => add.mutate(ids, { onSuccess: (r) => { setPicker(false); toast.success(`${r.added.length} item(s) added`); }, onError: (e) => toast.error(e) })}
      />
      <ConfirmDialog
        open={!!remove}
        title={tr('Remove from workspace')}
        message={`Remove ${remove?.evidence.evidenceNumber ?? 'this item'} from the workspace? The evidence itself is not changed; the removal is recorded in its chain of custody.`}
        confirmLabel={tr('Remove')}
        variant="danger"
        loading={del.isPending}
        error={del.error}
        onConfirm={() => remove && del.mutate(remove.id, { onSuccess: () => setRemove(null) })}
        onCancel={() => setRemove(null)}
      />
    </div>
  );
}

function CompareView({ ws, items, editable, preset }: { ws: WorkspaceDetail; items: VisibleItem[]; editable: boolean; preset: { ids: string[]; offsets: Record<string, number> } | null }) {
  const [sel, setSel] = useState<string[]>(() => preset?.ids ?? items.slice(0, 2).map((i) => i.id));
  const [local, setLocal] = useState<Record<string, number>>(preset?.offsets ?? {});
  const toast = useToast();
  const save = useWsMutation((b: Array<{ itemId: string; syncOffsetMs: number }>) => api.put(`/workspaces/${ws.id}/items/offsets`, { items: b }));
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    if (preset) {
      setSel(preset.ids);
      setLocal(preset.offsets);
      if (editable) save.mutate(Object.entries(preset.offsets).map(([itemId, syncOffsetMs]) => ({ itemId, syncOffsetMs })));
    }
  }, [preset]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => clearTimeout(timer.current), []);
  const chosen = items.filter((i) => sel.includes(i.id));
  const syncItems: SyncItem[] = chosen.map((i) => ({ evidenceId: i.evidenceId, offsetMs: local[i.id] ?? i.syncOffsetMs, label: i.evidence.evidenceNumber ?? i.evidenceId }));
  const onOffsets = (next: SyncItem[]) => {
    const map: Record<string, number> = { ...local };
    next.forEach((s, j) => {
      const it = chosen[j];
      if (it) map[it.id] = Math.round(s.offsetMs);
    });
    setLocal(map);
    if (!editable) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      save.mutate(chosen.map((it) => ({ itemId: it.id, syncOffsetMs: map[it.id] ?? it.syncOffsetMs })), { onError: (e) => toast.error(e) });
    }, 800);
  };
  const alignByClock = () => {
    const withTime = chosen.filter((c) => c.evidence.recordedAt);
    if (!withTime.length) return toast.error('The selected items have no recording time');
    const min = Math.min(...withTime.map((c) => Date.parse(c.evidence.recordedAt!)));
    const map: Record<string, number> = { ...local };
    for (const c of withTime) map[c.id] = Date.parse(c.evidence.recordedAt!) - min;
    setLocal(map);
    if (editable) save.mutate(withTime.map((c) => ({ itemId: c.id, syncOffsetMs: map[c.id]! })), { onSuccess: () => toast.success('Aligned by recording time') });
  };
  if (items.length < 1) return <EmptyState title={tr('Nothing to compare')} description={tr('Add at least two videos to compare angles.')} />;
  return (
    <div className="space-y-3">
      <Card title={tr('Videos (up to 4)')}>
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          {items.map((i) => (
            <Checkbox
              key={i.id}
              label={i.evidence.evidenceNumber ?? i.evidenceId}
              checked={sel.includes(i.id)}
              disabled={!sel.includes(i.id) && sel.length >= 4}
              onChange={(v) => setSel((s) => (v ? [...s, i.id] : s.filter((x) => x !== i.id)))}
            />
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" onClick={alignByClock} disabled={!chosen.length}>{tr('Align by recording time')}</Button>
          <span className="text-xs text-ink-500">
            {editable ? (save.isPending ? 'Saving offsets…' : 'Offset changes are saved to the workspace.') : 'Read-only: offset changes are not saved.'}
          </span>
        </div>
      </Card>
      {chosen.length ? <SyncPlayer key={sel.join('|')} items={syncItems} onOffsetsChange={onOffsets} /> : <EmptyState title={tr('Select videos to compare')} />}
    </div>
  );
}

function RelatedPanel({ items, editable }: { items: VisibleItem[]; editable: boolean }) {
  const [itemId, setItemId] = useState(items[0]?.id ?? '');
  const current = items.find((i) => i.id === itemId) ?? items[0];
  const related = useRelated(current?.evidenceId ?? '');
  const relations = useRelations(current?.evidenceId ?? '', !!current);
  const [form, setForm] = useState<{ other: string; relation: RelationType; note: string }>({ other: '', relation: 'DIFFERENT_ANGLE', note: '' });
  const create = useWsMutation((b: { evidenceA: string; evidenceB: string; relation: RelationType; note?: string }) => api.post('/workspaces/relations', b));
  const del = useWsMutation((id: string) => api.delete(`/workspaces/relations/${id}`));
  const { can } = useAuth();
  if (!current) return <EmptyState title={tr('No evidence')} />;
  return (
    <div className="space-y-3">
      <Field label={tr('Evidence')} htmlFor="rel-item">
        <Select id="rel-item" value={current.id} onChange={(e) => setItemId(e.target.value)}>
          {items.map((i) => <option key={i.id} value={i.id}>{i.evidence.evidenceNumber ?? i.evidenceId} — {i.evidence.title ?? 'Untitled'}</option>)}
        </Select>
      </Field>
      <Card title={tr('Explicit relations')}>
        {relations.isLoading ? <Spinner /> : relations.error ? <ErrorState error={relations.error} onRetry={() => void relations.refetch()} /> : !relations.data?.items.length ? (
          <p className="text-sm text-ink-500">{tr('No relations recorded.')}</p>
        ) : (
          <ul className="divide-y divide-ink-100">
            {relations.data.items.map((r) => {
              const other = r.evidenceA.id === current.evidenceId ? r.evidenceB : r.evidenceA;
              return (
                <li key={r.id} className="flex items-center gap-2 py-1.5 text-sm">
                  <Badge tone="blue">{titleCase(r.relation)}</Badge>
                  <Link to={`/evidence/${other.id}`} className="mono text-xs text-brand-800 hover:underline">{other.evidenceNumber ?? other.id}</Link>
                  <span className="flex-1 truncate text-ink-600">{r.note}</span>
                  {editable && <Button size="sm" variant="ghost" icon={<Trash2 className="h-4 w-4" />} aria-label={tr('Remove relation')} onClick={() => del.mutate(r.id)} />}
                </li>
              );
            })}
          </ul>
        )}
        {editable && items.length > 1 && (
          <div className="mt-3 grid gap-2 md:grid-cols-[1fr_12rem_1fr_auto] md:items-end">
            <Field label={tr('Related to')} htmlFor="rel-other">
              <Select id="rel-other" value={form.other} onChange={(e) => setForm({ ...form, other: e.target.value })}>
                <option value="">{tr('Choose…')}</option>
                {items.filter((i) => i.id !== current.id).map((i) => <option key={i.id} value={i.evidenceId}>{i.evidence.evidenceNumber ?? i.evidenceId}</option>)}
              </Select>
            </Field>
            <Field label={tr('Relation')} htmlFor="rel-type">
              <Select id="rel-type" value={form.relation} onChange={(e) => setForm({ ...form, relation: e.target.value as RelationType })}>
                {RELATIONS.map((r) => <option key={r} value={r}>{titleCase(r)}</option>)}
              </Select>
            </Field>
            <Field label={tr('Note')} htmlFor="rel-note"><Input id="rel-note" value={form.note} maxLength={1000} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>
            <Button
              icon={<Link2 className="h-4 w-4" />}
              disabled={!form.other}
              loading={create.isPending}
              onClick={() => create.mutate({ evidenceA: current.evidenceId, evidenceB: form.other, relation: form.relation, note: form.note.trim() || undefined }, { onSuccess: () => setForm({ ...form, other: '', note: '' }) })}
            >
              {tr('Relate')}
            </Button>
          </div>
        )}
        {(create.error || del.error) && <div className="mt-2"><Alert tone="red">{errorMessage(create.error ?? del.error)}</Alert></div>}
      </Card>
      {can('search:use') && (
        <Card title={tr('Suggested related evidence')}>
          {related.isLoading ? <Spinner /> : related.error ? <ErrorState error={related.error} onRetry={() => void related.refetch()} /> : !related.data?.items.length ? (
            <p className="text-sm text-ink-500">{tr('No suggestions among the evidence you can see.')}</p>
          ) : (
            <ul className="divide-y divide-ink-100">
              {related.data.items.map((r) => (
                <li key={r.id} className="py-1.5 text-sm">
                  <Link to={`/evidence/${r.id}`} className="mono text-xs font-semibold text-brand-800 hover:underline">{r.evidenceNumber ?? r.id}</Link> {r.title}
                  <div className="mt-0.5 flex flex-wrap gap-1">{r.reasons.map((x, i) => <Badge key={i}>{x.detail}</Badge>)}</div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}

function MembersPanel({ ws }: { ws: WorkspaceDetail }) {
  const { me } = useAuth();
  const user = me?.user;
  const navigate = useNavigate();
  const [pick, setPick] = useState<UserOption | null>(null);
  const [role, setRole] = useState<'EDITOR' | 'VIEWER'>('VIEWER');
  const [leave, setLeave] = useState(false);
  const add = useWsMutation((b: { userId: string; role: string }) => api.post(`/workspaces/${ws.id}/members`, b));
  const change = useWsMutation((b: { userId: string; role: string }) => api.patch(`/workspaces/${ws.id}/members/${b.userId}`, { role: b.role }));
  const remove = useWsMutation((userId: string) => api.delete(`/workspaces/${ws.id}/members/${userId}`));
  const owner = ws.myRole === 'OWNER';
  const err = add.error ?? change.error ?? remove.error;
  return (
    <div className="space-y-3">
      <Alert tone="blue">{tr('Members see only the evidence their own roles and jurisdiction allow. Adding someone here never grants access to evidence.')}</Alert>
      <Card title={`Members (${ws.members.length})`}>
        <ul className="divide-y divide-ink-100">
          {ws.members.map((m) => (
            <li key={m.userId} className="flex flex-wrap items-center gap-2 py-2 text-sm">
              <span className="flex-1">{m.fullName} <span className="text-ink-500">{m.badgeNumber ?? `@${m.username}`}</span></span>
              {owner && m.role !== 'OWNER' ? (
                <Select aria-label={`Role of ${m.fullName}`} value={m.role} onChange={(e) => change.mutate({ userId: m.userId, role: e.target.value })}>
                  <option value="EDITOR">{tr('Editor')}</option>
                  <option value="VIEWER">{tr('Viewer')}</option>
                </Select>
              ) : (
                <Badge tone={m.role === 'OWNER' ? 'blue' : 'gray'}>{titleCase(m.role)}</Badge>
              )}
              {owner && m.role !== 'OWNER' && <Button size="sm" variant="ghost" icon={<UserMinus className="h-4 w-4" />} aria-label={`Remove ${m.fullName}`} onClick={() => remove.mutate(m.userId)} />}
            </li>
          ))}
        </ul>
        {owner && (
          <div className="mt-3 grid gap-2 md:grid-cols-[1fr_10rem_auto] md:items-end">
            <Field label={tr('Add member')} htmlFor="ws-member"><UserPicker id="ws-member" value={pick} onChange={setPick} /></Field>
            <Field label={tr('Role')} htmlFor="ws-role">
              <Select id="ws-role" value={role} onChange={(e) => setRole(e.target.value as 'EDITOR' | 'VIEWER')}>
                <option value="VIEWER">{tr('Viewer')}</option>
                <option value="EDITOR">{tr('Editor')}</option>
              </Select>
            </Field>
            <Button icon={<UserPlus className="h-4 w-4" />} disabled={!pick} loading={add.isPending} onClick={() => pick && add.mutate({ userId: pick.id, role }, { onSuccess: () => setPick(null) })}>{tr('Add')}</Button>
          </div>
        )}
        {err && <div className="mt-2"><Alert tone="red">{errorMessage(err)}</Alert></div>}
        {!owner && (
          <div className="mt-3 flex justify-end">
            <Button variant="secondary" onClick={() => setLeave(true)}>{tr('Leave workspace')}</Button>
          </div>
        )}
      </Card>
      <ConfirmDialog
        open={leave}
        title={tr('Leave workspace')}
        message={tr('You will lose access to this workspace until an owner adds you again.')}
        confirmLabel={tr('Leave')}
        variant="danger"
        loading={remove.isPending}
        error={remove.error}
        onConfirm={() => user && remove.mutate(user.id, { onSuccess: () => navigate('/workspaces') })}
        onCancel={() => setLeave(false)}
      />
    </div>
  );
}

function EditModal({ ws, open, onClose }: { ws: WorkspaceDetail; open: boolean; onClose: () => void }) {
  const [title, setTitle] = useState(ws.title);
  const [description, setDescription] = useState(ws.description ?? '');
  const save = useWsMutation((b: { title: string; description: string | null }) => api.patch(`/workspaces/${ws.id}`, b));
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={tr('Edit workspace')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{tr('Cancel')}</Button>
          <Button disabled={!title.trim()} loading={save.isPending} onClick={() => save.mutate({ title: title.trim(), description: description.trim() || null }, { onSuccess: onClose })}>{tr('Save')}</Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label={tr('Title')} htmlFor="ws-title" required><Input id="ws-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} /></Field>
        <Field label={tr('Description')} htmlFor="ws-desc"><Textarea id="ws-desc" rows={3} value={description} maxLength={5000} onChange={(e) => setDescription(e.target.value)} /></Field>
        {save.error && <Alert tone="red">{errorMessage(save.error)}</Alert>}
      </div>
    </Modal>
  );
}

export function WorkspacePage() {
  const { id = '' } = useParams();
  const ws = useWorkspace(id);
  const itemsQ = useItems(id);
  const [url, setUrl] = useUrlState(URL_DEFAULTS);
  const [edit, setEdit] = useState(false);
  const [archive, setArchive] = useState(false);
  const [preset, setPreset] = useState<{ ids: string[]; offsets: Record<string, number> } | null>(null);
  const setStatus = useWsMutation((status: 'ACTIVE' | 'ARCHIVED') => api.patch(`/workspaces/${id}`, { status }));

  if (ws.isLoading || itemsQ.isLoading) return <Spinner label={tr('Loading workspace…')} />;
  if (ws.error) return <ErrorState error={ws.error} onRetry={() => void ws.refetch()} title={tr('Workspace not available')} />;
  if (itemsQ.error) return <ErrorState error={itemsQ.error} onRetry={() => void itemsQ.refetch()} />;
  const w = ws.data!;
  const all = itemsQ.data!.items;
  const visible = all.filter((i): i is VisibleItem => !i.restricted);
  const restrictedCount = all.length - visible.length;
  const role: WsRole = w.myRole;
  const editable = canEdit(role) && w.status === 'ACTIVE';
  const tab = (['evidence', 'compare', 'review', 'timeline', 'related', 'members'] as TabId[]).includes(url.tab as TabId) ? (url.tab as TabId) : 'evidence';
  const reviewItem = visible.find((i) => i.id === url.item) ?? visible[0];
  const t = Number(url.t);
  const open = (itemId: string, ms: number) => setUrl({ tab: 'review', item: itemId, t: String(Math.max(1, Math.round(ms))) });

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumb={<Link to="/workspaces" className="text-sm text-brand-700 hover:underline">{tr('Workspaces')}</Link>}
        title={<span className="inline-flex items-center gap-2">{w.title} <StatusBadge status={w.status} /></span>}
        subtitle={
          <span>
            {w.case ? <>{tr('Case')}{' '}<Link className="text-brand-700 hover:underline" to={`/cases/${w.case.id}`}>{w.case.caseNumber}</Link> · </> : w.caseRestricted ? <><Lock className="inline h-3 w-3" aria-hidden />{' '}{tr('Linked case restricted ·')}{' '}</> : null}
            {tr('Owner')}{' '}{w.owner.fullName} · {w.orgUnit.name}{' '}{tr('· your role:')}{' '}{titleCase(role)}
            {w.description && <span className="block text-ink-600">{w.description}</span>}
          </span>
        }
        actions={
          <>
            {editable && <Button variant="secondary" icon={<Pencil className="h-4 w-4" />} onClick={() => setEdit(true)}>{tr('Edit')}</Button>}
            {role === 'OWNER' && (
              <Button variant="secondary" icon={w.status === 'ACTIVE' ? <Archive className="h-4 w-4" /> : <ArchiveRestore className="h-4 w-4" />} onClick={() => setArchive(true)}>
                {w.status === 'ACTIVE' ? 'Archive' : 'Re-activate'}
              </Button>
            )}
          </>
        }
      />
      {w.status === 'ARCHIVED' && <Alert tone="amber">{tr('This workspace is archived and read-only.')}</Alert>}
      <Tabs<TabId>
        tabs={[
          { id: 'evidence', label: tr('Evidence'), count: all.length },
          { id: 'compare', label: tr('Compare') },
          { id: 'review', label: tr('Review & annotate') },
          { id: 'timeline', label: tr('Timeline') },
          { id: 'related', label: tr('Related') },
          { id: 'members', label: tr('Members'), count: w.members.length },
        ]}
        value={tab}
        onChange={(v) => setUrl({ tab: v, item: '', t: '' })}
      />
      {tab === 'evidence' && <EvidenceGrid ws={w} items={visible} restrictedCount={restrictedCount} editable={editable} onReview={(itemId) => open(itemId, 0)} />}
      {tab === 'compare' && <CompareView ws={w} items={visible} editable={editable} preset={preset} />}
      {tab === 'review' &&
        (reviewItem ? (
          <div className="space-y-3">
            <Field label={tr('Video')} htmlFor="review-item">
              <Select id="review-item" value={reviewItem.id} onChange={(e) => setUrl({ item: e.target.value, t: '' })}>
                {visible.map((i) => <option key={i.id} value={i.id}>{i.evidence.evidenceNumber ?? i.evidenceId} — {i.evidence.title ?? 'Untitled'}</option>)}
              </Select>
            </Field>
            <AnnotationStudio key={`${reviewItem.id}:${url.t}`} evidenceId={reviewItem.evidenceId} workspaceId={w.id} editable={editable} initialTimeMs={Number.isFinite(t) && t > 0 ? t : undefined} />
          </div>
        ) : (
          <EmptyState title={tr('No evidence to review')} />
        ))}
      {tab === 'timeline' && (
        <TimelineView
          workspaceId={w.id}
          items={visible}
          editable={editable}
          onOpen={open}
          onCompare={(ids, offsets) => {
            setPreset({ ids, offsets });
            setUrl({ tab: 'compare', item: '', t: '' });
          }}
        />
      )}
      {tab === 'related' && <RelatedPanel items={visible} editable={canEdit(role)} />}
      {tab === 'members' && <MembersPanel ws={w} />}
      {edit && <EditModal ws={w} open={edit} onClose={() => setEdit(false)} />}
      <ConfirmDialog
        open={archive}
        title={w.status === 'ACTIVE' ? 'Archive workspace' : 'Re-activate workspace'}
        message={w.status === 'ACTIVE' ? 'Archived workspaces become read-only for all members. You can re-activate it later.' : 'Members with editor rights will be able to change the workspace again.'}
        confirmLabel={w.status === 'ACTIVE' ? 'Archive' : 'Re-activate'}
        loading={setStatus.isPending}
        error={setStatus.error}
        onConfirm={() => setStatus.mutate(w.status === 'ACTIVE' ? 'ARCHIVED' : 'ACTIVE', { onSuccess: () => setArchive(false) })}
        onCancel={() => setArchive(false)}
      />
    </div>
  );
}
