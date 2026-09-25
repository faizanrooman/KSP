/** Types and hooks for /api/v1/workspaces (workspaces, items, bookmarks, annotations, timeline, relations). */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { EvidenceListItem } from '@/modules/evidence/types';

export type WsRole = 'OWNER' | 'EDITOR' | 'VIEWER';
export const RELATIONS = ['SAME_INCIDENT', 'DIFFERENT_ANGLE', 'CONTINUATION', 'RELATED'] as const;
export type RelationType = (typeof RELATIONS)[number];

export interface WorkspaceSummary {
  id: string;
  title: string;
  description: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
  case: { id: string; caseNumber: string } | null;
  caseRestricted: boolean;
  owner: { id: string; fullName: string };
  myRole: WsRole;
  itemCount: number;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}
export interface Member {
  userId: string;
  fullName: string;
  username: string;
  badgeNumber: string | null;
  role: WsRole;
  addedAt: string;
}
export interface WorkspaceDetail extends Omit<WorkspaceSummary, 'memberCount' | 'case'> {
  case: { id: string; caseNumber: string; title: string; status: string } | null;
  orgUnit: { id: string; name: string };
  members: Member[];
}
export interface ItemEvidence extends EvidenceListItem {
  recordedEndAt: string | null;
  frameRate: number | null;
  gpsLatitude: number | null;
  gpsLongitude: number | null;
}
export type WorkspaceItem =
  | { id: string; restricted: true; sortOrder: number; addedAt: string }
  | {
      id: string;
      restricted: false;
      evidenceId: string;
      syncOffsetMs: number;
      sortOrder: number;
      notes: string | null;
      addedBy: { id: string; fullName: string };
      addedAt: string;
      evidence: ItemEvidence;
    };
export type VisibleItem = Extract<WorkspaceItem, { restricted: false }>;

export interface BookmarkRow {
  id: string;
  evidenceId: string;
  workspaceId: string | null;
  workspaceTitle: string | null;
  timeMs: number;
  label: string;
  user: { id: string; fullName: string };
  createdAt: string;
  canDelete: boolean;
}
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface AnnotationRow {
  id: string;
  evidenceId: string;
  workspaceId: string | null;
  workspaceTitle: string | null;
  kind: 'NOTE' | 'HIGHLIGHT' | 'REGION';
  startMs: number;
  endMs: number | null;
  body: string | null;
  region: Region | null;
  color: string | null;
  author: { id: string; fullName: string };
  createdAt: string;
  updatedAt: string;
  deleted: boolean;
  deletedAt: string | null;
  deletedBy: string | null;
  canEdit: boolean;
}
export interface Lane {
  itemId: string;
  evidenceId: string;
  evidenceNumber: string | null;
  title: string | null;
  start: string;
  end: string;
  durationMs: number;
  syncOffsetMs: number;
  suggestedOffsetMs: number;
}
export type TimelineEntry =
  | { kind: 'RECORDING'; at: string; end: string; evidenceId: string; itemId: string; label: string }
  | { kind: 'EVENT'; at: string; id: string; title: string; description: string | null; evidenceId: string | null; timeMs: number | null; restricted: boolean; createdBy: string }
  | { kind: 'BOOKMARK'; at: string; id: string; evidenceId: string; timeMs: number; label: string; user: string }
  | { kind: 'ANNOTATION'; at: string; end: string | null; id: string; evidenceId: string; annotationKind: string; startMs: number; endMs: number | null; body: string | null; color: string | null; author: string };
export interface Overlap {
  a: string;
  b: string;
  start: string;
  end: string;
  durationMs: number;
  aTimeMs: number;
  bTimeMs: number;
}
export interface Timeline {
  range: { start: string; end: string } | null;
  lanes: Lane[];
  entries: TimelineEntry[];
  overlaps: Overlap[];
  unplaced: TimelineEntry[];
  unplacedItems: Array<{ itemId: string; evidenceId: string; evidenceNumber: string | null }>;
}
export interface RelationRow {
  id: string;
  relation: RelationType;
  note: string | null;
  createdAt: string;
  createdBy: { id: string; fullName: string };
  evidenceA: { id: string; evidenceNumber: string | null; title: string | null };
  evidenceB: { id: string; evidenceNumber: string | null; title: string | null };
}

export const wsKeys = {
  all: ['workspaces'] as const,
  list: (q: Record<string, unknown>) => ['workspaces', 'list', q] as const,
  detail: (id: string) => ['workspaces', id] as const,
  items: (id: string) => ['workspaces', id, 'items'] as const,
  timeline: (id: string) => ['workspaces', id, 'timeline'] as const,
  bookmarks: (evidenceId: string, workspaceId?: string) => ['workspaces', 'bookmarks', evidenceId, workspaceId ?? ''] as const,
  annotations: (evidenceId: string, workspaceId?: string, deleted?: boolean) => ['workspaces', 'annotations', evidenceId, workspaceId ?? '', !!deleted] as const,
  relations: (evidenceId: string) => ['workspaces', 'relations', evidenceId] as const,
};

export function useWorkspaces(q: { scope?: string; status?: string; q?: string; page?: number; pageSize?: number }) {
  return useQuery({ queryKey: wsKeys.list(q), queryFn: () => api.get<{ items: WorkspaceSummary[]; total: number; page: number; pageSize: number }>('/workspaces', q) });
}
export function useWorkspace(id: string) {
  return useQuery({ queryKey: wsKeys.detail(id), queryFn: () => api.get<WorkspaceDetail>(`/workspaces/${id}`) });
}
export function useItems(id: string) {
  return useQuery({ queryKey: wsKeys.items(id), queryFn: () => api.get<{ items: WorkspaceItem[] }>(`/workspaces/${id}/items`) });
}
export function useTimeline(id: string, enabled = true) {
  return useQuery({ queryKey: wsKeys.timeline(id), queryFn: () => api.get<Timeline>(`/workspaces/${id}/timeline`), enabled });
}
export function useBookmarks(evidenceId: string, workspaceId?: string) {
  return useQuery({ queryKey: wsKeys.bookmarks(evidenceId, workspaceId), queryFn: () => api.get<{ items: BookmarkRow[] }>('/workspaces/bookmarks', { evidenceId, workspaceId }) });
}
export function useAnnotations(evidenceId: string, workspaceId?: string, includeDeleted = false) {
  return useQuery({
    queryKey: wsKeys.annotations(evidenceId, workspaceId, includeDeleted),
    queryFn: () => api.get<{ items: AnnotationRow[] }>('/workspaces/annotations', { evidenceId, workspaceId, includeDeleted: includeDeleted ? 'true' : undefined }),
  });
}
export function useRelations(evidenceId: string, enabled = true) {
  return useQuery({ queryKey: wsKeys.relations(evidenceId), queryFn: () => api.get<{ items: RelationRow[] }>('/workspaces/relations', { evidenceId }), enabled });
}

/** Mutation that invalidates everything workspace-related (small data sets; keeps views consistent). */
export function useWsMutation<V, R = unknown>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: wsKeys.all });
      void qc.invalidateQueries({ queryKey: ['search', 'related'] });
    },
  });
}

export const canEdit = (role: WsRole | undefined) => role === 'OWNER' || role === 'EDITOR';
