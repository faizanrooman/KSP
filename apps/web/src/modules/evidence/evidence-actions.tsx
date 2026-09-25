import type { EvidenceAction } from '@/lib/extensions';
import { LegalHoldButton, RequestDisposalButton, VerifyButton } from './actions';

const actions: EvidenceAction[] = [
  { id: 'verify', order: 80, anyOf: ['evidence:verify'], component: VerifyButton },
  { id: 'legal-hold', order: 85, anyOf: ['evidence:legal_hold'], component: LegalHoldButton },
  { id: 'request-disposal', order: 95, anyOf: ['evidence:dispose_request'], component: RequestDisposalButton },
];
export default actions;
