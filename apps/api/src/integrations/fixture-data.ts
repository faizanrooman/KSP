/**
 * FIXTURE DATA — synthetic records in the assumed upstream wire format (contract.ts). Used by the `fixture`
 * adapter in development and tests. These are NOT real CCTNS records and prove nothing about the real system.
 */
import type { UpstreamFir } from './contract.js';

export const FIXTURE_FIRS: UpstreamFir[] = [
  {
    firId: 'FIXTURE-CCTNS-CUB-2026-0142',
    psCode: 'ps_cubbonpark',
    firYear: 2026,
    firNo: '0142',
    regDateTime: '2026-03-14T09:30:00+05:30',
    actsSections: [{ act: 'BNS', section: '303(2)' }, { act: 'BNS', section: '115(2)' }],
    complainantName: 'Fixture Complainant A',
    briefFacts: '[FIXTURE] Chain snatching near the park gate; body-worn camera footage recorded by patrol.',
    placeOfOccurrence: 'Cubbon Park main gate (fixture)',
    occurrenceFrom: '2026-03-14T07:45:00+05:30',
    occurrenceTo: '2026-03-14T08:00:00+05:30',
    firStatus: 'UNDER_INVESTIGATION',
  },
  {
    firId: 'FIXTURE-CCTNS-CUB-2026-0143',
    psCode: 'ps_cubbonpark',
    firYear: 2026,
    firNo: 143,
    regDateTime: '2026-03-15T18:10:00+05:30',
    actsSections: [{ act: 'BNS', section: '281' }],
    complainantName: 'Fixture Complainant B',
    briefFacts: '[FIXTURE] Rash driving incident at the junction.',
    placeOfOccurrence: 'MG Road junction (fixture)',
    occurrenceFrom: '2026-03-15T17:30:00+05:30',
    occurrenceTo: null,
    firStatus: 'REGISTERED',
  },
  {
    firId: 'FIXTURE-CCTNS-NAZ-2026-0007',
    psCode: 'ps_nazarbad',
    firYear: 2026,
    firNo: '0007',
    regDateTime: '2026-01-02T11:00:00+05:30',
    actsSections: [{ act: 'BNS', section: '118(1)' }],
    complainantName: null,
    briefFacts: '[FIXTURE] Assault reported at the bus stand.',
    placeOfOccurrence: 'Nazarbad bus stand (fixture)',
    occurrenceFrom: null,
    occurrenceTo: null,
    firStatus: 'CHARGE_SHEETED',
  },
];
