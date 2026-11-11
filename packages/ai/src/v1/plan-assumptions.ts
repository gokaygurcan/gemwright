import type { GoalKind, ResidentGoal } from './resident-goal';
import type { Checkpoint } from './store';

export interface PlanAssumption {
  id: string;
  claim: string;
  condition: string;
  status: 'unverified' | 'supported' | 'invalidated';
  evidence: string[];
  checkedAt: number;
  until: number;
  failures: number;
  reason?: string;
}
export const assumptionId = (kind: GoalKind | 'income', condition: string) => `${kind}:${condition}`;
export function progressAssumption(
  checkpoint: Checkpoint,
  kind: GoalKind | 'income',
  condition: string,
  now = Date.now()
): PlanAssumption {
  const existing = checkpoint.workGoal?.assumptions?.find((entry) => entry.id === assumptionId(kind, condition));
  if (existing)
    return existing.status === 'invalidated' && existing.until <= now
      ? { ...existing, status: 'unverified', reason: 'Failure cooldown expired; a bounded probe is permitted' }
      : existing;
  return {
    id: assumptionId(kind, condition),
    claim: `The current ${kind} method can advance the intended outcome under these conditions`,
    condition,
    status: 'unverified',
    evidence: [],
    checkedAt: now,
    until: 0,
    failures: 0
  };
}
export function recordAssumption(
  checkpoint: Checkpoint,
  goal: ResidentGoal,
  result: 'completed' | 'blocked' | 'died',
  reason: string,
  now: number
) {
  if (!goal.intent) return;
  checkpoint.workGoal ??= {};
  const memory = checkpoint.workGoal;
  const old = progressAssumption(
    checkpoint,
    goal.intent.prediction.method === 'income' || goal.step === 'income' ? 'income' : goal.kind,
    goal.intent.condition,
    now
  );
  const failed = result !== 'completed';
  const failures = failed ? old.failures + 1 : 0;
  const updated: PlanAssumption = {
    ...old,
    status: failed ? 'invalidated' : 'supported',
    failures,
    checkedAt: now,
    until: failed ? now + Math.min(30 * 60_000, 120_000 * 2 ** Math.min(4, failures - 1)) : 0,
    reason: reason.slice(0, 240),
    evidence: [goal.intent.id]
  };
  memory.assumptions = [...(memory.assumptions ?? []).filter((entry) => entry.id !== updated.id), updated].slice(-16);
  goal.intent.assumptions = goal.intent.assumptions.map((entry) => (entry.id === updated.id ? updated : entry));
}
