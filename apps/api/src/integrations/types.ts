/**
 * External integration adapter contracts (spec: CCTNS, FIR systems, case diaries, digital evidence repositories).
 *
 * IMPORTANT: the specification does NOT define the external systems' API contracts. The DTOs below are OUR
 * canonical shapes; each adapter maps the upstream payload into them. The `http-json` adapter's upstream
 * schema is a best-guess skeleton and is UNVERIFIED until a live contract test passes against the real system.
 */
import type { IntegrationErrorCode } from '@ksp/shared';

/** Canonical FIR record (what we store in `firs`). */
export interface FirRecord {
  externalRef: string;
  stationCode: string; // upstream (CCTNS) police-station code
  firYear: number;
  firNumber: string;
  registeredAt: Date;
  actsSections: string[];
  complainant: string | null;
  briefFacts: string | null;
  placeOfOccurrence: string | null;
  occurredFrom: Date | null;
  occurredTo: Date | null;
  status: 'REGISTERED' | 'UNDER_INVESTIGATION' | 'CHARGESHEETED' | 'FINAL_REPORT' | 'CLOSED' | 'TRANSFERRED';
}

export interface FirSearchQuery {
  stationCode?: string;
  year?: number;
  q?: string;
  limit?: number;
}

/** Reference to one of OUR evidence items pushed to an external case record. Never contains storage locations. */
export interface EvidenceReference {
  evidenceId: string;
  evidenceNumber: string;
  sha256: string;
  recordedAt: Date | null;
  title: string | null;
}

export interface PushResult {
  accepted: boolean;
  externalRef: string | null;
}

export interface HealthResult {
  ok: boolean;
  latencyMs: number;
  detail?: string;
}

export interface CaseDiaryEntry {
  externalRef: string;
  caseRef: string;
  enteredAt: Date;
  author: string | null;
  body: string;
}

export interface RepositoryEvidenceRecord {
  externalRef: string;
  sha256: string | null;
  title: string | null;
  recordedAt: Date | null;
}

export interface CctnsAdapter {
  readonly kind: 'CCTNS';
  fetchFir(stationCode: string, year: number, firNumber: string): Promise<FirRecord | null>;
  searchFirs(q: FirSearchQuery): Promise<FirRecord[]>;
  pushEvidenceReference(caseRef: string, evidenceRef: EvidenceReference): Promise<PushResult>;
  healthCheck(): Promise<HealthResult>;
}

export interface CaseDiaryAdapter {
  readonly kind: 'CASE_DIARY';
  fetchEntries(caseRef: string, since?: Date): Promise<CaseDiaryEntry[]>;
  pushEntry(caseRef: string, entry: { enteredAt: Date; author: string; body: string }): Promise<PushResult>;
  healthCheck(): Promise<HealthResult>;
}

export interface EvidenceRepositoryAdapter {
  readonly kind: 'EVIDENCE_REPOSITORY';
  lookup(externalRef: string): Promise<RepositoryEvidenceRecord | null>;
  pushReference(evidenceRef: EvidenceReference & { caseRef: string | null }): Promise<PushResult>;
  healthCheck(): Promise<HealthResult>;
}

export type AnyAdapter = CctnsAdapter | CaseDiaryAdapter | EvidenceRepositoryAdapter;

export class IntegrationError extends Error {
  constructor(
    readonly code: IntegrationErrorCode,
    message: string,
    readonly upstreamStatus?: number,
  ) {
    super(message);
    this.name = 'IntegrationError';
  }
}

/** HTTP status the API uses when surfacing an adapter error to the caller. */
export function integrationHttpStatus(code: IntegrationErrorCode): number {
  switch (code) {
    case 'NOT_FOUND':
      return 404;
    case 'NOT_CONFIGURED':
    case 'BLOCKED_DESTINATION':
      return 422;
    case 'TIMEOUT':
      return 504;
    default:
      return 502; // UNAUTHORIZED (upstream rejected OUR credentials), UPSTREAM_ERROR, CONTRACT_MISMATCH
  }
}

export function toIntegrationError(e: unknown): IntegrationError {
  if (e instanceof IntegrationError) return e;
  return new IntegrationError('UPSTREAM_ERROR', e instanceof Error ? e.message : 'Unknown upstream error');
}
