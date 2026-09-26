import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useUrlState } from '@/lib/hooks';
import { CASE_TABS } from '@/lib/extensions';
import { formatDate } from '@/lib/format';
import { EmptyState, ErrorState, PageHeader, Spinner, StatusBadge, Tabs } from '@/components/ui';
import { caseKey, type CaseDetail } from './types';
import { PriorityBadge } from './CasesListPage';
import { DiaryTab, EvidenceTab, OverviewTab, StatusButton, TeamTab, TimelineTab } from './case-parts';

const TAB_DEFAULTS = { tab: 'overview' };

export function useCaseDetail(id: string) {
  return useQuery({
    queryKey: caseKey(id),
    queryFn: () => api.get<CaseDetail>(`/cases/${id}`),
    retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
  });
}

export function CaseDetailPage() {
  const { id = '' } = useParams();
  const { canAny } = useAuth();
  const [url, setUrl] = useUrlState(TAB_DEFAULTS);
  const q = useCaseDetail(id);
  if (q.isLoading) return <Spinner label="Loading case…" />;
  if (q.error) {
    if (q.error instanceof ApiError && q.error.status === 404) {
      return <EmptyState heading="h1" title="Case not found" description="It does not exist or is outside your jurisdiction." action={<Link className="text-brand-700 hover:underline" to="/cases">Back to cases</Link>} />;
    }
    return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  }
  const c = q.data!;
  const ext = CASE_TABS.filter((t) => !t.anyOf?.length || canAny(...t.anyOf));
  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'evidence', label: 'Evidence', count: c.evidenceCount },
    { id: 'team', label: 'Team', count: c.members.length + (c.investigatingOfficer ? 1 : 0) + (c.supervisor ? 1 : 0) },
    { id: 'diary', label: 'Case diary' },
    { id: 'timeline', label: 'Timeline' },
    ...ext.map((t) => ({ id: `x-${t.id}`, label: t.label })),
  ];
  const active = tabs.some((t) => t.id === url.tab) ? url.tab : 'overview';
  const extTab = ext.find((t) => `x-${t.id}` === active);
  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumb={<Link to="/cases" className="text-brand-700 hover:underline">Cases</Link>}
        title={<span><span className="mono">{c.caseNumber}</span> · {c.title}</span>}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={c.status} /> <PriorityBadge priority={c.priority} /> {c.orgUnit.name} · opened {formatDate(c.openedAt)}
            {c.fir && <> · FIR <Link className="mono text-brand-700 hover:underline" to={`/firs/${c.fir.id}`}>{c.fir.displayNumber}</Link></>}
          </span>
        }
        actions={c.permissions.canManage ? <StatusButton caseItem={c} /> : undefined}
      />
      <Tabs tabs={tabs} value={active} onChange={(v) => setUrl({ tab: v })} />
      <div role="tabpanel">
        {active === 'overview' && <OverviewTab caseItem={c} />}
        {active === 'evidence' && <EvidenceTab caseItem={c} />}
        {active === 'team' && <TeamTab caseItem={c} />}
        {active === 'diary' && <DiaryTab caseItem={c} />}
        {active === 'timeline' && <TimelineTab caseItem={c} />}
        {extTab && <extTab.component caseItem={{ id: c.id, caseNumber: c.caseNumber, title: c.title, status: c.status, orgUnitId: c.orgUnitId }} />}
      </div>
    </div>
  );
}
