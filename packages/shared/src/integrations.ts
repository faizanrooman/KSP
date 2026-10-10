/**
 * Case management & external integration contracts shared by API and web (spec modules 12 & 16).
 * External system API contracts (CCTNS, FIR systems, case diaries, evidence repositories) are NOT defined
 * by the specification: every adapter other than `fixture` is a best-guess skeleton and stays UNVERIFIED
 * (integration_systems.verified = false) until a live contract test passes.
 */
import type { Permission } from './permissions.js';

/** Permissions an integration API client may be granted (subset of the permission catalogue). */
export const INTEGRATION_SCOPES = ['evidence:read', 'evidence:download_original', 'cases:read'] as const satisfies readonly Permission[];
export type IntegrationScope = (typeof INTEGRATION_SCOPES)[number];

export const INTEGRATION_SYSTEM_TYPES = ['CCTNS', 'FIR', 'CASE_DIARY', 'EVIDENCE_REPOSITORY', 'OTHER'] as const;
export type IntegrationSystemType = (typeof INTEGRATION_SYSTEM_TYPES)[number];

/** Adapter implementations. `fixture` = labelled JSON contract fixtures (dev/test only, never "verified"). */
export const INTEGRATION_ADAPTERS = ['fixture', 'http-json'] as const;
export type IntegrationAdapterId = (typeof INTEGRATION_ADAPTERS)[number];

export const INTEGRATION_AUTH_TYPES = ['none', 'bearer', 'basic', 'mtls'] as const;

/** Error taxonomy for adapter failures (returned in API errors and recorded in integration_sync_log). */
export const INTEGRATION_ERROR_CODES = ['NOT_CONFIGURED', 'UNAUTHORIZED', 'NOT_FOUND', 'UPSTREAM_ERROR', 'CONTRACT_MISMATCH', 'BLOCKED_DESTINATION', 'TIMEOUT'] as const;
export type IntegrationErrorCode = (typeof INTEGRATION_ERROR_CODES)[number];

export const CASE_MEMBER_ROLES = ['MEMBER', 'ANALYST', 'PROSECUTION_LIAISON'] as const;

/**
 * Case status workflow. Forward moves follow the sequence; any active case may be CLOSED (with reason);
 * CLOSED -> ARCHIVED; reopening (CLOSED/ARCHIVED -> UNDER_INVESTIGATION) requires a reason.
 */
export const CASE_TRANSITIONS: Record<string, readonly string[]> = {
  OPEN: ['UNDER_INVESTIGATION', 'CLOSED'],
  UNDER_INVESTIGATION: ['PENDING_TRIAL', 'CLOSED'],
  PENDING_TRIAL: ['IN_TRIAL', 'CLOSED'],
  IN_TRIAL: ['CLOSED'],
  CLOSED: ['ARCHIVED', 'UNDER_INVESTIGATION'],
  ARCHIVED: ['UNDER_INVESTIGATION'],
};
/** Transitions that require a reason (closing, reopening, archiving). */
export function caseTransitionNeedsReason(from: string, to: string): boolean {
  return to === 'CLOSED' || to === 'ARCHIVED' || from === 'CLOSED' || from === 'ARCHIVED';
}

export const FIR_TRANSITIONS: Record<string, readonly string[]> = {
  REGISTERED: ['UNDER_INVESTIGATION', 'TRANSFERRED', 'CLOSED'],
  UNDER_INVESTIGATION: ['CHARGESHEETED', 'FINAL_REPORT', 'TRANSFERRED'],
  CHARGESHEETED: ['CLOSED'],
  FINAL_REPORT: ['CLOSED', 'UNDER_INVESTIGATION'],
  CLOSED: ['UNDER_INVESTIGATION'],
  TRANSFERRED: [],
};

/** FIR shown as "<number>/<year>" ("0412" + 2026 → "0412/2026"). A number that already ends with its year (records
 *  created before normaliseFirNumber) is shown once, never "0412/2026/2026". */
export function firDisplayNumber(firNumber: string, firYear: number): string {
  return firNumber.endsWith(`/${firYear}`) ? firNumber : `${firNumber}/${firYear}`;
}

/** The FIR year is a separate field: a trailing "/<year>" typed into the number ("0412/2026") is removed. */
export function normaliseFirNumber(firNumber: string, firYear: number): string {
  const n = firNumber.trim();
  const suffix = `/${firYear}`;
  return n.length > suffix.length && n.endsWith(suffix) ? n.slice(0, -suffix.length) : n;
}
