import { ScrollText, ShieldCheck } from 'lucide-react';
import type { WebModule } from '@/lib/modules';
import { lazyPage } from '@/lib/lazy';

const AuditLogPage = lazyPage(() => import('./AuditLogPage'), 'AuditLogPage');
const LedgerPage = lazyPage(() => import('./LedgerPage'), 'LedgerPage');

const mod: WebModule = {
  id: 'audit',
  routes: [
    { path: 'compliance/audit', element: AuditLogPage, anyOf: ['audit:read'] },
    { path: 'compliance/ledger', element: LedgerPage, anyOf: ['audit:verify', 'audit:read'] },
  ],
  nav: [
    { to: '/compliance/audit', label: 'Audit log', icon: ScrollText, section: 'Compliance', anyOf: ['audit:read'], order: 10 },
    { to: '/compliance/ledger', label: 'Ledger verification', icon: ShieldCheck, section: 'Compliance', anyOf: ['audit:verify', 'audit:read'], order: 20 },
  ],
};
export default mod;
