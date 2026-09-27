/** Evidence detail tabs: "Bookmarks & annotations" (all I can see on this item) and "Related evidence". */
import { useState } from 'react';
import { Link } from 'react-router';
import type { EvidenceSummary, EvidenceTab } from '@/lib/extensions';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatTimecode, parseTimeInput, titleCase } from '@/lib/format';
import { Alert, Badge, Button, Card, EmptyState, ErrorState, Field, Input, Select, Spinner, Textarea } from '@/components/ui';
import { useRelated } from '@/modules/search/api';
import { useAnnotations, useBookmarks, useRelations, useWsMutation } from './api';

const at = (id: string, ms: number) => `/evidence/${id}?tab=playback&t=${Math.max(1, Math.round(ms))}`;

function NotesTab({ evidence }: { evidence: EvidenceSummary }) {
  const [showDeleted, setShowDeleted] = useState(false);
  const bookmarks = useBookmarks(evidence.id);
  const annotations = useAnnotations(evidence.id, undefined, showDeleted);
  const [time, setTime] = useState('00:00.000');
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<'BOOKMARK' | 'NOTE'>('BOOKMARK');
  const [err, setErr] = useState<string | null>(null);
  const addBm = useWsMutation((b: { timeMs: number; label: string }) => api.post('/workspaces/bookmarks', { evidenceId: evidence.id, ...b }));
  const addNote = useWsMutation((b: { startMs: number; body: string }) => api.post('/workspaces/annotations', { evidenceId: evidence.id, kind: 'NOTE', ...b }));
  const delBm = useWsMutation((id: string) => api.delete(`/workspaces/bookmarks/${id}`));
  const submit = () => {
    const ms = parseTimeInput(time);
    if (ms === null) return setErr('Time must look like mm:ss.mmm, h:mm:ss or 1500ms');
    if (evidence.durationMs !== null && ms > evidence.durationMs) return setErr('Time is beyond the end of the recording');
    if (!label.trim()) return setErr(kind === 'NOTE' ? 'Enter the note text' : 'Enter a label');
    setErr(null);
    const done = { onSuccess: () => setLabel('') };
    if (kind === 'BOOKMARK') addBm.mutate({ timeMs: ms, label: label.trim() }, done);
    else addNote.mutate({ startMs: ms, body: label.trim() }, done);
  };
  const error = err ?? (addBm.error || addNote.error || delBm.error ? errorMessage(addBm.error ?? addNote.error ?? delBm.error) : null);
  return (
    <div className="space-y-4">
      <Card title="Add">
        <div className="grid gap-3 md:grid-cols-[10rem_10rem_1fr_auto] md:items-end">
          <Field label="Type" htmlFor="na-kind">
            <Select id="na-kind" value={kind} onChange={(e) => setKind(e.target.value as 'BOOKMARK' | 'NOTE')}>
              <option value="BOOKMARK">Personal bookmark</option>
              <option value="NOTE">Shared note</option>
            </Select>
          </Field>
          <Field label="Time" htmlFor="na-time"><Input id="na-time" value={time} onChange={(e) => setTime(e.target.value)} className="font-mono" /></Field>
          <Field label={kind === 'NOTE' ? 'Note (visible to everyone who can see this evidence)' : 'Label'} htmlFor="na-label">
            {kind === 'NOTE' ? <Textarea id="na-label" rows={1} value={label} maxLength={5000} onChange={(e) => setLabel(e.target.value)} /> : <Input id="na-label" value={label} maxLength={200} onChange={(e) => setLabel(e.target.value)} />}
          </Field>
          <Button loading={addBm.isPending || addNote.isPending} onClick={submit}>Add</Button>
        </div>
        {error && <div className="mt-2"><Alert tone="red">{error}</Alert></div>}
        <p className="mt-2 text-xs text-ink-500">Workspace bookmarks, regions and highlights are created from the workspace review view. Every change is recorded in the chain of custody.</p>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Bookmarks">
          {bookmarks.isLoading ? <Spinner /> : bookmarks.error ? <ErrorState error={bookmarks.error} onRetry={() => void bookmarks.refetch()} /> : !bookmarks.data?.items.length ? <EmptyState title="No bookmarks" /> : (
            <ul className="divide-y divide-ink-100">
              {bookmarks.data.items.map((b) => (
                <li key={b.id} className="flex items-center gap-2 py-1.5 text-sm">
                  <Link to={at(evidence.id, b.timeMs)} className="mono text-xs text-brand-700 hover:underline">{formatTimecode(b.timeMs)}</Link>
                  <span className="flex-1">{b.label}<span className="block text-xs text-ink-500">{b.user.fullName} · {b.workspaceTitle ?? 'personal'}</span></span>
                  {b.canDelete && <Button size="sm" variant="ghost" onClick={() => delBm.mutate(b.id)} aria-label={`Delete bookmark ${b.label}`}>Delete</Button>}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Annotations" actions={<label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} />Show deleted</label>}>
          {annotations.isLoading ? <Spinner /> : annotations.error ? <ErrorState error={annotations.error} onRetry={() => void annotations.refetch()} /> : !annotations.data?.items.length ? <EmptyState title="No annotations" /> : (
            <ul className="divide-y divide-ink-100">
              {annotations.data.items.map((a) => (
                <li key={a.id} className={`py-1.5 text-sm ${a.deleted ? 'opacity-60' : ''}`}>
                  <div className="flex items-center gap-2">
                    <Link to={at(evidence.id, a.startMs)} className="mono text-xs text-brand-700 hover:underline">{formatTimecode(a.startMs)}{a.endMs !== null ? `–${formatTimecode(a.endMs)}` : ''}</Link>
                    <Badge>{a.kind.toLowerCase()}</Badge>
                    {a.deleted && <Badge tone="red">deleted{a.deletedBy ? ` by ${a.deletedBy}` : ''}</Badge>}
                  </div>
                  {a.body && <p className={a.deleted ? 'line-through' : ''}>{a.body}</p>}
                  <p className="text-xs text-ink-500">{a.author.fullName} · {a.workspaceTitle ?? 'shared on evidence'}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

function RelatedTab({ evidence }: { evidence: EvidenceSummary }) {
  const { can } = useAuth();
  const related = useRelated(evidence.id);
  const relations = useRelations(evidence.id, can('workspace:use'));
  return (
    <div className="space-y-4">
      {can('workspace:use') && (
        <Card title="Recorded relations">
          {relations.isLoading ? <Spinner /> : relations.error ? <ErrorState error={relations.error} onRetry={() => void relations.refetch()} /> : !relations.data?.items.length ? (
            <p className="text-sm text-ink-500">No relations recorded. Relate items from an investigation workspace.</p>
          ) : (
            <ul className="divide-y divide-ink-100">
              {relations.data.items.map((r) => {
                const other = r.evidenceA.id === evidence.id ? r.evidenceB : r.evidenceA;
                return (
                  <li key={r.id} className="flex items-center gap-2 py-1.5 text-sm">
                    <Badge tone="blue">{titleCase(r.relation)}</Badge>
                    <Link to={`/evidence/${other.id}`} className="mono text-xs text-brand-800 hover:underline">{other.evidenceNumber ?? other.id}</Link>
                    <span className="truncate">{other.title}</span>
                    {r.note && <span className="text-ink-500">— {r.note}</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      )}
      <Card title="Suggestions">
        {related.isLoading ? <Spinner label="Finding related evidence…" /> : related.error ? <ErrorState error={related.error} onRetry={() => void related.refetch()} /> : !related.data?.items.length ? (
          <EmptyState title="No related evidence found" description="Suggestions consider the same case, officer or device (±1 h), place and time (200 m), and approved plate / watchlist hits — among evidence you can see." />
        ) : (
          <ul className="divide-y divide-ink-100">
            {related.data.items.map((r) => (
              <li key={r.id} className="py-2 text-sm">
                <Link to={`/evidence/${r.id}`} className="mono text-xs font-semibold text-brand-800 hover:underline">{r.evidenceNumber ?? r.id}</Link> <span>{r.title ?? 'Untitled'}</span>
                <span className="ml-2 text-xs text-ink-500">{r.orgUnit.name}</span>
                <div className="mt-0.5 flex flex-wrap gap-1">{r.reasons.map((x, i) => <Badge key={i} tone={x.kind === 'RELATION' ? 'blue' : 'gray'}>{x.detail}</Badge>)}</div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

const tabs: EvidenceTab[] = [
  { id: 'notes', label: 'Bookmarks & annotations', order: 40, anyOf: ['workspace:use'], component: NotesTab },
  { id: 'related', label: 'Related evidence', order: 50, anyOf: ['search:use'], component: RelatedTab },
];
export default tabs;
