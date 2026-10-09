import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Ellipsis, Link2, Lock, Play, Shield, ShieldCheck, ShieldX } from 'lucide-react';
import type { Permission } from '@ksp/shared';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useUrlState } from '@/lib/hooks';
import { EVIDENCE_ACTIONS, EVIDENCE_TABS } from '@/lib/extensions';
import { LazyBoundary } from '@/lib/lazy';
import { formatDateTime, titleCase } from '@/lib/format';
import { Alert, Badge, Button, CopyButton, EmptyState, ErrorState, PageHeader, Spinner, StatusBadge, Tabs, clsx } from '@/components/ui';
import type { CustodyResponse } from '@/modules/custody/CustodyTab';
import { PERMISSION_FLAGS, evidenceKey, type EvidenceDetail } from './types';

import { t as tr } from '@/lib/i18n';
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
      <CopyButton value={value} label={tr('Copy {label}', { label })} />
    </div>
  );
}

interface FixityVerdict {
  lastVerifiedAt: string | null;
  lastResult: 'OK' | 'FAILED' | null;
  pendingJob: { id: string; status: string } | null;
  items: Array<{ trigger: string; ok: boolean; checkedAt: string }>;
}

// Only a check made after ingest is a re-verification; the registration hash is the baseline it is compared with.
const RECHECK_LABEL: Record<string, string> = { SCHEDULED: 'nightly sweep', ON_DEMAND: 'on request', EXPORT: 'court export', TIER_MIGRATION: 'tier migration', RESTORE: 'restore' };

type Tone = 'good' | 'bad' | 'neutral';
const TONE: Record<Tone, string> = {
  good: 'border-emerald-200 bg-emerald-50 text-emerald-900 hover:bg-emerald-100',
  bad: 'border-red-200 bg-red-50 text-red-900 hover:bg-red-100',
  neutral: 'border-ink-200 bg-ink-50 text-ink-800 hover:bg-ink-100',
};

function VerdictChip({ tone, icon, label, detail, onClick }: { tone: Tone; icon: ReactNode; label: string; detail?: string; onClick?: () => void }) {
  return (
    <button type="button" onClick={onClick} disabled={!onClick}
      className={clsx('inline-flex min-w-0 items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-sm disabled:cursor-default', TONE[tone])}>
      <span className="shrink-0" aria-hidden>{icon}</span>
      <span className="min-w-0"><span className="font-semibold">{label}</span>{detail && <span className="block text-xs opacity-80">{detail}</span>}</span>
    </button>
  );
}

/**
 * The integrity verdict of this item, stated as results rather than as a reassuring icon: the latest fixity
 * re-hash (match / mismatch / not yet re-verified) and the whole-chain custody ledger check. Both reads are
 * plain GETs that write no audit event, so showing them on every visit adds nothing to the custody record.
 */
function IntegrityVerdict({ ev, canCustody, open }: { ev: EvidenceDetail; canCustody: boolean; open: (tab: string) => void }) {
  const fixity = useQuery({
    queryKey: ['evidence', 'integrity', ev.id],
    queryFn: () => api.get<FixityVerdict>(`/evidence/${ev.id}/integrity`),
    staleTime: 60_000,
  });
  const chain = useCustodyVerdict(ev.id, canCustody);
  const f = fixity.data;
  const recheck = f?.items.find((i) => i.trigger !== 'REGISTRATION');
  const fix = !f
    ? { tone: 'neutral' as Tone, icon: <Shield className="h-4 w-4" />, label: fixity.error ? tr('Fixity status unavailable') : tr('Checking fixity…') }
    : f.pendingJob
      ? { tone: 'neutral' as Tone, icon: <Shield className="h-4 w-4" />, label: tr('Re-verification in progress'), detail: f.lastVerifiedAt ? tr('last verified {date}', { date: formatDateTime(f.lastVerifiedAt) }) : undefined }
      : f.lastResult === 'FAILED'
        ? { tone: 'bad' as Tone, icon: <ShieldX className="h-4 w-4" />, label: tr('Fixity: hash MISMATCH'), detail: tr('checked {date}', { date: formatDateTime(f.items[0]?.checkedAt ?? f.lastVerifiedAt) }) }
        : recheck?.ok && f.lastResult === 'OK'
          ? { tone: 'good' as Tone, icon: <ShieldCheck className="h-4 w-4" />, label: tr('Fixity: hash matches'), detail: tr('re-checked {date} ({how})', { date: formatDateTime(recheck.checkedAt), how: tr(RECHECK_LABEL[recheck.trigger] ?? 'check') }) }
          : f.items.length
            ? { tone: 'neutral' as Tone, icon: <ShieldCheck className="h-4 w-4" />, label: tr('Hash recorded at ingest'), detail: tr('no later re-check yet') }
            : { tone: 'neutral' as Tone, icon: <Shield className="h-4 w-4" />, label: tr('Registered hash'), detail: tr('not yet re-verified') };
  const v = chain.data?.verification;
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label={tr('Integrity verdict')}>
      <VerdictChip {...fix} onClick={() => open('integrity')} />
      {canCustody && (
        v ? (
          v.chainIntact
            ? <VerdictChip tone="good" icon={<Link2 className="h-4 w-4" />} label={tr('Custody chain intact')} detail={tr('{count} ledger events verified', { count: v.eventsChecked })} onClick={() => open('custody')} />
            : <VerdictChip tone="bad" icon={<Link2 className="h-4 w-4" />} label={tr('Custody chain BROKEN')} detail={tr('at ledger seq {seq}', { seq: v.brokenSeqs.join(', ') })} onClick={() => open('custody')} />
        ) : <VerdictChip tone="neutral" icon={<Link2 className="h-4 w-4" />} label={chain.error ? tr('Custody status unavailable') : tr('Checking custody chain…')} onClick={() => open('custody')} />
      )}
    </div>
  );
}

/** One custody-event row is enough: the response carries the whole-chain verification and the event total. */
function useCustodyVerdict(id: string, enabled: boolean) {
  return useQuery({
    queryKey: ['custody', 'verdict', id],
    queryFn: () => api.get<CustodyResponse>(`/custody/evidence/${id}`, { filter: 'custody', limit: 1 }),
    enabled,
    staleTime: 60_000,
  });
}

/**
 * Rare and consequential actions. The panel stays mounted while closed so an action's own dialog survives the
 * menu closing, and it stays open while such a dialog is up so focus can return to the action that opened it.
 */
function MoreActions({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element;
      if (root.current?.contains(t) || t.closest('[role="dialog"]')) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    root.current?.querySelector<HTMLElement>('[data-more-panel] button:not([disabled])')?.focus();
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  return (
    <div ref={root} className="relative"
      onKeyDown={(e) => { if (e.key === 'Escape' && open && !(e.target as Element).closest('[role="dialog"]')) { e.stopPropagation(); setOpen(false); toggle.current?.focus(); } }}>
      <Button ref={toggle} variant="secondary" size="sm" aria-expanded={open} aria-controls="evidence-more-actions" onClick={() => setOpen((o) => !o)}>
        <Ellipsis className="h-4 w-4" aria-hidden />
        {tr('More actions')}
      </Button>
      <div id="evidence-more-actions" data-more-panel role="group" aria-label={tr('More actions')}
        className={clsx(open ? 'flex' : 'hidden', 'absolute right-0 z-20 mt-1 min-w-[14rem] flex-col items-stretch gap-1 rounded-lg border border-ink-200 bg-white p-2 shadow-lg [&_button]:w-full [&_button]:justify-start')}>
        {children}
      </div>
    </div>
  );
}

export function EvidenceDetailPage() {
  const { id = '' } = useParams();
  const { canAny } = useAuth();
  const [url, setUrl] = useUrlState(TAB_DEFAULTS);
  const q = useEvidenceDetail(id);
  const custodyVerdict = useCustodyVerdict(id, canAny('custody:read'));

  if (q.isLoading) return <Spinner label={tr('Loading evidence…')} />;
  if (q.error) {
    if (q.error instanceof ApiError && q.error.status === 404) {
      return <EmptyState heading="h1" title={tr('Evidence not found')} description={tr('It does not exist or is outside your jurisdiction.')} action={<Link className="text-brand-700 hover:underline" to="/evidence">{tr('Back to evidence')}</Link>} />;
    }
    return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  }
  const ev = q.data!;
  const tabs = EVIDENCE_TABS.filter((t) => allowedFor(t.anyOf, canAny, ev));
  const actions = EVIDENCE_ACTIONS.filter((a) => allowedFor(a.anyOf, canAny, ev));
  const mainActions = actions.filter((a) => !a.more);
  const moreActions = actions.filter((a) => a.more);
  const canCustody = tabs.some((t) => t.id === 'custody');
  const canPlayback = tabs.some((t) => t.id === 'playback') && ev.mediaStatus === 'READY';
  const openTab = (tab: string) => setUrl({ tab: tab === tabs[0]?.id ? '' : tab });
  const active = tabs.find((t) => t.id === url.tab) ?? tabs[0];
  const ActiveTab = active?.component;
  const custodyCount = custodyVerdict.data?.page.total;

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumb={<Link to="/evidence" className="hover:underline">{tr('Evidence')}</Link>}
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span className="break-all font-mono">{ev.evidenceNumber ?? tr('Unnumbered')}</span>
            <StatusBadge status={ev.status} />
            {ev.legalHold && (
              <Badge tone="red">
                <Lock className="mr-1 h-3 w-3" aria-hidden />
                {tr('Legal hold')}
              </Badge>
            )}
            <Badge tone="gray">{titleCase(ev.storageTier)}{' '}{tr('tier')}</Badge>
          </span>
        }
        subtitle={
          <span>
            {ev.title ?? tr('Untitled')} · {ev.orgUnit.name} · {ev.recordedAt ? tr('recorded {recordedAt}', { recordedAt: formatDateTime(ev.recordedAt) }) : tr('recording time unknown')}
          </span>
        }
        actions={
          canPlayback || actions.length ? (
            <div className="flex flex-wrap items-start gap-2">
              {canPlayback && (
                <Button size="sm" icon={<Play className="h-4 w-4" />} onClick={() => openTab('playback')}>{tr('Play footage')}</Button>
              )}
              {mainActions.map((a) => (
                <a.component key={a.id} evidence={ev} />
              ))}
              {moreActions.length > 0 && (
                <MoreActions>
                  {moreActions.map((a) => (
                    <a.component key={a.id} evidence={ev} />
                  ))}
                </MoreActions>
              )}
            </div>
          ) : undefined
        }
      />
      {ev.legalHold && (
        <Alert tone="red" title={tr('Under legal hold')}>
          {ev.legalHoldReason}{' '}{tr('— placed by')}{' '}{ev.legalHoldBy?.fullName ?? tr('unknown')}{' '}{tr('on')}{' '}{formatDateTime(ev.legalHoldAt)}{tr('. Disposal is blocked until the hold is released.')}
        </Alert>
      )}
      {ev.status === 'DISPOSED' && (
        <Alert tone="amber" title={tr('Disposed')}>
          {tr('The original and derived media were destroyed on')}{' '}{formatDateTime(ev.disposedAt)}{' '}{tr('under an authorised disposal. This record and its chain of custody are retained permanently.')}
        </Alert>
      )}
      {ev.status === 'DISPOSAL_PENDING' && <Alert tone="amber" title={tr('Disposal pending')}>{tr('A disposal request is awaiting a decision by an authorised approver.')}</Alert>}
      <div className="card space-y-2 px-4 py-3">
        <IntegrityVerdict ev={ev} canCustody={canCustody} open={openTab} />
        <p className="pt-1 text-xs font-medium uppercase tracking-wide text-ink-500">{tr('Registered hashes')}</p>
        <HashRow label={tr('SHA-256')} value={ev.sha256} />
        <HashRow label={tr('SHA-512')} value={ev.sha512} />
      </div>
      {tabs.length > 0 && active && (
        <div>
          <Tabs tabs={tabs.map((t) => ({ id: t.id, label: t.label, count: t.id === 'custody' ? custodyCount : undefined }))} value={active.id} onChange={openTab} />
          <div role="tabpanel" aria-label={active.label}>
            {ActiveTab && <LazyBoundary key={active.id}><ActiveTab evidence={ev} /></LazyBoundary>}
          </div>
        </div>
      )}
    </div>
  );
}
