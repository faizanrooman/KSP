/**
 * Cross-module UI extension points (discovered by file convention, no shared registry to edit):
 *
 *   src/modules/<m>/evidence-tabs.tsx     default export: EvidenceTab[]     -> tabs on the evidence detail page
 *   src/modules/<m>/evidence-actions.tsx  default export: EvidenceAction[]  -> action buttons on the evidence detail page
 *   src/modules/<m>/case-tabs.tsx         default export: CaseTab[]         -> tabs on the case detail page
 *
 * The evidence detail page (owned by the `evidence` module) renders every contributed tab in `order`.
 */
import type { ComponentType } from 'react';
import type { Permission } from '@ksp/shared';

/** Minimal evidence shape passed to extensions (GET /api/v1/evidence/:id returns a superset). */
export interface EvidenceSummary {
  id: string;
  evidenceNumber: string | null;
  status: string;
  mediaStatus: string;
  orgUnitId: string;
  title: string | null;
  durationMs: number | null;
  frameRate: number | null;
  width: number | null;
  height: number | null;
  recordedAt: string | null;
  sha256: string | null;
  legalHold: boolean;
}

export interface EvidenceTab {
  id: string;
  label: string;
  order: number;
  anyOf?: Permission[];
  component: ComponentType<{ evidence: EvidenceSummary }>;
}

export interface EvidenceAction {
  id: string;
  order: number;
  anyOf?: Permission[];
  /** Rare or consequential actions live in the header's "More" menu instead of the main action row. */
  more?: boolean;
  /** Renders a button (and any dialog it owns). */
  component: ComponentType<{ evidence: EvidenceSummary }>;
}

export interface CaseSummary {
  id: string;
  caseNumber: string;
  title: string;
  status: string;
  orgUnitId: string;
}
export interface CaseTab {
  id: string;
  label: string;
  order: number;
  anyOf?: Permission[];
  component: ComponentType<{ caseItem: CaseSummary }>;
}

const tabs = import.meta.glob<{ default: EvidenceTab[] }>('../modules/*/evidence-tabs.tsx', { eager: true });
const actions = import.meta.glob<{ default: EvidenceAction[] }>('../modules/*/evidence-actions.tsx', { eager: true });
const caseTabs = import.meta.glob<{ default: CaseTab[] }>('../modules/*/case-tabs.tsx', { eager: true });

export const EVIDENCE_TABS: EvidenceTab[] = Object.values(tabs).flatMap((m) => m.default).sort((a, b) => a.order - b.order);
export const EVIDENCE_ACTIONS: EvidenceAction[] = Object.values(actions).flatMap((m) => m.default).sort((a, b) => a.order - b.order);
export const CASE_TABS: CaseTab[] = Object.values(caseTabs).flatMap((m) => m.default).sort((a, b) => a.order - b.order);
