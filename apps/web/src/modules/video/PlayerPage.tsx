import { useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatTimecode } from '@/lib/format';
import { CopyButton, PageHeader } from '@/components/ui';
import { EvidencePlayer, type EvidencePlayerHandle } from './EvidencePlayer';

/** Full-page player: /evidence/:id/player?t=<ms> */
export function PlayerPage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const t = Number(params.get('t'));
  const player = useRef<EvidencePlayerHandle>(null);
  const [now, setNow] = useState(0);
  // Title is optional decoration; the evidence detail endpoint is owned by the evidence module.
  const ev = useQuery({
    queryKey: ['evidence', id, 'summary'],
    queryFn: () => api.get<{ evidenceNumber: string | null; title: string | null }>(`/evidence/${id}`),
    retry: false,
    enabled: /^[0-9a-f-]{36}$/i.test(id),
  });
  const link = `${window.location.origin}/evidence/${id}/player?t=${Math.round(now)}`;
  return (
    <div className="space-y-4">
      <PageHeader
        title={ev.data?.evidenceNumber ?? 'Evidence player'}
        subtitle={ev.data?.title ?? undefined}
        breadcrumb={<Link to={`/evidence/${id}`} className="text-brand-700 hover:underline">← Back to evidence</Link>}
        actions={
          <span className="flex items-center gap-2 text-xs text-ink-600">
            Link to <span className="mono">{formatTimecode(now)}</span>
            <CopyButton value={link} label="Copy link" />
          </span>
        }
      />
      <EvidencePlayer ref={player} evidenceId={id} initialTimeMs={Number.isFinite(t) && t > 0 ? t : undefined} onTimeUpdate={(ms) => setNow(ms)} maxHeight="max(15rem, calc(100vh - 18.5rem))" />
    </div>
  );
}
