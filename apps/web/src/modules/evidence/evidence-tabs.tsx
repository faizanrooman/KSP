import type { EvidenceTab } from '@/lib/extensions';
import { OverviewTab } from './OverviewTab';
import { IntegrityTab } from './IntegrityTab';
import { LifecycleTab } from './LifecycleTab';

const tabs: EvidenceTab[] = [
  { id: 'overview', label: 'Overview', order: 0, component: OverviewTab },
  { id: 'integrity', label: 'Integrity', order: 80, component: IntegrityTab },
  { id: 'lifecycle', label: 'Lifecycle', order: 90, component: LifecycleTab },
];
export default tabs;
