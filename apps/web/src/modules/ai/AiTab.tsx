/**
 * Evidence tab "AI analysis": request analysis (tasks with ACTIVE models only), live job progress, detections grouped
 * by task with confidence + review state, a timeline strip, and an optional player with bbox overlays.
 * Results are advisory until reviewed (badge on every item).
 */
import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Bot, Play, XCircle } from 'lucide-react';
import { AI_SAMPLE_FPS, type AiDetectionDto, type AiJobDto, type AiTask } from '@ksp/shared';
import type { EvidenceSummary } from '@/lib/extensions';
import { useAuth } from '@/lib/auth';
import { errorMessage } from '@/lib/api';
import { formatDateTime, formatTimecode } from '@/lib/format';
import { Alert, Badge, Button, Card, Checkbox, ConfirmDialog, EmptyState, ErrorState, Field, Input, ProgressBar, Select, Spinner, StatusBadge, useToast } from '@/components/ui';
import type { EvidenceDetail } from '../evidence/types';
import { EvidencePlayer, type EvidencePlayerHandle } from '../video';
import { useAiTasks, useCancelJob, useDetections, useEvidenceJobs, useEvidenceWatchlists, useRequestJob } from './api';
import { Attributes, ConfidenceBar, CropThumb, ReviewBadge, TASK_COLORS, taskLabel } from './components';

import { t as tr } from '@/lib/i18n';
export function AiTab({ evidence }: { evidence: EvidenceSummary }) {
  const ev = evidence as EvidenceDetail;
  const { can } = useAuth();
  const canRequest = can('ai:request') && (ev.permissions?.canRequestAi ?? true);
  const canPlay = ev.permissions?.canPlay ?? false;
  return (
    <div className="space-y-4">
      <Alert tone="amber" title={tr('Advisory results')}>
        {tr('AI output is never authoritative. Every detection stays')}{' '}<strong>{tr('pending')}</strong>{' '}{tr('until a reviewer approves or rejects it; face-recognition matches need two independent approvals.')}
      </Alert>
      {canRequest && <RequestForm evidence={ev} />}
      <JobsCard evidenceId={ev.id} canCancel={canRequest} />
      <DetectionsCard evidence={ev} canPlay={canPlay} />
    </div>
  );
}

function RequestForm({ evidence }: { evidence: EvidenceDetail }) {
  const tasks = useAiTasks();
  const [sel, setSel] = useState<Set<AiTask>>(new Set());
  const [fps, setFps] = useState(String(AI_SAMPLE_FPS.default));
  const [thresholds, setThresholds] = useState<Partial<Record<AiTask, string>>>({});
  const [lists, setLists] = useState<Set<string> | null>(null);
  const needsLists = sel.has('FACE_RECOGNITION') || sel.has('ANPR');
  const watchlists = useEvidenceWatchlists(evidence.id, needsLists);
  const request = useRequestJob(evidence.id);
  const toast = useToast();
  const mediaReady = evidence.mediaStatus === 'READY';

  if (tasks.isLoading) return <Spinner label={tr('Loading AI tasks…')} />;
  if (tasks.error) return <ErrorState error={tasks.error} onRetry={() => void tasks.refetch()} />;
  const available = tasks.data!.items.filter((t) => t.available);
  // Tasks refused by the deployment / legal gates are hidden from the picker and explained (EXT-4 / EXT-5).
  const gated = tasks.data!.items.filter((t) => t.allowed === false);
  const unavailable = tasks.data!.items.filter((t) => !t.available && t.allowed !== false);
  const fpsNum = Number(fps);
  const fpsErr = !(fpsNum >= AI_SAMPLE_FPS.min && fpsNum <= AI_SAMPLE_FPS.max) ? `Between ${AI_SAMPLE_FPS.min} and ${AI_SAMPLE_FPS.max}` : null;
  const thrErr = Object.entries(thresholds).find(([, v]) => v !== '' && v !== undefined && !(Number(v) >= 0.05 && Number(v) <= 0.99));

  const submit = () => {
    const th: Partial<Record<AiTask, number>> = {};
    for (const [k, v] of Object.entries(thresholds)) if (v && sel.has(k as AiTask)) th[k as AiTask] = Number(v);
    request.mutate(
      { tasks: [...sel], sampleFps: fpsNum, thresholds: th, watchlistIds: needsLists && lists ? [...lists] : undefined },
      { onSuccess: () => { toast.success('Analysis queued'); setSel(new Set()); } },
    );
  };

  return (
    <Card title={<span className="inline-flex items-center gap-2"><Bot className="h-4 w-4" aria-hidden />{' '}{tr('Request analysis')}</span>}>
      {!mediaReady && <Alert tone="blue">{tr('Analysis becomes available once media processing has produced the proxy (status:')}{' '}{evidence.mediaStatus}).</Alert>}
      {gated.length > 0 && (
        <Alert tone="amber" title={tr('Some analyses are disabled on this deployment')}>
          <ul className="list-disc pl-5" data-testid="ai-gated-tasks">
            {gated.map((t) => <li key={t.task}>{t.gate.explanation ?? tr('{label} is disabled.', { label: t.label })}</li>)}
          </ul>
        </Alert>
      )}
      {available.length === 0 ? (
        <EmptyState title={gated.length ? tr('No AI analysis is available') : tr('No AI models are active')}description={tr('An administrator must register and activate models before analysis can run.')} />
      ) : (
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <fieldset>
            <legend className="mb-2 text-sm font-medium text-ink-800">{tr('Tasks')}</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {available.map((t) => (
                <div key={t.task} className="rounded border border-ink-200 p-2">
                  <Checkbox
                    label={t.label}
                    description={tr('{description} Model: {value}', { description: t.description, value: t.models.map((m) => `${m.code}@${m.version}`).join(', ') })}
                    checked={sel.has(t.task)}
                    onChange={(v) => setSel((s) => { const n = new Set(s); if (v) n.add(t.task); else n.delete(t.task); return n; })}
                  />
                  {sel.has(t.task) && (
                    <div className="mt-2 pl-6">
                      <Field label={tr('Threshold')} htmlFor={`thr-${t.task}`} hint={tr('Default {defaultThreshold}', { defaultThreshold: t.models[0]?.defaultThreshold })}>
                        <Input id={`thr-${t.task}`} type="number" step="0.01" min={0.05} max={0.99} placeholder={String(t.models[0]?.defaultThreshold ?? '')} value={thresholds[t.task] ?? ''} onChange={(e) => setThresholds((x) => ({ ...x, [t.task]: e.target.value }))} className="w-28" />
                      </Field>
                    </div>
                  )}
                </div>
              ))}
            </div>
            {unavailable.length > 0 && <p className="mt-2 text-xs text-ink-500">{tr('Unavailable (no active model):')}{' '}{unavailable.map((t) => t.label).join(', ')}</p>}
          </fieldset>
          <Field label={tr('Frames sampled per second')} htmlFor="ai-fps" error={fpsErr} hint={tr('Higher = more thorough and slower (CPU inference).')}>
            <Input id="ai-fps" type="number" step="0.1" min={AI_SAMPLE_FPS.min} max={AI_SAMPLE_FPS.max} value={fps} onChange={(e) => setFps(e.target.value)} className="w-28" />
          </Field>
          {needsLists && (
            <fieldset>
              <legend className="mb-1 text-sm font-medium text-ink-800">{tr('Watchlists covering this jurisdiction')}</legend>
              {watchlists.isLoading ? <Spinner /> : watchlists.error ? <ErrorState error={watchlists.error} onRetry={() => void watchlists.refetch()} /> : watchlists.data!.items.length === 0 ? (
                <p className="text-sm text-ink-600">{tr('No watchlists apply to this evidence.')}{sel.has('FACE_RECOGNITION') && tr(' Face recognition needs a FACE watchlist.')}</p>
              ) : (
                <div className="space-y-1">
                  {watchlists.data!.items.map((w) => (
                    <Checkbox key={w.id} label={tr('{name} ({value}, {readyEntries}/{entries} ready, {orgUnitName})', { name: w.name, value: w.kind === 'FACE' ? tr('faces') : tr('vehicles'), readyEntries: w.readyEntries, entries: w.entries, orgUnitName: w.orgUnitName })} checked={lists ? lists.has(w.id) : true}
                      onChange={(v) => setLists((s) => { const n = new Set(s ?? watchlists.data!.items.map((x) => x.id)); if (v) n.add(w.id); else n.delete(w.id); return n; })} />
                  ))}
                </div>
              )}
            </fieldset>
          )}
          {request.error && <Alert tone="red" title={tr('Could not queue analysis')}>{errorMessage(request.error)}</Alert>}
          <Button type="submit" disabled={!sel.size || !!fpsErr || !!thrErr || !mediaReady} loading={request.isPending} icon={<Play className="h-4 w-4" aria-hidden />}>
            {tr('Run analysis')}
          </Button>
        </form>
      )}
    </Card>
  );
}

function JobsCard({ evidenceId, canCancel }: { evidenceId: string; canCancel: boolean }) {
  const q = useEvidenceJobs(evidenceId);
  const cancel = useCancelJob(evidenceId);
  const [confirm, setConfirm] = useState<AiJobDto | null>(null);
  return (
    <Card title={tr('Analysis jobs')}>
      {q.isLoading ? <Spinner /> : q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : !q.data!.items.length ? (
        <EmptyState title={tr('No analysis yet')} description={tr('Request an analysis above to run AI models on the derived proxy of this video.')} />
      ) : (
        <ul className="divide-y divide-ink-100">
          {q.data!.items.map((j) => (
            <li key={j.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
              <StatusBadge status={j.status} />
              <span className="font-medium text-ink-800">{j.tasks.map(taskLabel).join(', ')}</span>
              <span className="text-xs text-ink-500">{formatDateTime(j.createdAt)} · {j.requestedBy.fullName} · {j.params.sampleFps}{' '}{tr('fps ·')}{' '}{j.models.map((m) => `${m.code}@${m.version}`).join(', ')}</span>
              {(j.status === 'RUNNING' || j.status === 'QUEUED') && (
                <div className="flex w-56 items-center gap-2"><ProgressBar value={j.progress} label={tr('Analysis progress')} /><span className="text-xs tabular-nums text-ink-600">{Math.round(j.progress * 100)}%</span></div>
              )}
              {j.status === 'COMPLETED' && (
                <span className="text-xs text-ink-600">
                  {j.stats.framesProcessed}{' '}{tr('frames ·')}{' '}{Object.entries(j.stats.detections ?? {}).map(([t, n]) => `${n} ${taskLabel(t).toLowerCase()}`).join(', ') || tr('no detections')} · {j.stats.msPerFrame}{' '}{tr('ms/frame')}
                </span>
              )}
              {j.status === 'FAILED' && <span className="text-xs text-red-700">{j.error}</span>}
              {canCancel && (j.status === 'RUNNING' || j.status === 'QUEUED') && (
                <Button size="sm" variant="secondary" icon={<XCircle className="h-4 w-4" aria-hidden />} onClick={() => setConfirm(j)}>{tr('Cancel')}</Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog open={!!confirm} title={tr('Cancel analysis?')} message={tr('The worker stops at the next checkpoint; detections produced so far are kept (pending review).')} confirmLabel={tr('Cancel job')} variant="danger"
        loading={cancel.isPending} error={cancel.error} onCancel={() => setConfirm(null)} onConfirm={() => cancel.mutate(confirm!.id, { onSuccess: () => setConfirm(null) })} />
    </Card>
  );
}

const FILTERS = { task: '', reviewStatus: '', minConfidence: '' };

function DetectionsCard({ evidence, canPlay }: { evidence: EvidenceDetail; canPlay: boolean }) {
  const [f, setF] = useState(FILTERS);
  const q = useDetections(evidence.id, f);
  const navigate = useNavigate();
  const player = useRef<EvidencePlayerHandle>(null);
  const [now, setNow] = useState(0);
  const [showPlayer, setShowPlayer] = useState(false);
  const items = useMemo(() => q.data?.items ?? [], [q.data]);
  const groups = useMemo(() => {
    const m = new Map<AiTask, AiDetectionDto[]>();
    for (const d of items) m.set(d.task, [...(m.get(d.task) ?? []), d]);
    return [...m.entries()];
  }, [items]);
  const duration = evidence.durationMs ?? Math.max(1, ...items.map((d) => d.frameTimeMs + 1000));
  const open = (d: AiDetectionDto) => {
    if (showPlayer && player.current) player.current.seek(d.frameTimeMs);
    else navigate(`/evidence/${evidence.id}?tab=playback&t=${d.frameTimeMs}`);
  };
  const visible = items.filter((d) => d.bbox && Math.abs(d.frameTimeMs - now) <= 600);

  return (
    <Card title={q.data ? tr('Detections ({total})', { total: q.data.total }) : tr('Detections')} actions={canPlay && items.length > 0 ? <Button size="sm" variant="secondary" onClick={() => setShowPlayer((v) => !v)}>{showPlayer ? tr('Hide player') : tr('Show on video')}</Button> : undefined}>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <Field label={tr('Task')} htmlFor="d-task">
          <Select id="d-task" value={f.task} onChange={(e) => setF({ ...f, task: e.target.value })}>
            <option value="">{tr('All tasks')}</option>
            {(['PERSON_DETECTION', 'OBJECT_DETECTION', 'FACE_DETECTION', 'FACE_RECOGNITION', 'ANPR', 'CLASSIFICATION'] as AiTask[]).map((t) => <option key={t} value={t}>{taskLabel(t)}</option>)}
          </Select>
        </Field>
        <Field label={tr('Review status')} htmlFor="d-rs">
          <Select id="d-rs" value={f.reviewStatus} onChange={(e) => setF({ ...f, reviewStatus: e.target.value })}>
            <option value="">{tr('Any')}</option>
            <option value="PENDING">{tr('Pending')}</option>
            <option value="NEEDS_SECOND_REVIEW">{tr('Needs 2nd review')}</option>
            <option value="APPROVED">{tr('Approved')}</option>
            <option value="REJECTED">{tr('Rejected')}</option>
          </Select>
        </Field>
        <Field label={tr('Min confidence')} htmlFor="d-mc">
          <Input id="d-mc" type="number" step="0.05" min={0} max={1} value={f.minConfidence} onChange={(e) => setF({ ...f, minConfidence: e.target.value })} className="w-24" />
        </Field>
      </div>
      {q.isLoading ? <Spinner /> : q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : !items.length ? (
        <EmptyState title={tr('No detections')} description={tr('Completed analyses with matching results appear here.')} />
      ) : (
        <div className="space-y-4">
          {showPlayer && (
            <EvidencePlayer ref={player} evidenceId={evidence.id} onTimeUpdate={setNow} maxHeight="50vh"
              markers={items.slice(0, 300).map((d) => ({ timeMs: d.frameTimeMs, label: `${taskLabel(d.task)}: ${d.label}`, color: TASK_COLORS[d.task] }))}
              overlays={
                <svg viewBox="0 0 1 1" preserveAspectRatio="none" className="h-full w-full" aria-hidden>
                  {visible.map((d) => (
                    <rect key={d.id} x={d.bbox!.x} y={d.bbox!.y} width={d.bbox!.w} height={d.bbox!.h} fill="none" stroke={TASK_COLORS[d.task]} strokeWidth={0.004} vectorEffect="non-scaling-stroke" />
                  ))}
                </svg>
              }
            />
          )}
          <Timeline items={items} durationMs={duration} onPick={open} />
          {groups.map(([task, list]) => (
            <section key={task} aria-label={taskLabel(task)}>
              <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink-800">
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: TASK_COLORS[task] }} aria-hidden />
                {taskLabel(task)} <Badge>{list.length}</Badge>
              </h3>
              <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {list.map((d) => (
                  <li key={d.id}>
                    <button type="button" onClick={() => open(d)} className="flex w-full items-start gap-3 rounded border border-ink-200 p-2 text-left hover:bg-ink-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600">
                      <CropThumb d={d} size="sm" />
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate font-medium text-ink-900">{d.correctedLabel ?? d.label}</span>
                          {d.correctedLabel && <span className="text-xs text-ink-500 line-through">{d.label}</span>}
                          <ReviewBadge status={d.reviewStatus} />
                        </div>
                        <ConfidenceBar value={d.confidence} threshold={d.threshold} />
                        <div className="text-xs text-ink-500">{tr('at')}{' '}<span className="mono">{formatTimecode(d.frameTimeMs)}</span> · {d.model.code}@{d.model.version}</div>
                        <Attributes a={d.attributes} />
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          <p className="text-xs text-ink-500">{tr('Review these results in the')}{' '}<Link className="text-brand-700 hover:underline" to={`/review?evidenceId=${evidence.id}`}>{tr('review queue')}</Link>.</p>
        </div>
      )}
    </Card>
  );
}

function Timeline({ items, durationMs, onPick }: { items: AiDetectionDto[]; durationMs: number; onPick: (d: AiDetectionDto) => void }) {
  const tasks = [...new Set(items.map((d) => d.task))];
  return (
    <div className="space-y-1" role="group" aria-label={tr('Detections timeline')}>
      {tasks.map((t) => (
        <div key={t} className="flex items-center gap-2">
          <span className="w-40 shrink-0 truncate text-xs text-ink-600">{taskLabel(t)}</span>
          <div className="relative h-4 flex-1 rounded bg-ink-100">
            {items.filter((d) => d.task === t).map((d) => (
              <button key={d.id} type="button" title={tr('{label} at {frameTimeMs} ({value}%)', { label: d.label, frameTimeMs: formatTimecode(d.frameTimeMs), value: Math.round(d.confidence * 100) })} aria-label={tr('{label} at {frameTimeMs}', { label: d.label, frameTimeMs: formatTimecode(d.frameTimeMs) })}
                onClick={() => onPick(d)} className="absolute top-0 h-4 w-1.5 -translate-x-1/2 rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
                style={{ left: `${Math.min(100, (d.frameTimeMs / durationMs) * 100)}%`, background: TASK_COLORS[d.task], opacity: d.reviewStatus === 'REJECTED' ? 0.3 : 1 }} />
            ))}
          </div>
        </div>
      ))}
      <div className="ml-[10.5rem] flex justify-between text-[10px] text-ink-500"><span>0:00</span><span>{formatTimecode(durationMs)}</span></div>
    </div>
  );
}
