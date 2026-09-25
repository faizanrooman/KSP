/** Types, URL encoding and hooks for POST /api/v1/search/evidence (+ saved searches, related suggestions). */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { EvidenceListItem } from '@/modules/evidence/types';

export type AiReviewFilter = 'APPROVED' | 'ANY_NON_REJECTED';

export interface AiCriteria {
  tasks?: string[];
  labels?: string[];
  colors?: string[];
  plateText?: string;
  watchlistEntryIds?: string[];
  minConfidence?: number;
  reviewStatus?: AiReviewFilter;
}

export interface SearchCriteria {
  text?: string;
  evidenceNumber?: string;
  orgUnitIds?: string[];
  officerIds?: string[];
  officerBadge?: string;
  deviceIds?: string[];
  deviceSerial?: string;
  uploadedBy?: string;
  recordedFrom?: string;
  recordedTo?: string;
  createdFrom?: string;
  createdTo?: string;
  location?: { lat: number; lon: number; radiusKm: number };
  bbox?: { minLat: number; maxLat: number; minLon: number; maxLon: number };
  tags?: string[];
  tagMode?: 'any' | 'all';
  categories?: string[];
  statuses?: string[];
  mediaStatuses?: string[];
  storageTiers?: string[];
  legalHold?: boolean;
  caseIds?: string[];
  caseNumber?: string;
  firNumber?: string;
  firOrgUnitId?: string;
  firYear?: number;
  ai?: AiCriteria;
}

export const SEARCH_SORTS = ['relevance', '-recorded_at', 'recorded_at', '-created_at', 'created_at'] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];

export interface SnippetPart {
  text: string;
  hit: boolean;
}
export interface AiMatch {
  detectionId: string;
  task: string;
  label: string;
  confidence: number;
  frameTimeMs: number;
  reviewStatus: string;
  unreviewed: boolean;
  colorName: string | null;
  plateText: string | null;
  watchlistEntryId: string | null;
}
export interface SearchItem extends EvidenceListItem {
  matches: { score: number | null; snippet: SnippetPart[] | null; ai: AiMatch[]; aiTotal: number };
}
export interface FacetBucket {
  key: string;
  label: string;
  count: number;
}
export type FacetName = 'station' | 'status' | 'storageTier' | 'tag' | 'aiLabel';
export interface SearchResult {
  items: SearchItem[];
  total: number;
  page: number;
  pageSize: number;
  sort: SearchSort;
  facets: Record<FacetName, FacetBucket[]> | null;
  facetsTruncated: boolean;
  includesUnreviewedAi: boolean;
  tookMs: number;
}
export interface SavedSearch {
  id: string;
  name: string;
  criteria: SearchCriteria;
  createdAt: string;
}
export interface RelatedReason {
  kind: 'SAME_CASE' | 'SAME_OFFICER' | 'SAME_DEVICE' | 'NEARBY' | 'SHARED_PLATE' | 'SHARED_WATCHLIST' | 'RELATION';
  detail: string;
  relationId?: string;
  relation?: string;
}
export interface RelatedItem extends EvidenceListItem {
  reasons: RelatedReason[];
  score: number;
}

/** Drop empty strings / arrays / objects so the request (and URL) only carries real criteria. */
export function compactCriteria(c: SearchCriteria): SearchCriteria {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      if (v.length) out[k] = v;
      continue;
    }
    if (typeof v === 'object') {
      const inner = k === 'ai' ? compactCriteria(v as SearchCriteria) : (v as Record<string, unknown>);
      const keys = Object.keys(inner).filter((x) => !(k === 'ai' && x === 'reviewStatus' && (inner as AiCriteria).reviewStatus === 'APPROVED'));
      if (keys.length) out[k] = inner;
      continue;
    }
    out[k] = v;
  }
  if (!out.tags) delete out.tagMode;
  return out as SearchCriteria;
}

/** URL form: `c` = JSON of the compacted criteria (empty string when there are none). */
export function encodeCriteria(c: SearchCriteria): string {
  const x = compactCriteria(c);
  return Object.keys(x).length ? JSON.stringify(x) : '';
}

export function decodeCriteria(v: string | null | undefined): SearchCriteria {
  if (!v) return {};
  try {
    const parsed: unknown = JSON.parse(v);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? compactCriteria(parsed as SearchCriteria) : {};
  } catch {
    return {};
  }
}

export function countCriteria(c: SearchCriteria): number {
  const x = compactCriteria(c);
  const base = Object.keys(x).filter((k) => k !== 'text' && k !== 'tagMode' && k !== 'ai').length;
  const ai = x.ai ? Object.entries(x.ai).filter(([k, v]) => !(k === 'reviewStatus' && v === 'APPROVED')).length : 0;
  return base + ai;
}

/** Link to the playback tab at a given moment (the video module reads `t` in ms). */
export const momentLink = (evidenceId: string, ms: number) => `/evidence/${evidenceId}?tab=playback&t=${Math.max(1, Math.round(ms))}`;

export function useSearch(criteria: SearchCriteria, page: number, pageSize: number, sort: SearchSort | undefined) {
  const body = { ...compactCriteria(criteria), page, pageSize, ...(sort ? { sort } : {}) };
  return useQuery({ queryKey: ['search', body], queryFn: () => api.post<SearchResult>('/search/evidence', body), placeholderData: keepPreviousData });
}

export function useSavedSearches() {
  return useQuery({ queryKey: ['search', 'saved'], queryFn: () => api.get<{ items: SavedSearch[] }>('/search/saved') });
}

export function useSaveSearch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { name: string; criteria: SearchCriteria }) => api.post<SavedSearch>('/search/saved', { name: b.name, criteria: compactCriteria(b.criteria) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['search', 'saved'] }),
  });
}

export function useDeleteSavedSearch() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => api.delete(`/search/saved/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['search', 'saved'] }) });
}

export function useRelated(evidenceId: string) {
  return useQuery({ queryKey: ['search', 'related', evidenceId], queryFn: () => api.get<{ items: RelatedItem[]; total: number }>(`/search/evidence/${evidenceId}/related`) });
}
