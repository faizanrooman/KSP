/** Small presentational pieces shared by the AI tab and the review queue. */
import type { ReactNode } from 'react';
import { ImageOff } from 'lucide-react';
import { AI_TASK_INFO, type AiDetectionDto, type AiTask, type ReviewStatus } from '@ksp/shared';
import { Badge, clsx, type Tone } from '@/components/ui';

import { t as tr } from '@/lib/i18n';
export const taskLabel = (t: AiTask | string) => AI_TASK_INFO[t as AiTask]?.label ?? t;

export const TASK_COLORS: Record<AiTask, string> = {
  PERSON_DETECTION: '#2563eb',
  OBJECT_DETECTION: '#7c3aed',
  FACE_DETECTION: '#0891b2',
  FACE_RECOGNITION: '#dc2626',
  ANPR: '#d97706',
  CLASSIFICATION: '#059669',
};

const REVIEW_TONE: Record<ReviewStatus, Tone> = { PENDING: 'amber', APPROVED: 'green', REJECTED: 'red', NEEDS_SECOND_REVIEW: 'purple' };
const REVIEW_TEXT: Record<ReviewStatus, string> = { PENDING: 'Pending review', APPROVED: 'Approved', REJECTED: 'Rejected', NEEDS_SECOND_REVIEW: 'Needs 2nd review' };

export function ReviewBadge({ status }: { status: ReviewStatus }) {
  return <Badge tone={REVIEW_TONE[status]}>{REVIEW_TEXT[status]}</Badge>;
}

/** Confidence bar with the threshold tick and a numeric label (not colour-only). */
export function ConfidenceBar({ value, threshold, className }: { value: number; threshold?: number; className?: string }) {
  const pct = Math.round(value * 100);
  const tone = value >= 0.8 ? 'bg-emerald-600' : value >= 0.6 ? 'bg-brand-600' : 'bg-amber-500';
  return (
    <div className={clsx('flex items-center gap-2', className)}>
      <div className="relative h-2 w-24 overflow-hidden rounded bg-ink-100" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={tr('Confidence')}>
        <div className={clsx('h-full', tone)} style={{ width: `${pct}%` }} />
        {threshold !== undefined && <div className="absolute inset-y-0 w-px bg-ink-900" style={{ left: `${Math.round(threshold * 100)}%` }} title={`Threshold ${Math.round(threshold * 100)}%`} />}
      </div>
      <span className="mono text-xs tabular-nums text-ink-700">{pct}%</span>
    </div>
  );
}

export function CropThumb({ d, size = 'md' }: { d: Pick<AiDetectionDto, 'cropUrl' | 'label' | 'task'>; size?: 'sm' | 'md' | 'lg' }) {
  const cls = size === 'sm' ? 'h-12 w-12' : size === 'lg' ? 'h-48 w-48' : 'h-24 w-24';
  if (!d.cropUrl) {
    return (
      <div className={clsx(cls, 'flex shrink-0 items-center justify-center rounded bg-ink-100 text-ink-400')} role="img" aria-label={tr('No crop available')}>
        <ImageOff className="h-5 w-5" aria-hidden />
      </div>
    );
  }
  return <img src={d.cropUrl} alt={`${taskLabel(d.task)}: ${d.label}`} loading="lazy" className={clsx(cls, 'shrink-0 rounded bg-ink-900 object-contain')} />;
}

/** Key attributes (colour, plate, watchlist, tag basis) as readable text. */
export function Attributes({ a }: { a: Record<string, unknown> }) {
  const parts: ReactNode[] = [];
  if (typeof a.colorName === 'string') {
    parts.push(
      <span key="c" className="inline-flex items-center gap-1">
        <span className="inline-block h-3 w-3 rounded-sm ring-1 ring-ink-300" style={{ background: String(a.dominantColor) }} aria-hidden />
        {a.colorName}
      </span>,
    );
  }
  if (typeof a.plateText === 'string') parts.push(<span key="p" className="mono">{tr('plate')}{' '}{a.plateText} ({Math.round(Number(a.plateConfidence ?? 0) * 100)}{tr('% OCR)')}</span>);
  if (a.watchlistHit || a.watchlistEntryId) parts.push(<Badge key="w" tone="red">{tr('Watchlist')}{' '}{a.watchlistLabel ? `: ${String(a.watchlistLabel)}` : ''}</Badge>);
  if (typeof a.similarity === 'number') parts.push(<span key="s">{tr('similarity')}{' '}{a.similarity.toFixed(3)}</span>);
  if (a.basis && typeof a.basis === 'object') {
    const b = a.basis as Record<string, unknown>;
    parts.push(<span key="b">{b.maxPersonsInFrame ? `${String(b.maxPersonsInFrame)} persons in one frame` : `from ${String(b.label)} (${String(b.observations)} obs.)`}</span>);
  }
  if (typeof a.observations === 'number' && a.observations > 1) parts.push(<span key="o">{a.observations}{' '}{tr('frames')}</span>);
  if (!parts.length) return null;
  return <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-600">{parts}</div>;
}
