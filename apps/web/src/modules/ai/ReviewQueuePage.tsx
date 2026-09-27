/**
 * Human review queue. Keyboard: J/K next/previous · A approve · R reject (comment required) · S request second review
 * · X select · H history. Filters and paging live in the URL. Bulk actions report per-item results.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { CheckCircle2, History, Keyboard, ShieldAlert, Tag, XCircle } from 'lucide-react';
import { AI_TASKS, type ReviewAction } from '@ksp/shared';
import { useUrlState } from '@/lib/hooks';
import { formatDateTime, formatTimecode } from '@/lib/format';
import { Alert, Badge, Button, Card, Checkbox, clsx, EmptyState, ErrorState, Field, Input, Modal, PageHeader, Pagination, Select, Spinner, Textarea, useToast } from '@/components/ui';
import { useHistory, useReview, useReviewQueue, type QueueItem } from './api';
import { Attributes, ConfidenceBar, CropThumb, ReviewBadge, taskLabel } from './components';

const DEFAULTS = { task: '', status: '', label: '', minConfidence: '', maxConfidence: '', evidenceId: '', sort: '-confidence', page: '1', pageSize: '24' };

export function ReviewQueuePage() {
  const [url, setUrl, reset] = useUrlState(DEFAULTS);
  const q = useReviewQueue(Object.fromEntries(Object.entries(url).filter(([, v]) => v !== '')));
  const { one, bulk } = useReview();
  const toast = useToast();
  const items = useMemo(() => q.data?.items ?? [], [q.data]);
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [prompt, setPrompt] = useState<{ ids: string[]; action: 'REJECT' | 'REQUEST_SECOND_REVIEW' | 'CORRECT_LABEL' | 'COMMENT' } | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);
  // Single-key shortcuts can be switched off (WCAG 2.1.4 Character Key Shortcuts); the choice is remembered.
  const [shortcuts, setShortcuts] = useState(() => {
    try {
      return localStorage.getItem(SHORTCUTS_KEY) !== 'off';
    } catch {
      return true;
    }
  });
  const toggleShortcuts = (on: boolean) => {
    setShortcuts(on);
    try {
      localStorage.setItem(SHORTCUTS_KEY, on ? 'on' : 'off');
    } catch {
      /* storage unavailable */
    }
  };
  const current = items[Math.min(cursor, items.length - 1)];

  useEffect(() => setCursor((c) => Math.min(c, Math.max(0, items.length - 1))), [items.length]);

  const act = useCallback((ids: string[], action: ReviewAction, extra: { comment?: string; correctedLabel?: string } = {}) => {
    if (ids.length === 1) {
      one.mutate({ id: ids[0]!, action, ...extra }, {
        onSuccess: (r) => toast.success(`${taskLabel(r.task)} "${r.label}": ${r.reviewStatus.replace(/_/g, ' ').toLowerCase()}${r.tagCreated ? ` — tag "${r.tagCreated}" added to evidence` : ''}`),
        onError: (e) => toast.error(e),
      });
    } else {
      bulk.mutate(ids.map((id) => ({ id, action, comment: extra.comment })), {
        onSuccess: (r) => {
          setSelected(new Set());
          if (r.failed) toast.error(`${r.succeeded} done, ${r.failed} failed: ${r.results.filter((x) => !x.ok).map((x) => x.error?.message).slice(0, 3).join('; ')}`);
          else toast.success(`${r.succeeded} items updated`);
        },
        onError: (e) => toast.error(e),
      });
    }
  }, [one, bulk, toast]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (!shortcuts || prompt || historyId || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'j') { setCursor((c) => Math.min(items.length - 1, c + 1)); e.preventDefault(); }
      else if (k === 'k') { setCursor((c) => Math.max(0, c - 1)); e.preventDefault(); }
      else if (!current) return;
      else if (k === 'a') { if (!current.reviewedByMe) act([current.id], 'APPROVE'); e.preventDefault(); }
      else if (k === 'r') { setPrompt({ ids: [current.id], action: 'REJECT' }); e.preventDefault(); }
      else if (k === 's') { setPrompt({ ids: [current.id], action: 'REQUEST_SECOND_REVIEW' }); e.preventDefault(); }
      else if (k === 'x') { setSelected((s) => { const n = new Set(s); if (n.has(current.id)) n.delete(current.id); else n.add(current.id); return n; }); e.preventDefault(); }
      else if (k === 'h') { setHistoryId(current.id); e.preventDefault(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [items, current, prompt, historyId, act, shortcuts]);

  useEffect(() => {
    if (current) document.getElementById(`rq-${current.id}`)?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  const busy = one.isPending || bulk.isPending;
  return (
    <div className="space-y-4">
      <PageHeader title="AI review queue" subtitle="AI results are advisory until a reviewer decides. Face-recognition matches need two different approvers." />
      <Card>
        <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => e.preventDefault()}>
          <Field label="Task" htmlFor="rq-task">
            <Select id="rq-task" value={url.task} onChange={(e) => setUrl({ task: e.target.value })}>
              <option value="">All</option>
              {AI_TASKS.map((t) => <option key={t} value={t}>{taskLabel(t)}</option>)}
            </Select>
          </Field>
          <Field label="Status" htmlFor="rq-status">
            <Select id="rq-status" value={url.status} onChange={(e) => setUrl({ status: e.target.value })}>
              <option value="">Pending + 2nd review</option>
              <option value="PENDING">Pending</option>
              <option value="NEEDS_SECOND_REVIEW">Needs 2nd review</option>
            </Select>
          </Field>
          <Field label="Label" htmlFor="rq-label"><Input id="rq-label" value={url.label} onChange={(e) => setUrl({ label: e.target.value })} className="w-32" /></Field>
          <Field label="Min conf." htmlFor="rq-min"><Input id="rq-min" type="number" step="0.05" min={0} max={1} value={url.minConfidence} onChange={(e) => setUrl({ minConfidence: e.target.value })} className="w-20" /></Field>
          <Field label="Max conf." htmlFor="rq-max"><Input id="rq-max" type="number" step="0.05" min={0} max={1} value={url.maxConfidence} onChange={(e) => setUrl({ maxConfidence: e.target.value })} className="w-20" /></Field>
          <Field label="Sort" htmlFor="rq-sort">
            <Select id="rq-sort" value={url.sort} onChange={(e) => setUrl({ sort: e.target.value })}>
              <option value="-confidence">Confidence (high first)</option>
              <option value="confidence">Confidence (low first)</option>
              <option value="-created_at">Newest</option>
              <option value="created_at">Oldest</option>
              <option value="frame_time">Evidence / time</option>
            </Select>
          </Field>
          {url.evidenceId && <Badge tone="blue">Evidence filter active</Badge>}
          <Button variant="ghost" onClick={reset}>Clear filters</Button>
        </form>
        <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-ink-500">
          <Checkbox label="Keyboard shortcuts" checked={shortcuts} onChange={toggleShortcuts} />
          <p className="flex items-center gap-2" id="rq-shortcuts"><Keyboard className="h-4 w-4" aria-hidden /> J/K move · A approve · R reject · S second review · X select · H history</p>
        </div>
        <p className="sr-only" aria-live="polite" data-testid="rq-current">
          {current ? `Item ${Math.min(cursor, items.length - 1) + 1} of ${items.length}: ${taskLabel(current.task)} ${current.correctedLabel ?? current.label}, ${Math.round(current.confidence * 100)}% confidence, ${current.reviewStatus.replace(/_/g, ' ').toLowerCase()}` : ''}
        </p>
      </Card>

      {selected.size > 0 && (
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-md border border-brand-200 bg-brand-50 p-2 text-sm" role="region" aria-label="Bulk actions">
          <span className="font-medium">{selected.size} selected</span>
          <Button size="sm" variant="success" loading={bulk.isPending} onClick={() => act([...selected], 'APPROVE')}>Approve selected</Button>
          <Button size="sm" variant="danger" onClick={() => setPrompt({ ids: [...selected], action: 'REJECT' })}>Reject selected…</Button>
          <Button size="sm" variant="secondary" onClick={() => setPrompt({ ids: [...selected], action: 'REQUEST_SECOND_REVIEW' })}>Second review…</Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
        </div>
      )}

      {q.isLoading ? <Spinner label="Loading queue…" /> : q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : !items.length ? (
        <EmptyState icon={<CheckCircle2 className="h-8 w-8" aria-hidden />} title="Nothing to review" description="No AI results match these filters in your jurisdiction." />
      ) : (
        <>
          <ul className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3" aria-label="Review items">
            {items.map((d, i) => (
              <QueueCard key={d.id} d={d} active={i === cursor} selected={selected.has(d.id)} busy={busy}
                onFocus={() => setCursor(i)}
                onSelect={(v) => setSelected((s) => { const n = new Set(s); if (v) n.add(d.id); else n.delete(d.id); return n; })}
                onApprove={() => act([d.id], 'APPROVE')}
                onPrompt={(action) => setPrompt({ ids: [d.id], action })}
                onHistory={() => setHistoryId(d.id)} />
            ))}
          </ul>
          <Pagination page={Number(url.page)} pageSize={Number(url.pageSize)} total={q.data!.total} onPage={(p) => setUrl({ page: String(p) })} />
        </>
      )}

      <PromptDialog prompt={prompt} loading={busy} onClose={() => setPrompt(null)} onSubmit={(v) => { act(prompt!.ids, prompt!.action, v); setPrompt(null); }} />
      <HistoryDrawer id={historyId} onClose={() => setHistoryId(null)} />
    </div>
  );
}

function QueueCard({ d, active, selected, busy, onFocus, onSelect, onApprove, onPrompt, onHistory }: {
  d: QueueItem; active: boolean; selected: boolean; busy: boolean; onFocus: () => void; onSelect: (v: boolean) => void; onApprove: () => void;
  onPrompt: (a: 'REJECT' | 'REQUEST_SECOND_REVIEW' | 'CORRECT_LABEL' | 'COMMENT') => void; onHistory: () => void;
}) {
  return (
    <li id={`rq-${d.id}`} onClick={onFocus} className={clsx('rounded-md border bg-white p-3 shadow-sm', active ? 'border-brand-600 ring-2 ring-brand-600' : 'border-ink-200')} aria-current={active || undefined}>
      <div className="flex gap-3">
        <CropThumb d={d} size="lg" />
        <div className="min-w-0 flex-1 space-y-1.5 text-sm">
          <div className="flex items-start justify-between gap-2">
            <Checkbox label="Select" checked={selected} onChange={onSelect} />
            <ReviewBadge status={d.reviewStatus} />
          </div>
          <div className="text-xs font-medium uppercase text-ink-500">{taskLabel(d.task)}</div>
          <div className="break-words text-base font-semibold text-ink-900">{d.correctedLabel ?? d.label}{d.correctedLabel && <span className="ml-2 text-xs font-normal text-ink-500 line-through">{d.label}</span>}</div>
          <ConfidenceBar value={d.confidence} threshold={d.threshold} />
          <div className="text-xs text-ink-600">Model <span className="mono">{d.model.code}@{d.model.version}</span> · threshold {Math.round(d.threshold * 100)}%</div>
          <div className="text-xs text-ink-600">
            <Link className="text-brand-700 hover:underline" to={`/evidence/${d.evidenceId}?tab=playback&t=${d.frameTimeMs}`}>{d.evidenceNumber ?? d.evidenceId.slice(0, 8)} @ {formatTimecode(d.frameTimeMs)}</Link>
            {' · '}{formatDateTime(d.createdAt)}
          </div>
          <Attributes a={d.attributes} />
          {d.dualApproval && <p className="flex items-center gap-1 text-xs text-violet-800"><ShieldAlert className="h-3.5 w-3.5" aria-hidden /> Needs 2 approvals ({d.approvals}/2)</p>}
          {d.reviewedByMe && <p className="text-xs text-ink-500">You already reviewed this — a different reviewer must decide.</p>}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="success" disabled={busy || d.reviewedByMe} onClick={onApprove} icon={<CheckCircle2 className="h-4 w-4" aria-hidden />}>Approve</Button>
        <Button size="sm" variant="danger" disabled={busy} onClick={() => onPrompt('REJECT')} icon={<XCircle className="h-4 w-4" aria-hidden />}>Reject</Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => onPrompt('REQUEST_SECOND_REVIEW')}>2nd review</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => onPrompt('CORRECT_LABEL')} icon={<Tag className="h-4 w-4" aria-hidden />}>Correct label</Button>
        <Button size="sm" variant="ghost" onClick={() => onPrompt('COMMENT')}>Comment</Button>
        <Button size="sm" variant="ghost" onClick={onHistory} icon={<History className="h-4 w-4" aria-hidden />}>History</Button>
      </div>
    </li>
  );
}

const SHORTCUTS_KEY = 'ksp.review.shortcuts';

const PROMPT_TEXT = {
  REJECT: { title: 'Reject AI result', label: 'Reason (required, recorded in the audit trail)', required: true, button: 'Reject' },
  REQUEST_SECOND_REVIEW: { title: 'Request a second review', label: 'Note for the second reviewer (optional)', required: false, button: 'Request second review' },
  COMMENT: { title: 'Add a comment', label: 'Comment', required: true, button: 'Add comment' },
  CORRECT_LABEL: { title: 'Correct the label', label: 'Note (optional)', required: false, button: 'Save correction' },
} as const;

function PromptDialog({ prompt, loading, onClose, onSubmit }: { prompt: { ids: string[]; action: keyof typeof PROMPT_TEXT } | null; loading: boolean; onClose: () => void; onSubmit: (v: { comment?: string; correctedLabel?: string }) => void }) {
  const [comment, setComment] = useState('');
  const [label, setLabel] = useState('');
  useEffect(() => { setComment(''); setLabel(''); }, [prompt]);
  if (!prompt) return null;
  const t = PROMPT_TEXT[prompt.action];
  const invalid = (t.required && comment.trim().length < 3) || (prompt.action === 'CORRECT_LABEL' && !label.trim());
  return (
    <Modal open title={`${t.title}${prompt.ids.length > 1 ? ` (${prompt.ids.length} items)` : ''}`} onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant={prompt.action === 'REJECT' ? 'danger' : 'primary'} disabled={invalid} loading={loading} onClick={() => onSubmit({ comment: comment.trim() || undefined, correctedLabel: label.trim() || undefined })}>{t.button}</Button></>}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (!invalid) onSubmit({ comment: comment.trim() || undefined, correctedLabel: label.trim() || undefined }); }}>
        {prompt.action === 'CORRECT_LABEL' && (
          <Field label="Correct label" htmlFor="pd-label" required hint="Used for retraining datasets; for evidence tags it becomes the tag."><Input id="pd-label" value={label} onChange={(e) => setLabel(e.target.value)} autoFocus /></Field>
        )}
        <Field label={t.label} htmlFor="pd-comment" required={t.required} error={t.required && comment.length > 0 && comment.trim().length < 3 ? 'At least 3 characters' : null}>
          <Textarea id="pd-comment" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} autoFocus={prompt.action !== 'CORRECT_LABEL'} />
        </Field>
      </form>
    </Modal>
  );
}

function HistoryDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const q = useHistory(id);
  if (!id) return null;
  return (
    <Modal open size="lg" title="Review history" onClose={onClose}>
      {q.isLoading ? <Spinner /> : q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (
        <div className="space-y-4">
          <div className="flex gap-3">
            <CropThumb d={q.data!.detection} size="lg" />
            <div className="space-y-1 text-sm">
              <div className="font-semibold">{taskLabel(q.data!.detection.task)}: {q.data!.detection.correctedLabel ?? q.data!.detection.label}</div>
              <ReviewBadge status={q.data!.detection.reviewStatus} />
              <ConfidenceBar value={q.data!.detection.confidence} threshold={q.data!.detection.threshold} />
              <div className="text-xs text-ink-600">{q.data!.detection.model.code}@{q.data!.detection.model.version} · {q.data!.detection.evidenceNumber} @ {formatTimecode(q.data!.detection.frameTimeMs)}</div>
              <Attributes a={q.data!.detection.attributes} />
            </div>
          </div>
          {q.data!.events.length === 0 ? <Alert tone="blue">No review actions yet.</Alert> : (
            <ol className="space-y-2 border-l border-ink-200 pl-4">
              {q.data!.events.map((e) => (
                <li key={e.id} className="text-sm">
                  <div className="font-medium">{e.action.replace(/_/g, ' ').toLowerCase()} — {e.reviewer.fullName}</div>
                  <div className="text-xs text-ink-500">{formatDateTime(e.createdAt)} · {e.previousStatus} → {e.newStatus}{e.correctedLabel ? ` · label "${e.correctedLabel}"` : ''}</div>
                  {e.comment && <p className="mt-1 whitespace-pre-wrap text-ink-700">{e.comment}</p>}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </Modal>
  );
}

