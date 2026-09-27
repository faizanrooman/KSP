import { describe, expect, it } from 'vitest';
import { titleCase } from './format';

describe('titleCase', () => {
  it('title-cases enum values', () => {
    expect(titleCase('UNDER_INVESTIGATION')).toBe('Under Investigation');
    expect(titleCase('PENDING_APPROVAL')).toBe('Pending Approval');
  });
  it('keeps acronyms upper-case (UI-B-11)', () => {
    expect(titleCase('CCTNS')).toBe('CCTNS');
    expect(titleCase('MFA_CHALLENGE_PASSED')).toBe('MFA Challenge Passed');
    expect(titleCase('AI_RESULTS_VIEWED')).toBe('AI Results Viewed');
    expect(titleCase('FIR_IMPORT')).toBe('FIR Import');
  });
});
