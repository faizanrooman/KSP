import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Camera, Download, ExternalLink } from 'lucide-react';
import type { EvidenceSummary } from '@/lib/extensions';
import { useAuth } from '@/lib/auth';
import { errorMessage } from '@/lib/api';
import { formatDateTime, formatDuration, formatTimecode, parseTimeInput, shortHash } from '@/lib/format';
import { Button, Card, CopyButton, EmptyState, ErrorState, Field, Input, KeyValue, Select, Spinner, useToast } from '@/components/ui';
import { EvidencePlayer } from './EvidencePlayer';
import { useCreateSnapshot, usePlayback, useSnapshots } from './api';

// Kept here for existing importers; lives in @/lib/format so eager code need not pull in the video chunk.
export { parseTimeInput };

export function PlaybackTab({ evidence }: { evidence: EvidenceSummary }) {
  const [params] = useSearchParams();
  const t = Number(params.get('t'));
  const initial = Number.isFinite(t) && t > 0 ? t : undefined;
  const pb = usePlayback(evidence.id);
  const d = pb.data;
  return (
    <div className="space-y-4">
      <EvidencePlayer evidenceId={evidence.id} initialTimeMs={initial} />
      <div className="flex justify-end">
        <Link to={`/evidence/${evidence.id}/player${initial ? `?t=${initial}` : ''}`} className="inline-flex items-center gap-1 text-sm text-brand-700 hover:underline">
          <ExternalLink className="h-4 w-4" aria-hidden /> Open full-page player
        </Link>
      </div>
      <Card title="Technical information">
        <KeyValue
          columns={3}
          items={[
            { label: 'Media status', value: d?.mediaStatus ?? evidence.mediaStatus },
            { label: 'Duration', value: d?.durationMs ? `${formatDuration(d.durationMs)} (${formatTimecode(d.durationMs)})` : formatDuration(evidence.durationMs) },
            { label: 'Source resolution', value: d?.sourceWidth ? `${d.sourceWidth} × ${d.sourceHeight}` : evidence.width ? `${evidence.width} × ${evidence.height}` : '—' },
            { label: 'Source frame rate', value: d?.sourceFrameRate ? `${d.sourceFrameRate} fps${d.sourceVfr ? ' (variable)' : ''}` : evidence.frameRate ? `${evidence.frameRate} fps` : '—' },
            { label: 'Playback proxy', value: d?.width ? `${d.width} × ${d.height} @ ${d.frameRate} fps (H.264, constant frame rate)` : '—' },
            { label: 'Adaptive renditions', value: d?.renditions?.length ? d.renditions.map((r) => `${r.name} (${r.width}×${r.height})`).join(', ') : '—' },
            { label: 'Original SHA-256', value: evidence.sha256 ?? '—', mono: true },
          ]}
        />
        {d?.sourceVfr && (
          <p className="mt-3 text-xs text-ink-500">
            The original has a variable frame rate. Playback uses a constant-frame-rate proxy; frame numbers refer to the proxy, and timestamps are the authoritative reference to the original.
          </p>
        )}
      </Card>
    </div>
  );
}

export function SnapshotsTab({ evidence }: { evidence: EvidenceSummary }) {
  const { can } = useAuth();
  const toast = useToast();
  const list = useSnapshots(evidence.id);
  const create = useCreateSnapshot(evidence.id);
  const [time, setTime] = useState('00:00.000');
  const [source, setSource] = useState<'proxy' | 'original'>('proxy');
  const parsed = parseTimeInput(time);
  const flags = (evidence as EvidenceSummary & { permissions?: { canSnapshot?: boolean } }).permissions;
  const canCreate = can('evidence:snapshot') && flags?.canSnapshot !== false && evidence.mediaStatus === 'READY';

  return (
    <div className="space-y-4">
      {canCreate && (
        <Card title="Create snapshot">
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (parsed === null) return;
              create.mutate({ timeMs: parsed, source }, {
                onSuccess: (s) => toast.success(`Snapshot saved — frame ${s.frameNumber ?? '?'}`),
                onError: (err) => toast.error(errorMessage(err)),
              });
            }}
          >
            <Field label="Time (mm:ss.mmm)" htmlFor="snap-time" error={parsed === null ? 'Enter a time such as 01:23.456' : null}>
              <Input id="snap-time" value={time} onChange={(e) => setTime(e.target.value)} className="mono w-40" />
            </Field>
            <Field label="Extract from" htmlFor="snap-source">
              <Select id="snap-source" value={source} onChange={(e) => setSource(e.target.value as 'proxy' | 'original')}>
                <option value="proxy">Playback proxy (frame-exact)</option>
                <option value="original">Original file (full resolution)</option>
              </Select>
            </Field>
            <Button type="submit" icon={<Camera className="h-4 w-4" />} loading={create.isPending} disabled={parsed === null}>
              Create snapshot
            </Button>
          </form>
          <p className="mt-2 text-xs text-ink-500">Tip: in the player press <kbd className="mono">S</kbd> to capture the exact frame on screen. Every snapshot is recorded in the chain of custody with its SHA-256.</p>
        </Card>
      )}
      {list.isLoading ? (
        <Spinner />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : !list.data?.items.length ? (
        <EmptyState title="No snapshots yet" description={canCreate ? 'Capture frames from the player or at a specific time above.' : 'Snapshots created by investigators appear here.'} icon={<Camera className="h-8 w-8" />} />
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Snapshots">
          {list.data.items.map((s) => (
            <li key={s.id} className="card overflow-hidden">
              <a href={s.url} target="_blank" rel="noreferrer" className="block bg-black" aria-label={`Open snapshot at ${formatTimecode(s.frameTimeMs ?? s.timeMs ?? 0)} in a new tab`}>
                <img src={s.url} alt={`Frame ${s.frameNumber ?? ''} at ${formatTimecode(s.frameTimeMs ?? s.timeMs ?? 0)}`} className="mx-auto max-h-48 object-contain" loading="lazy" />
              </a>
              <div className="space-y-1 p-3 text-xs">
                <div className="flex items-center justify-between">
                  <span className="mono font-medium text-ink-900">{formatTimecode(s.frameTimeMs ?? s.timeMs ?? 0)}</span>
                  <span className="text-ink-600">Frame {s.frameNumber ?? '—'} · {s.source === 'original' ? 'original' : 'proxy'}</span>
                </div>
                <div className="flex items-center gap-1 text-ink-600">
                  <span className="mono" title={s.sha256 ?? ''}>SHA-256 {shortHash(s.sha256)}</span>
                  {s.sha256 && <CopyButton value={s.sha256} label="Copy hash" />}
                </div>
                <div className="text-ink-500">{s.width}×{s.height} · {s.createdBy?.name ?? 'System'} · {formatDateTime(s.createdAt)}</div>
                <div className="flex gap-2 pt-1">
                  <Link to={`/evidence/${evidence.id}?tab=playback&t=${Math.round(s.frameTimeMs ?? s.timeMs ?? 0) + 1}`} className="text-brand-700 hover:underline">Show in player</Link>
                  <a href={s.downloadUrl} className="inline-flex items-center gap-1 text-brand-700 hover:underline"><Download className="h-3.5 w-3.5" aria-hidden /> Download PNG</a>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
