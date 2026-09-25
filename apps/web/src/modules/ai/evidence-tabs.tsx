import type { EvidenceTab } from '@/lib/extensions';
import { AiTab } from './AiTab';

const tabs: EvidenceTab[] = [
  // ai:request is gated by the per-evidence canRequestAi flag; reviewers (ai:review) see results read-only.
  { id: 'ai', label: 'AI analysis', order: 30, anyOf: ['ai:request', 'ai:review'], component: AiTab },
];
export default tabs;
