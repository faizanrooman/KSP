import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import { openFailure, refreshDelayMs, storeKey } from './portal-helpers';

describe('share portal helpers', () => {
  it('maps open failures: wrong code shows remaining attempts; locked/expired/revoked/limit block', () => {
    expect(openFailure(new ApiError(401, 'UNAUTHENTICATED', 'Invalid link or access code', { attemptsRemaining: 4 }))).toEqual({ kind: 'retry', message: 'Incorrect access code. 4 attempts left before the share is locked.' });
    expect(openFailure(new ApiError(401, 'UNAUTHENTICATED', 'Invalid link or access code', { attemptsRemaining: 1 })).message).toContain('1 attempt left');
    expect(openFailure(new ApiError(401, 'UNAUTHENTICATED', 'Invalid link or access code'))).toEqual({ kind: 'retry', message: 'Invalid link or access code.' });
    for (const s of [403, 410, 423]) expect(openFailure(new ApiError(s, 'X', 'blocked')).kind).toBe('blocked');
  });

  it('never stores the full link token as a key', () => {
    const t = 'A'.repeat(43);
    expect(storeKey(t)).toBe(`ksp-share-session:${'A'.repeat(24)}`);
    expect(storeKey(t)).not.toContain(t);
  });

  it('refreshes media tokens a minute before expiry and polls while preparing', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(refreshDelayMs({ status: 'PREPARING' }, now)).toBe(4000);
    expect(refreshDelayMs({ status: 'READY', expiresAt: '2026-01-01T00:10:00Z' }, now)).toBe(540_000);
    expect(refreshDelayMs({ status: 'READY', expiresAt: '2026-01-01T00:00:30Z' }, now)).toBe(30_000);
    expect(refreshDelayMs(null, now)).toBeNull();
  });
});
