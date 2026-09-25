import type { EvidenceTab } from '@/lib/extensions';
import { CustodyTab } from './CustodyTab';

const tabs: EvidenceTab[] = [{ id: 'custody', label: 'Chain of custody', order: 60, anyOf: ['custody:read'], component: CustodyTab }];
export default tabs;
