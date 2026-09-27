/**
 * AI task gates (EXT-4 ANPR licence, EXT-5 face recognition DPIA): the deployment's AI_TASKS_ENABLED list plus the
 * recorded legal approvals (system setting aiLegalApprovals). Used by the API (reject + hide), and the isolated
 * AI worker (refuse), so a gated task cannot run even if a job row is inserted directly.
 */
import { AI_TASKS, aiTaskGate, parseAiTaskList, PRODUCTION_DEFAULT_AI_TASKS, type AiLegalApprovals, type AiTask, type AiTaskGate } from '@ksp/shared';
import type { AppConfig } from './config.js';

export { LEGALLY_GATED_AI_TASKS } from '@ksp/shared';

export function enabledAiTasks(cfg: Pick<AppConfig, 'AI_TASKS_ENABLED' | 'NODE_ENV'>): AiTask[] {
  return parseAiTaskList(cfg.AI_TASKS_ENABLED, cfg.NODE_ENV === 'production' ? PRODUCTION_DEFAULT_AI_TASKS : AI_TASKS);
}

export function aiLegalGatesEnforced(cfg: Pick<AppConfig, 'AI_LEGAL_GATES' | 'NODE_ENV'>): boolean {
  return (cfg.AI_LEGAL_GATES ?? (cfg.NODE_ENV === 'production' ? 'enforce' : 'off')) === 'enforce';
}

export function aiTaskGates(cfg: Pick<AppConfig, 'AI_TASKS_ENABLED' | 'AI_LEGAL_GATES' | 'NODE_ENV'>, approvals: Partial<AiLegalApprovals> | null | undefined): Record<AiTask, AiTaskGate> {
  const enabled = enabledAiTasks(cfg);
  const enforce = aiLegalGatesEnforced(cfg);
  return Object.fromEntries(AI_TASKS.map((t) => [t, aiTaskGate(t, enabled, approvals ?? {}, enforce)])) as Record<AiTask, AiTaskGate>;
}
