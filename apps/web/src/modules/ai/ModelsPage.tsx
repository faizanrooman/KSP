/** Model registry admin (ai:models_manage): versions per task, activate / retire / threshold + metrics, training exports. */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { AI_TASKS, type AiModelDto, type AiTask } from '@ksp/shared';
import { api, buildUrl, errorMessage } from '@/lib/api';
import { formatDateTime, shortHash } from '@/lib/format';
import { Alert, Button, Card, ConfirmDialog, DataTable, EmptyState, ErrorState, Field, Input, Modal, PageHeader, Select, Spinner, StatusBadge, Textarea, useToast, type Column } from '@/components/ui';
import { aiKeys, useModels, useTrainingExports } from './api';
import { taskLabel } from './components';

export function ModelsPage() {
  const q = useModels();
  const qc = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState<{ m: AiModelDto; op: 'activate' | 'retire' } | null>(null);
  const [edit, setEdit] = useState<AiModelDto | null>(null);
  const op = useMutation({
    mutationFn: (v: { id: string; op: 'activate' | 'retire' }) => api.post<AiModelDto>(`/ai/models/${v.id}/${v.op}`),
    onSuccess: (m) => { toast.success(`${m.code}@${m.version} is now ${m.status}`); setConfirm(null); void qc.invalidateQueries({ queryKey: aiKeys.models }); void qc.invalidateQueries({ queryKey: aiKeys.tasks }); },
  });
  const cols: Column<AiModelDto>[] = [
    { key: 'task', header: 'Task', render: (m) => taskLabel(m.task) },
    { key: 'model', header: 'Model', render: (m) => <div><div className="font-medium">{m.name}</div><div className="mono text-xs text-ink-500">{m.code}@{m.version} · {m.runtime}</div></div> },
    { key: 'status', header: 'Status', render: (m) => <StatusBadge status={m.status} /> },
    { key: 'thr', header: 'Default threshold', render: (m) => m.defaultThreshold.toFixed(3) },
    { key: 'licence', header: 'Licence', render: (m) => <span className="text-xs">{String((m.config as { licence?: string }).licence ?? '—')}</span> },
    { key: 'sha', header: 'Artefact SHA-256', render: (m) => <code className="mono text-xs" title={m.artifactSha256 ?? ''}>{shortHash(m.artifactSha256)}</code> },
    { key: 'metrics', header: 'Metrics', render: (m) => <span className="text-xs">{Object.keys(m.metrics).length ? Object.entries(m.metrics).filter(([, v]) => typeof v === 'number').map(([k, v]) => `${k} ${v}`).join(', ') || 'recorded' : 'none'}</span> },
    { key: 'when', header: 'Activated', render: (m) => (m.activatedAt ? formatDateTime(m.activatedAt) : '—') },
    {
      key: 'actions', header: <span className="sr-only">Actions</span>, render: (m) => (
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" onClick={() => setEdit(m)}>Edit</Button>
          {m.status !== 'ACTIVE' && <Button size="sm" variant="secondary" onClick={() => setConfirm({ m, op: 'activate' })}>Activate</Button>}
          {m.status !== 'RETIRED' && <Button size="sm" variant="ghost" onClick={() => setConfirm({ m, op: 'retire' })}>Retire</Button>}
        </div>
      ),
    },
  ];
  return (
    <div className="space-y-4">
      <PageHeader title="AI models" subtitle="Lifecycle: evaluate → register STAGED with metrics → activate (retires the previous version) → retire. New versions are registered via the API or `npm run fetch-models`." />
      <Card>
        <DataTable columns={cols} rows={q.data?.items} rowKey={(m) => m.id} loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}
          empty={<EmptyState title="No models registered" description="Run `npm run fetch-models -w @ksp/ai-worker` on the AI host to download, verify and register the pinned models." />} />
      </Card>
      <TrainingExports />
      <ConfirmDialog open={!!confirm} title={confirm?.op === 'activate' ? 'Activate model version' : 'Retire model version'}
        message={confirm ? (confirm.op === 'activate' ? `Activate ${confirm.m.code}@${confirm.m.version}? The currently ACTIVE version of ${confirm.m.code} is retired; new jobs use this version.` : `Retire ${confirm.m.code}@${confirm.m.version}? If it is the only active model for ${taskLabel(confirm.m.task)}, that task becomes unavailable.`) : ''}
        confirmLabel={confirm?.op === 'activate' ? 'Activate' : 'Retire'} variant={confirm?.op === 'retire' ? 'danger' : 'primary'} loading={op.isPending} error={op.error}
        onCancel={() => setConfirm(null)} onConfirm={() => op.mutate({ id: confirm!.m.id, op: confirm!.op })} />
      {edit && <EditModel m={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function EditModel({ m, onClose }: { m: AiModelDto; onClose: () => void }) {
  const qc = useQueryClient();
  const [thr, setThr] = useState(String(m.defaultThreshold));
  const [metrics, setMetrics] = useState(JSON.stringify(m.metrics, null, 2));
  const [notes, setNotes] = useState(m.notes ?? '');
  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(metrics) as Record<string, unknown>; } catch { parsed = null; }
  const thrOk = Number(thr) >= 0.01 && Number(thr) <= 0.99;
  const save = useMutation({
    mutationFn: () => api.patch<AiModelDto>(`/ai/models/${m.id}`, { defaultThreshold: Number(thr), metrics: parsed, notes: notes || null }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: aiKeys.models }); onClose(); },
  });
  return (
    <Modal open size="lg" title={`Edit ${m.code}@${m.version}`} onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={!parsed || !thrOk} loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
      <div className="space-y-3">
        <Field label="Default threshold" htmlFor="em-thr" error={thrOk ? null : 'Between 0.01 and 0.99'}><Input id="em-thr" type="number" step="0.01" value={thr} onChange={(e) => setThr(e.target.value)} className="w-28" /></Field>
        <Field label="Evaluation metrics (JSON)" htmlFor="em-met" error={parsed ? null : 'Invalid JSON'} hint="Record precision/recall and the evaluation dataset before activating."><Textarea id="em-met" rows={8} className="mono" value={metrics} onChange={(e) => setMetrics(e.target.value)} /></Field>
        <Field label="Notes" htmlFor="em-notes"><Textarea id="em-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        {save.error && <Alert tone="red">{errorMessage(save.error)}</Alert>}
      </div>
    </Modal>
  );
}

function TrainingExports() {
  const q = useTrainingExports();
  const qc = useQueryClient();
  const [task, setTask] = useState<AiTask>('PERSON_DETECTION');
  const [from, setFrom] = useState(new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10));
  const [to, setTo] = useState(new Date(Date.now() + 86_400_000).toISOString().slice(0, 10));
  const create = useMutation({
    mutationFn: () => api.post('/ai/training-exports', { task, from, to }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: aiKeys.exports }),
  });
  return (
    <Card title="Training dataset exports">
      <p className="mb-3 text-sm text-ink-600">Reviewed detections (approved and label-corrected as positives, rejected as negatives) with crops, as JSONL + COCO, written to the reports bucket. Crops are evidence-derived personal data: handle under the data-protection policy.</p>
      <form className="mb-4 flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <Field label="Task" htmlFor="te-task"><Select id="te-task" value={task} onChange={(e) => setTask(e.target.value as AiTask)}>{AI_TASKS.map((t) => <option key={t} value={t}>{taskLabel(t)}</option>)}</Select></Field>
        <Field label="From" htmlFor="te-from"><Input id="te-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To" htmlFor="te-to"><Input id="te-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <Button type="submit" loading={create.isPending} disabled={!from || !to || to <= from}>Export dataset</Button>
      </form>
      {create.error && <Alert tone="red">{errorMessage(create.error)}</Alert>}
      {q.isLoading ? <Spinner /> : q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : !q.data!.items.length ? <EmptyState title="No exports yet" /> : (
        <ul className="divide-y divide-ink-100 text-sm">
          {q.data!.items.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-3 py-2">
              <StatusBadge status={e.status} />
              <span>{taskLabel(e.task)}</span>
              <span className="text-xs text-ink-500">{e.filter.from.slice(0, 10)} → {e.filter.to.slice(0, 10)} · {e.sampleCount} samples · {formatDateTime(e.createdAt)}</span>
              {e.error && <span className="text-xs text-red-700">{e.error}</span>}
              {e.files.map((f) => (
                <a key={f} className="inline-flex items-center gap-1 text-xs text-brand-700 hover:underline" href={buildUrl(`/ai/training-exports/${e.id}/files/${f}`)}><Download className="h-3.5 w-3.5" aria-hidden />{f}</a>
              ))}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
