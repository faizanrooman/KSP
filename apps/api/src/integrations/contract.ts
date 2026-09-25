/**
 * UPSTREAM wire contract assumed by the `http-json` and `fixture` adapters, validated with Zod, plus mapping
 * functions to/from our canonical DTOs.
 *
 * UNVERIFIED: this is a best-guess contract ("ksp-cctns-json-v0"). The real CCTNS / FIR / case-diary /
 * evidence-repository APIs are not defined in the specification. When the real contract is obtained, change
 * ONLY this file (schemas + mappers) and re-run the live contract test (POST /integrations/systems/:id/test
 * with `contract: true`) before marking a system verified.
 *
 *   GET  {base}/health                                   -> { status: "UP" | "DOWN", version? }
 *   GET  {base}/firs/{psCode}/{year}/{firNo}             -> { fir: UpstreamFir }        (404 = not found)
 *   GET  {base}/firs?psCode=&year=&q=&limit=             -> { items: UpstreamFir[] }
 *   POST {base}/cases/{caseRef}/evidence-references      -> { accepted: boolean, referenceId?: string }
 *   GET  {base}/case-diaries/{caseRef}/entries?since=    -> { items: UpstreamDiaryEntry[] }
 *   POST {base}/case-diaries/{caseRef}/entries           -> { accepted, referenceId? }
 *   GET  {base}/evidence/{ref}                           -> { evidence: UpstreamRepoEvidence } (404 = not found)
 *   POST {base}/evidence-references                      -> { accepted, referenceId? }
 */
import { z } from 'zod';
import type { CaseDiaryEntry, EvidenceReference, FirRecord, RepositoryEvidenceRecord } from './types.js';
import { IntegrationError } from './types.js';

export const CONTRACT_VERSION = 'ksp-cctns-json-v0';

const isoDate = z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'invalid date-time');

export const upstreamFir = z.object({
  firId: z.string().min(1).max(100),
  psCode: z.string().min(1).max(40),
  firYear: z.number().int().min(1950).max(2200),
  firNo: z.union([z.string().min(1).max(40), z.number().int().positive()]),
  regDateTime: isoDate,
  actsSections: z.array(z.object({ act: z.string().min(1).max(40), section: z.string().min(1).max(40) })).max(100).default([]),
  complainantName: z.string().max(500).nullable().optional(),
  briefFacts: z.string().max(20_000).nullable().optional(),
  placeOfOccurrence: z.string().max(1000).nullable().optional(),
  occurrenceFrom: isoDate.nullable().optional(),
  occurrenceTo: isoDate.nullable().optional(),
  firStatus: z.enum(['REGISTERED', 'UNDER_INVESTIGATION', 'CHARGE_SHEETED', 'FINAL_REPORT', 'CLOSED', 'TRANSFERRED']),
});
export type UpstreamFir = z.infer<typeof upstreamFir>;

export const healthResponse = z.object({ status: z.enum(['UP', 'DOWN']), version: z.string().optional() });
export const firResponse = z.object({ fir: upstreamFir });
export const firListResponse = z.object({ items: z.array(upstreamFir).max(500) });
export const pushResponse = z.object({ accepted: z.boolean(), referenceId: z.string().max(200).nullable().optional() });

export const upstreamDiaryEntry = z.object({ entryId: z.string().min(1), caseRef: z.string().min(1), enteredAt: isoDate, author: z.string().nullable().optional(), text: z.string().max(50_000) });
export const diaryListResponse = z.object({ items: z.array(upstreamDiaryEntry).max(1000) });
export const upstreamRepoEvidence = z.object({ ref: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(), title: z.string().nullable().optional(), recordedAt: isoDate.nullable().optional() });
export const repoEvidenceResponse = z.object({ evidence: upstreamRepoEvidence });

/** Parse an upstream payload; a shape mismatch is a CONTRACT_MISMATCH (never silently accepted). */
export function parseUpstream<S extends z.ZodTypeAny>(schema: S, data: unknown, what: string): z.output<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issues = r.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new IntegrationError('CONTRACT_MISMATCH', `Upstream ${what} does not match contract ${CONTRACT_VERSION}: ${issues}`);
  }
  return r.data;
}

const STATUS_MAP: Record<UpstreamFir['firStatus'], FirRecord['status']> = {
  REGISTERED: 'REGISTERED',
  UNDER_INVESTIGATION: 'UNDER_INVESTIGATION',
  CHARGE_SHEETED: 'CHARGESHEETED',
  FINAL_REPORT: 'FINAL_REPORT',
  CLOSED: 'CLOSED',
  TRANSFERRED: 'TRANSFERRED',
};

export function mapFir(u: UpstreamFir): FirRecord {
  const d = (v: string | null | undefined) => (v ? new Date(v) : null);
  return {
    externalRef: u.firId,
    stationCode: u.psCode,
    firYear: u.firYear,
    firNumber: String(u.firNo),
    registeredAt: new Date(u.regDateTime),
    actsSections: u.actsSections.map((a) => `${a.act} ${a.section}`),
    complainant: u.complainantName ?? null,
    briefFacts: u.briefFacts ?? null,
    placeOfOccurrence: u.placeOfOccurrence ?? null,
    occurredFrom: d(u.occurrenceFrom),
    occurredTo: d(u.occurrenceTo),
    status: STATUS_MAP[u.firStatus],
  };
}

/** Our evidence reference -> upstream push body (hashes and numbers only; never storage locations). */
export function evidenceReferenceBody(ref: EvidenceReference) {
  return { vemsEvidenceId: ref.evidenceId, evidenceNumber: ref.evidenceNumber, sha256: ref.sha256, recordedAt: ref.recordedAt?.toISOString() ?? null, title: ref.title };
}

export function mapDiaryEntry(u: z.infer<typeof upstreamDiaryEntry>): CaseDiaryEntry {
  return { externalRef: u.entryId, caseRef: u.caseRef, enteredAt: new Date(u.enteredAt), author: u.author ?? null, body: u.text };
}

export function mapRepoEvidence(u: z.infer<typeof upstreamRepoEvidence>): RepositoryEvidenceRecord {
  return { externalRef: u.ref, sha256: u.sha256 ?? null, title: u.title ?? null, recordedAt: u.recordedAt ? new Date(u.recordedAt) : null };
}

/** Canonical FIR -> columns of our `firs` table (org unit resolved by the caller). */
export function firToRow(f: FirRecord) {
  return {
    fir_number: f.firNumber,
    fir_year: f.firYear,
    registered_at: f.registeredAt,
    acts_sections: f.actsSections,
    complainant: f.complainant,
    brief_facts: f.briefFacts,
    place_of_occurrence: f.placeOfOccurrence,
    occurred_from: f.occurredFrom,
    occurred_to: f.occurredTo,
    status: f.status,
    external_ref: f.externalRef,
  };
}
