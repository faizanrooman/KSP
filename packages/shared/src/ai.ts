/**
 * AI analysis & human-review contracts shared by API, isolated AI worker and web.
 * No AI output is authoritative until a human reviewer approves it (docs/AI-ARCHITECTURE.md).
 */
import { AI_TASKS, type AiTask, type ReviewStatus } from './domain.js';

export const AI_TASK_INFO: Record<AiTask, { label: string; description: string; dependsOn?: AiTask[] }> = {
  PERSON_DETECTION: { label: 'Person detection', description: 'Locates people in sampled frames.' },
  OBJECT_DETECTION: { label: 'Object & vehicle detection', description: 'COCO objects: vehicles, bags, knives, phones… with dominant colour.' },
  FACE_DETECTION: { label: 'Face detection', description: 'Locates faces (no identity claim).' },
  FACE_RECOGNITION: { label: 'Face recognition (watchlist)', description: 'Compares detected faces against FACE watchlists. Matches need two independent approvals.', dependsOn: ['FACE_DETECTION'] },
  ANPR: { label: 'Number plate recognition', description: 'Detects and reads licence plates; flags VEHICLE watchlist hits.' },
  CLASSIFICATION: { label: 'Evidence tagging', description: 'Suggests evidence-level tags (person, vehicle, weapon:knife, crowd). Tags are applied only after approval.', dependsOn: ['OBJECT_DETECTION'] },
};

/** Tasks that need a recorded legal approval (settings.aiLegalApprovals) while AI legal gates are enforced. */
export const LEGALLY_GATED_AI_TASKS = ['FACE_DETECTION', 'FACE_RECOGNITION', 'ANPR'] as const satisfies readonly AiTask[];
export type LegallyGatedAiTask = (typeof LEGALLY_GATED_AI_TASKS)[number];
/** AI_TASKS_ENABLED default in production (no biometric / licence-restricted processing). */
export const PRODUCTION_DEFAULT_AI_TASKS: readonly AiTask[] = ['OBJECT_DETECTION', 'PERSON_DETECTION', 'CLASSIFICATION'];

export type AiTaskGateReason = 'DISABLED_BY_DEPLOYMENT' | 'LEGAL_APPROVAL_REQUIRED';
export interface AiTaskGate {
  task: AiTask;
  allowed: boolean;
  reason: AiTaskGateReason | null;
  explanation: string | null;
  approval: { approvedBy: string; reference: string; date: string } | null;
}

/**
 * Whether a task may run. `enabled` = the deployment's AI_TASKS_ENABLED list; `approvals` = settings.aiLegalApprovals.
 * A task needed only as an internal dependency (FACE_DETECTION for FACE_RECOGNITION) is covered by the parent's approval.
 */
export function aiTaskGate(
  task: AiTask,
  enabled: readonly AiTask[],
  approvals: Partial<Record<LegallyGatedAiTask, { approvedBy: string; reference: string; date: string } | null>>,
  enforceLegal: boolean,
): AiTaskGate {
  if (!enabled.includes(task)) {
    return { task, allowed: false, reason: 'DISABLED_BY_DEPLOYMENT', explanation: `${AI_TASK_INFO[task].label} is not enabled on this deployment (AI_TASKS_ENABLED).`, approval: null };
  }
  const gated = (LEGALLY_GATED_AI_TASKS as readonly AiTask[]).includes(task);
  const a = gated ? (approvals[task as LegallyGatedAiTask] ?? null) : null;
  if (gated && enforceLegal && !a) {
    return { task, allowed: false, reason: 'LEGAL_APPROVAL_REQUIRED', explanation: `${AI_TASK_INFO[task].label} is disabled until a system administrator records the legal approval reference (biometric / licence review).`, approval: null };
  }
  return { task, allowed: true, reason: null, explanation: null, approval: a ? { approvedBy: a.approvedBy, reference: a.reference, date: a.date } : null };
}

/** Parse an AI_TASKS_ENABLED value (comma-separated; `all` = every task). Unknown codes are ignored. */
export function parseAiTaskList(v: string | undefined, fallback: readonly AiTask[]): AiTask[] {
  if (v === undefined || v.trim() === '') return [...fallback];
  const parts = v.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (parts.includes('ALL')) return [...AI_TASKS];
  return AI_TASKS.filter((t) => parts.includes(t));
}

/** Tasks whose approval requires two approvals by different reviewers. */
export const DUAL_APPROVAL_TASKS: readonly AiTask[] = ['FACE_RECOGNITION'];

export const REVIEW_ACTIONS = ['APPROVE', 'REJECT', 'REQUEST_SECOND_REVIEW', 'COMMENT', 'CORRECT_LABEL'] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

export const AI_SAMPLE_FPS = { min: 0.1, max: 5, default: 1 } as const;

/** Per-job parameters (ai_jobs.params). */
export interface AiJobParams {
  sampleFps: number;
  thresholds: Partial<Record<AiTask, number>>;
  watchlistIds: string[];
  /** Keep one detection per track every N ms in addition to the best one. */
  keepEveryMs: number;
  /** CLASSIFICATION: minimum simultaneous persons for the 'crowd' tag. */
  crowdMinPersons: number;
}

/** Snapshot the API writes into ai_jobs.input so the isolated worker never reads the evidence table. */
export interface AiJobInput {
  derivativeBucket: string;
  derivativeKey: string;
  durationMs: number | null;
  frameRate: number | null;
  width: number | null;
  height: number | null;
  orgUnitId: string;
}

export interface AiJobStats {
  framesProcessed?: number;
  framesTotal?: number;
  detections?: Partial<Record<AiTask, number>>;
  rawDetections?: number;
  msPerFrame?: number;
  wallMs?: number;
  heartbeatAt?: string;
  cancelled?: boolean;
}

export interface AiModelDto {
  id: string;
  code: string;
  name: string;
  task: AiTask;
  version: string;
  runtime: string;
  artifactSha256: string | null;
  labels: string[];
  defaultThreshold: number;
  config: Record<string, unknown>;
  metrics: Record<string, unknown>;
  status: 'STAGED' | 'ACTIVE' | 'RETIRED';
  notes: string | null;
  createdAt: string;
  activatedAt: string | null;
  retiredAt: string | null;
}

export interface AiTaskDto {
  task: AiTask;
  label: string;
  description: string;
  available: boolean;
  /** Deployment / legal gate: false = the task is refused regardless of models (see `gate.explanation`). */
  allowed: boolean;
  gate: AiTaskGate;
  models: Array<Pick<AiModelDto, 'id' | 'code' | 'name' | 'version' | 'defaultThreshold' | 'labels'> & { licence: string | null }>;
}

export interface AiJobDto {
  id: string;
  evidenceId: string;
  tasks: AiTask[];
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  progress: number;
  params: AiJobParams;
  models: Array<{ id: string; code: string; version: string; task: AiTask }>;
  stats: AiJobStats;
  error: string | null;
  requestedBy: { id: string; fullName: string };
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface AiDetectionDto {
  id: string;
  jobId: string;
  evidenceId: string;
  evidenceNumber: string | null;
  task: AiTask;
  label: string;
  correctedLabel: string | null;
  confidence: number;
  threshold: number;
  model: { id: string; code: string; version: string };
  frameTimeMs: number;
  frameNumber: number | null;
  bbox: { x: number; y: number; w: number; h: number } | null;
  trackId: string | null;
  attributes: Record<string, unknown>;
  cropUrl: string | null;
  reviewStatus: ReviewStatus;
  reviewedBy: { id: string; fullName: string } | null;
  reviewedAt: string | null;
  reviewComment: string | null;
  approvals: number;
  createdAt: string;
}

export interface ReviewEventDto {
  id: number;
  action: ReviewAction;
  previousStatus: ReviewStatus;
  newStatus: ReviewStatus;
  comment: string | null;
  correctedLabel: string | null;
  reviewer: { id: string; fullName: string };
  modelVersion: string;
  confidence: number;
  createdAt: string;
}

/** Normalise a licence plate to A-Z0-9 (upper case). */
export function normalizePlate(v: string): string {
  return v.toUpperCase().replace(/[^A-Z0-9]/g, '');
}
