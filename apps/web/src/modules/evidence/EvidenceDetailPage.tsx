import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Lock, ShieldCheck } from 'lucide-react';
import type { Permission } from '@ksp/shared';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useUrlState } from '@/lib/hooks';
import { EVIDENCE_ACTIONS, EVIDENCE_TABS } from '@/lib/extensions';
import { formatDateTime, titleCase } from '@/lib/format';
import { Alert, Badge, CopyButton, EmptyState, ErrorState, PageHeader, Spinner, StatusBadge, Tabs } from '@/components/ui';
import { PERMISSION_FLAGS, evidenceKey, type EvidenceDetail } from './types';

const TAB_DEFAULTS = { tab: '' };

export function useEvidenceDetail(id: string) {
  return useQuery({
    queryKey: evidenceKey(id),
    queryFn: () => api.get<EvidenceDetail>(`/evidence/${id}`),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
  });
}

/** Visible when the user holds ANY listed permission AND (where the API computes one) the per-evidence flag allows it. */
export function allowedFor(anyOf: Permission[] | undefined, canAny: (...p: Permission[]) => boolean, ev: EvidenceDetail): boolean {
  if (!anyOf?.length) return true;
  return anyOf.some((perm) => {
    if (!canAny(perm)) return false;
    const flag = PERMISSION_FLAGS[perm];
    return flag ? ev.permissions[flag] : true;
  });
}

function HashRow({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="flex min-w-0 items-center gap-2 text-xs">
      <span className="w-14 shrink-0 font-medium uppercase text-ink-500">{label}</span>
      <code className="mono truncate text-ink-800" title={value}>{value}</code>
      <CopyButton value={value} label={`Copy ${label}`} />
    </div>
  );
}

export function EvidenceDetailPage() {
  const { id = '' } = useParams();
  const { canAny } = useAuth();
  const [url, setUrl] = useUrlState(TAB_DEFAULTS);
  const q = useEvidenceDetail(id);

  if (q.isLoading) return <Spinner label="Loading evidence…" />;
  if (q.error) {
    if (q.error instanceof ApiError && q.error.status === 404) {
      return <EmptyState heading="h1" title="Evidence not found" description="It does not exist or is outside your jurisdiction." action={<Link className="text-brand-700 hover:underline" to="/evidence">Back to evidence</Link>} />;
    }
    return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  }
  const ev = q.data!;
  const tabs = EVIDENCE_TABS.filter((t) => allowedFor(t.anyOf, canAny, ev));
  const actions = EVIDENCE_ACTIONS.filter((a) => allowedFor(a.anyOf, canAny, ev));
  const active = tabs.find((t) => t.id === url.tab) ?? tabs[0];
  const ActiveTab = active?.component;

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumb={<Link to="/evidence" className="hover:underline">Evidence</Link>}
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span className="mono">{ev.evidenceNumber ?? 'Unnumbered'}</span>
            <StatusBadge status={ev.status} />
            {ev.legalHold && (
              <Badge tone="red">
                <Lock className="mr-1 h-3 w-3" aria-hidden />
                Legal hold
              </Badge>
            )}
            <Badge tone="gray">{titleCase(ev.storageTier)} tier</Badge>
          </span>
        }
        subtitle={
          <span>
            {ev.title ?? 'Untitled'} · {ev.orgUnit.name} · recorded {formatDateTime(ev.recordedAt)}
          </span>
        }
        actions={
          actions.length ? (
            <div className="flex flex-wrap gap-2">
              {actions.map((a) => (
                <a.component key={a.id} evidence={ev} />
              ))}
            </div>
          ) : undefined
        }
      />
      {ev.legalHold && (
        <Alert tone="red" title="Under legal hold">
          {ev.legalHoldReason} — placed by {ev.legalHoldBy?.fullName ?? 'unknown'} on {formatDateTime(ev.legalHoldAt)}. Disposal is blocked until the hold is released.
        </Alert>
      )}
      {ev.status === 'DISPOSED' && (
        <Alert tone="amber" title="Disposed">
          The original and derived media were destroyed on {formatDateTime(ev.disposedAt)} under an authorised disposal. This record and its chain of custody are retained permanently.
        </Alert>
      )}
      {ev.status === 'DISPOSAL_PENDING' && <Alert tone="amber" title="Disposal pending">A disposal request is awaiting a decision by an authorised approver.</Alert>}
      <div className="card space-y-1 px-4 py-3">
        <div className="mb-1 flex items-center gap-2 text-sm font-medium text-ink-700">
          <ShieldCheck className="h-4 w-4 text-emerald-700" aria-hidden />
          Registered hashes
          <span className="text-xs font-normal text-ink-500">{ev.lastVerifiedAt ? `last verified ${formatDateTime(ev.lastVerifiedAt)}` : 'not yet re-verified'}</span>
        </div>
        <HashRow label="SHA-256" value={ev.sha256} />
        <HashRow label="SHA-512" value={ev.sha512} />
      </div>
      {tabs.length > 0 && active && (
        <div>
          <Tabs tabs={tabs.map((t) => ({ id: t.id, label: t.label }))} value={active.id} onChange={(tab) => setUrl({ tab: tab === tabs[0]?.id ? '' : tab })} />
          <div role="tabpanel" aria-label={active.label}>
            {ActiveTab && <ActiveTab evidence={ev} />}
          </div>
        </div>
      )}
    </div>
  );
}
