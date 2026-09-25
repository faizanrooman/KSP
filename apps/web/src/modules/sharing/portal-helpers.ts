/** Pure helpers of the external share portal (unit-tested). */
import { ApiError, errorMessage } from '@/lib/api';

/** sessionStorage key for a share session (never the full link token). */
export const storeKey = (token: string) => `ksp-share-session:${token.slice(0, 24)}`;

export type OpenFailure = { kind: 'blocked'; message: string } | { kind: 'retry'; message: string };

/** Map a failed POST /share-portal/open to what the recipient sees. */
export function openFailure(err: unknown): OpenFailure {
  if (err instanceof ApiError && [403, 410, 423].includes(err.status)) return { kind: 'blocked', message: err.message };
  if (err instanceof ApiError && err.status === 401) {
    const left = (err.details as { attemptsRemaining?: number } | undefined)?.attemptsRemaining;
    return { kind: 'retry', message: left !== undefined ? `Incorrect access code. ${left} attempt${left === 1 ? '' : 's'} left before the share is locked.` : 'Invalid link or access code.' };
  }
  return { kind: 'retry', message: errorMessage(err) };
}

/** When to re-request the playback descriptor: before the media token expires, or poll while preparing. */
export function refreshDelayMs(pb: { status: string; expiresAt?: string } | null, now = Date.now()): number | null {
  if (!pb) return null;
  if (pb.status !== 'READY') return 4000;
  if (!pb.expiresAt) return 30_000;
  return Math.max(30_000, new Date(pb.expiresAt).getTime() - now - 60_000);
}
