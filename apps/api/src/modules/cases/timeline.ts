/** Human-readable one-line summaries for case timeline items (never includes secrets; details are audit-safe). */
export function timelineSummary(action: string, d: Record<string, unknown>, evidenceNumber: string | null): string {
  const ev = evidenceNumber ?? 'evidence';
  const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
  switch (action) {
    case 'CASE_CREATED':
      return `Case opened: ${s(d.title)}`;
    case 'CASE_UPDATED':
      return `Case details updated (${Array.isArray(d.fields) ? d.fields.join(', ') : 'fields'})`;
    case 'CASE_STATUS_CHANGED':
      return `Status ${s(d.from)} → ${s(d.to)}${d.reason ? `: ${s(d.reason)}` : ''}`;
    case 'CASE_MEMBER_CHANGED':
      return d.change === 'ADDED' ? `Team member added (${s(d.role)})` : `Team member removed${d.reason ? `: ${s(d.reason)}` : ''}`;
    case 'EVIDENCE_LINKED_TO_CASE':
      return `${ev} linked to the case${d.note ? `: ${s(d.note)}` : ''}`;
    case 'EVIDENCE_UNLINKED_FROM_CASE':
      return `${ev} unlinked from the case: ${s(d.reason)}`;
    case 'EVIDENCE_VIEWED':
      return `${ev} viewed`;
    case 'EVIDENCE_PLAYED':
      return `${ev} played`;
    case 'EVIDENCE_DOWNLOADED':
      return `${ev} original downloaded`;
    case 'EVIDENCE_LEGAL_HOLD_SET':
      return `Legal hold placed on ${ev}`;
    case 'EVIDENCE_LEGAL_HOLD_RELEASED':
      return `Legal hold released on ${ev}`;
    case 'EVIDENCE_INTEGRITY_VERIFIED':
      return `Integrity of ${ev} verified`;
    case 'EVIDENCE_INTEGRITY_FAILED':
      return `Integrity check FAILED for ${ev}`;
    case 'EVIDENCE_SNAPSHOT_CREATED':
      return `Snapshot created from ${ev}`;
    case 'EVIDENCE_DOWNLOAD_LINK_ISSUED':
      return `Download link for ${ev} issued to an integration client`;
    default:
      return `${action.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}${evidenceNumber ? ` (${evidenceNumber})` : ''}`;
  }
}
