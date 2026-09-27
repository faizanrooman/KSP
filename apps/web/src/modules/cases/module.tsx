import { Briefcase, FileText, KeyRound, Plug } from 'lucide-react';
import type { WebModule } from '@/lib/modules';
import { lazyPage } from '@/lib/lazy';

const CasesListPage = lazyPage(() => import('./CasesListPage'), 'CasesListPage');
const CaseDetailPage = lazyPage(() => import('./CaseDetailPage'), 'CaseDetailPage');
const FirDetailPage = lazyPage(() => import('./FirPages'), 'FirDetailPage');
const FirListPage = lazyPage(() => import('./FirPages'), 'FirListPage');
const IntegrationsPage = lazyPage(() => import('./IntegrationsPage'), 'IntegrationsPage');
const ApiClientsPage = lazyPage(() => import('./ApiClientsPage'), 'ApiClientsPage');

const mod: WebModule = {
  id: 'cases',
  routes: [
    { path: 'cases', element: CasesListPage, anyOf: ['cases:read'] },
    { path: 'cases/:id', element: CaseDetailPage, anyOf: ['cases:read'] },
    { path: 'firs', element: FirListPage, anyOf: ['cases:read'] },
    { path: 'firs/:id', element: FirDetailPage, anyOf: ['cases:read'] },
    { path: 'admin/integrations', element: IntegrationsPage, anyOf: ['integrations:manage'] },
    { path: 'admin/api-clients', element: ApiClientsPage, anyOf: ['integrations:manage'] },
  ],
  nav: [
    { to: '/cases', label: 'Cases', icon: Briefcase, section: 'Cases', anyOf: ['cases:read'], order: 10 },
    { to: '/firs', label: 'FIRs', icon: FileText, section: 'Cases', anyOf: ['cases:read'], order: 20 },
    { to: '/admin/integrations', label: 'Integrations', icon: Plug, section: 'Administration', anyOf: ['integrations:manage'], order: 60 },
    { to: '/admin/api-clients', label: 'API clients', icon: KeyRound, section: 'Administration', anyOf: ['integrations:manage'], order: 65 },
  ],
};
export default mod;
