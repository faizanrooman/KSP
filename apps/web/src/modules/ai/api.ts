/** Data hooks for /api/v1/ai and /api/v1/review. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AiDetectionDto, AiJobDto, AiModelDto, AiTask, AiTaskDto, ReviewAction, ReviewEventDto } from '@ksp/shared';
import { api } from '@/lib/api';

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
export type QueueItem = AiDetectionDto & { reviewedByMe: boolean; dualApproval: boolean };

export const aiKeys = {
  tasks: ['ai', 'tasks'] as const,
  jobs: (evidenceId: string) => ['ai', 'jobs', evidenceId] as const,
  detections: (evidenceId: string) => ['ai', 'detections', evidenceId] as const,
  watchlistsFor: (evidenceId: string) => ['ai', 'watchlists-for', evidenceId] as const,
  queue: ['review', 'queue'] as const,
  history: (id: string) => ['review', 'history', id] as const,
  models: ['ai', 'models'] as const,
  watchlists: ['ai', 'watchlists'] as const,
  watchlist: (id: string) => ['ai', 'watchlist', id] as const,
  exports: ['ai', 'training-exports'] as const,
};

export const useAiTasks = () => useQuery({ queryKey: aiKeys.tasks, queryFn: () => api.get<{ items: AiTaskDto[] }>('/ai/tasks'), staleTime: 60_000 });

export function useEvidenceJobs(evidenceId: string) {
  return useQuery({
    queryKey: aiKeys.jobs(evidenceId),
    queryFn: () => api.get<{ items: AiJobDto[] }>(`/ai/evidence/${evidenceId}/jobs`),
    refetchInterval: (q) => (q.state.data?.items.some((j) => j.status === 'QUEUED' || j.status === 'RUNNING') ? 2000 : false),
  });
}

export function useDetections(evidenceId: string, filters: { task?: string; reviewStatus?: string; minConfidence?: string; label?: string }) {
  return useQuery({
    queryKey: [...aiKeys.detections(evidenceId), filters],
    queryFn: () => api.get<Paged<AiDetectionDto>>(`/ai/evidence/${evidenceId}/detections`, { ...filters, pageSize: 500 }),
    staleTime: 30_000,
  });
}

export const useEvidenceWatchlists = (evidenceId: string, enabled: boolean) =>
  useQuery({
    queryKey: aiKeys.watchlistsFor(evidenceId),
    queryFn: () => api.get<{ items: Array<{ id: string; name: string; kind: 'FACE' | 'VEHICLE'; orgUnitName: string; entries: number; readyEntries: number }> }>(`/ai/evidence/${evidenceId}/watchlists`),
    enabled,
  });

export function useRequestJob(evidenceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { tasks: AiTask[]; sampleFps?: number; thresholds?: Partial<Record<AiTask, number>>; watchlistIds?: string[] }) => api.post<AiJobDto>(`/ai/evidence/${evidenceId}/jobs`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: aiKeys.jobs(evidenceId) }),
  });
}

export function useCancelJob(evidenceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => api.post<AiJobDto>(`/ai/jobs/${jobId}/cancel`),
    onSuccess: () => qc.invalidateQueries({ queryKey: aiKeys.jobs(evidenceId) }),
  });
}

export function useReviewQueue(q: Record<string, string>) {
  return useQuery({ queryKey: [...aiKeys.queue, q], queryFn: () => api.get<Paged<QueueItem>>('/review/queue', q), placeholderData: (prev) => prev });
}

export const useHistory = (id: string | null) =>
  useQuery({ queryKey: aiKeys.history(id ?? ''), queryFn: () => api.get<{ detection: AiDetectionDto; events: ReviewEventDto[] }>(`/review/detections/${id}/history`), enabled: !!id });

export function useReview() {
  const qc = useQueryClient();
  const done = () => {
    void qc.invalidateQueries({ queryKey: aiKeys.queue });
    void qc.invalidateQueries({ queryKey: ['ai', 'detections'] });
    void qc.invalidateQueries({ queryKey: ['review', 'history'] });
  };
  return {
    one: useMutation({
      mutationFn: (v: { id: string; action: ReviewAction; comment?: string; correctedLabel?: string }) => api.post<AiDetectionDto & { tagCreated: string | null }>(`/review/detections/${v.id}`, { action: v.action, comment: v.comment, correctedLabel: v.correctedLabel }),
      onSuccess: done,
    }),
    bulk: useMutation({
      mutationFn: (items: Array<{ id: string; action: ReviewAction; comment?: string }>) =>
        api.post<{ results: Array<{ id: string; ok: boolean; status?: string; error?: { code: string; message: string } }>; succeeded: number; failed: number }>('/review/detections/bulk', { items }),
      onSuccess: done,
    }),
  };
}

export const useModels = () => useQuery({ queryKey: aiKeys.models, queryFn: () => api.get<{ items: AiModelDto[] }>('/ai/models') });

export interface WatchlistSummary {
  id: string;
  name: string;
  kind: 'FACE' | 'VEHICLE';
  orgUnit: { id: string; name: string };
  description: string | null;
  entries: number;
  createdAt: string;
}
export interface WatchlistEntry {
  id: string;
  label: string;
  plate: string | null;
  notes: string | null;
  hasImage: boolean;
  imageUrl: string | null;
  embeddingStatus: 'READY' | 'FAILED' | 'PENDING' | 'N/A';
  embeddingError: string | null;
  model: { code: string; version: string } | null;
  createdAt: string;
}
export const useWatchlists = () => useQuery({ queryKey: aiKeys.watchlists, queryFn: () => api.get<{ items: WatchlistSummary[] }>('/ai/watchlists') });
export const useWatchlist = (id: string | null) =>
  useQuery({
    queryKey: aiKeys.watchlist(id ?? ''),
    queryFn: () => api.get<WatchlistSummary & { entries: WatchlistEntry[] }>(`/ai/watchlists/${id}`),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data?.entries.some((e) => e.embeddingStatus === 'PENDING') ? 3000 : false),
  });

export interface TrainingExport {
  id: string;
  task: AiTask;
  modelId: string | null;
  sampleCount: number;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  files: string[];
  filter: { from: string; to: string };
}
export const useTrainingExports = () =>
  useQuery({
    queryKey: aiKeys.exports,
    queryFn: () => api.get<{ items: TrainingExport[] }>('/ai/training-exports'),
    refetchInterval: (q) => (q.state.data?.items.some((e) => e.status === 'QUEUED' || e.status === 'RUNNING') ? 3000 : false),
  });
