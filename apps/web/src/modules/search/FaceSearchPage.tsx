/**
 * Suspect (face) search across the whole evidence repository (tender §20). Upload a photo → the isolated AI worker
 * embeds the face and matches it against every stored face; results are limited to evidence the user may see.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ScanFace, Upload } from 'lucide-react';
import { api } from '@/lib/api';
import { t } from '@/lib/i18n';
import { formatDateTime, formatTimecode } from '@/lib/format';
import { Alert, Badge, Button, Card, EmptyState, ErrorState, Field, Input, PageHeader, ProgressBar, Spinner, StatusBadge } from '@/components/ui';

interface FaceSearchMatch {
  detectionId: string;
  evidenceId: string;
  evidenceNumber: string | null;
  title: string | null;
  orgUnitName: string | null;
  recordedAt: string | null;
  similarity: number;
  frameTimeMs: number | null;
  cropUrl: string | null;
  reviewStatus: string;
}
interface FaceSearch {
  id: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  createdAt: string;
  finishedAt: string | null;
  params: { threshold?: number; limit?: number };
  stats: { candidates?: number; probeFaces?: number; scanMs?: number; totalMs?: number } | null;
  error: string | null;
  matches: FaceSearchMatch[];
  hiddenMatches: number;
  probeUrl: string | null;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export function FaceSearchPage() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [threshold, setThreshold] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!file) return setPreview(null);
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const create = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error(t('Choose a photo first'));
      const imageBase64 = await fileToDataUrl(file);
      return api.post<{ id: string }>('/ai/face-searches', { imageBase64, threshold: threshold ? Number(threshold) : undefined, limit: 50 });
    },
    onSuccess: (r) => setActiveId(r.id),
  });

  const search = useQuery({
    queryKey: ['face-search', activeId],
    queryFn: () => api.get<FaceSearch>(`/ai/face-searches/${activeId}`),
    enabled: !!activeId,
    refetchInterval: (q) => (q.state.data && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(q.state.data.status) ? false : 1500),
  });
  const history = useQuery({ queryKey: ['face-searches'], queryFn: () => api.get<{ items: FaceSearch[] }>('/ai/face-searches') });

  const s = search.data;
  const running = s && (s.status === 'QUEUED' || s.status === 'RUNNING');

  return (
    <div className="space-y-5">
      <PageHeader title={t('Suspect search by face')} subtitle={t('Upload a photograph of a person; every face detected in the evidence repository is compared and the closest matches you are allowed to see are listed. Matches are AI suggestions until a reviewer confirms them.')} />
      <div className="grid gap-5 lg:grid-cols-[22rem_1fr]">
        <Card title={t('Probe photograph')}>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              className="flex aspect-square w-full items-center justify-center overflow-hidden rounded-md border-2 border-dashed border-ink-300 bg-ink-50 text-sm text-ink-500 hover:border-brand-400"
              aria-label={t('Choose a photo')}
            >
              {preview ? <img src={preview} alt={t('Selected probe photo')} className="h-full w-full object-contain" /> : (
                <span className="flex flex-col items-center gap-2">
                  <Upload className="h-6 w-6" aria-hidden />
                  {t('Click to choose a JPEG or PNG (max 3 MB)')}
                </span>
              )}
            </button>
            <input ref={fileInput} type="file" accept="image/jpeg,image/png" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <Field label={t('Similarity threshold (optional)')} htmlFor="fs-thr" hint={t('0–1; leave empty to use the model default. Lower values return more, weaker matches.')}>
              <Input id="fs-thr" inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} placeholder={t('model default')} />
            </Field>
            <Button type="submit" className="w-full" loading={create.isPending} disabled={!file} icon={<ScanFace className="h-4 w-4" aria-hidden />}>
              {t('Search repository')}
            </Button>
            {create.error ? <Alert tone="red">{(create.error as Error).message}</Alert> : null}
            <p className="text-xs text-ink-500">{t('Every search is recorded in the audit trail with your identity, the time and the number of matches.')}</p>
          </form>
        </Card>
        <div className="space-y-4">
          {!activeId && <EmptyState icon={<ScanFace className="h-10 w-10" aria-hidden />} title={t('No search yet')} description={t('Choose a probe photo and start a search. Typical repository scans complete in a few seconds.')} />}
          {activeId && search.isLoading && <Spinner label={t('Submitting…')} />}
          {search.error && <ErrorState error={search.error} onRetry={() => void search.refetch()} />}
          {s && running && (
            <Card title={t('Searching…')}>
              <ProgressBar value={s.status === 'RUNNING' ? 0.6 : 0.2} label={t('Face search progress')} />
              <p className="mt-2 text-sm text-ink-600">{s.status === 'QUEUED' ? t('Waiting for the AI worker…') : t('Embedding the probe face and scanning stored faces…')}</p>
            </Card>
          )}
          {s && s.status === 'FAILED' && <Alert tone="red" title={t('Search failed')}>{s.error}</Alert>}
          {s && s.status === 'COMPLETED' && (
            <Card
              title={t('Matches')}
              actions={
                <span className="text-xs text-ink-500">
                  {t('{n} faces compared in {ms} ms', { n: (s.stats?.candidates ?? 0).toLocaleString(), ms: s.stats?.scanMs ?? 0 })}
                  {s.hiddenMatches > 0 ? ` · ${t('{n} match(es) outside your access are not shown', { n: s.hiddenMatches })}` : ''}
                </span>
              }
              bodyClassName="p-0"
            >
              {s.matches.length === 0 ? (
                <EmptyState title={t('No matching faces')} description={t('Nothing above the threshold among the faces you are allowed to see. Try a clearer frontal photo or a lower threshold.')} />
              ) : (
                <ul className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
                  {s.matches.map((m) => (
                    <li key={m.detectionId} className="flex gap-3 rounded-md border border-ink-200 p-2">
                      <div className="h-24 w-20 shrink-0 overflow-hidden rounded bg-ink-100">
                        {m.cropUrl ? <img src={m.cropUrl} alt="" className="h-full w-full object-cover" /> : null}
                      </div>
                      <div className="min-w-0 flex-1 text-sm">
                        <div className="flex items-center justify-between gap-2">
                          <Badge tone={m.similarity >= 0.6 ? 'green' : 'amber'}>{Math.round(m.similarity * 100)}%</Badge>
                          <StatusBadge status={m.reviewStatus} />
                        </div>
                        <Link to={`/evidence/${m.evidenceId}?tab=playback&t=${m.frameTimeMs ?? 0}`} className="mt-1 block truncate font-medium text-brand-700 hover:underline">
                          {m.evidenceNumber ?? m.evidenceId.slice(0, 8)}
                        </Link>
                        <p className="truncate text-xs text-ink-600">{m.title ?? '—'}</p>
                        <p className="text-xs text-ink-500">
                          {m.orgUnitName ?? ''} · {m.frameTimeMs !== null ? formatTimecode(m.frameTimeMs) : '—'} · {formatDateTime(m.recordedAt)}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
          <Card title={t('Recent searches')} bodyClassName="p-0">
            {history.isLoading ? <Spinner /> : !history.data?.items.length ? <EmptyState title={t('No previous searches')} /> : (
              <ul className="divide-y divide-ink-100 text-sm">
                {history.data.items.map((h) => (
                  <li key={h.id} className="flex items-center justify-between gap-3 px-4 py-2">
                    <button type="button" className="text-left text-brand-700 hover:underline" onClick={() => setActiveId(h.id)}>
                      {formatDateTime(h.createdAt)}
                    </button>
                    <span className="text-xs text-ink-500">{h.status === 'COMPLETED' ? t('{n} match(es)', { n: h.matches.length }) : ''}</span>
                    <StatusBadge status={h.status} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
