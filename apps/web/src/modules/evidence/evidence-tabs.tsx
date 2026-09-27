import type { EvidenceTab } from '@/lib/extensions';
import { lazyPage } from '@/lib/lazy';

const OverviewTab = lazyPage(() => import('./OverviewTab'), 'OverviewTab');
const IntegrityTab = lazyPage(() => import('./IntegrityTab'), 'IntegrityTab');
const LifecycleTab = lazyPage(() => import('./LifecycleTab'), 'LifecycleTab');

const tabs: EvidenceTab[] = [
  { id: 'overview', label: 'Overview', order: 0, component: OverviewTab },
  { id: 'integrity', label: 'Integrity', order: 80, component: IntegrityTab },
  { id: 'lifecycle', label: 'Lifecycle', order: 90, component: LifecycleTab },
];
export default tabs;
