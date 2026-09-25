import { Archive, FileVideo, Trash2 } from 'lucide-react';
import type { WebModule } from '@/lib/modules';
import { EvidenceListPage } from './EvidenceListPage';
import { EvidenceDetailPage } from './EvidenceDetailPage';
import { DisposalApprovalsPage } from './DisposalApprovalsPage';
import { RetentionPoliciesPage } from './RetentionPoliciesPage';

const mod: WebModule = {
  id: 'evidence',
  routes: [
    { path: 'evidence', element: EvidenceListPage, anyOf: ['evidence:read', 'evidence:read_own', 'cases:read', 'search:use'] },
    { path: 'evidence/disposals', element: DisposalApprovalsPage, anyOf: ['evidence:dispose_approve', 'evidence:dispose_request'] },
    // Detail is reachable by anyone the API lets see the item (jurisdiction, own, case, share) — the API returns 404 otherwise.
    { path: 'evidence/:id', element: EvidenceDetailPage },
    { path: 'retention/policies', element: RetentionPoliciesPage, anyOf: ['retention:manage', 'evidence:dispose_request', 'evidence:dispose_approve'] },
  ],
  nav: [
    { to: '/evidence', label: 'Evidence', icon: FileVideo, section: 'Evidence', anyOf: ['evidence:read', 'evidence:read_own'], order: 10 },
    { to: '/evidence/disposals', label: 'Disposal approvals', icon: Trash2, section: 'Evidence', anyOf: ['evidence:dispose_approve', 'evidence:dispose_request'], order: 80 },
    { to: '/retention/policies', label: 'Retention policies', icon: Archive, section: 'Evidence', anyOf: ['retention:manage'], order: 90 },
  ],
};
export default mod;
