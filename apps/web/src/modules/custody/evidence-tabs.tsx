import type { EvidenceTab } from '@/lib/extensions';
import { lazyPage } from '@/lib/lazy';

const CustodyTab = lazyPage(() => import('./CustodyTab'), 'CustodyTab');

const tabs: EvidenceTab[] = [{ id: 'custody', label: 'Chain of custody', order: 60, anyOf: ['custody:read'], component: CustodyTab }];
export default tabs;
