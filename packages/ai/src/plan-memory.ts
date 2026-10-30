import type { PlanEstimate } from './intent';
import { planningCondition } from './intent';
import { recordAssumption } from './plan-assumptions';
import { outcomeLabels } from './plan-calibration';
import type { GoalSituation, ResidentGoal } from './resident-goal';
import type { Checkpoint } from './store';
import { checkpointEvent } from './telemetry';
import { earnedGold, skillGrowth } from './work-evidence';

export interface PlanOutcome {
  id: string;
  key: string;
  kind: ResidentGoal['kind'];
  method?: ResidentGoal['step'];
  // Fine key: what the resident carried and could afford at the time. Coarse key: where and as
  // whom — the part that survives a shopping trip, so a failure is not forgotten by crossing a
  // boundary. Advice matches either.
  condition: string;
  coarse?: string;
  at: number;
  result: 'completed' | 'blocked' | 'died';
  prediction?: PlanEstimate;
  durationMs?: number;
  died?: boolean;
  loss?: number | null;
  reason: string;
  wealth: number | null;
  capability: number | null;
}
export function rememberPlan(
  checkpoint: Checkpoint,
  goal: ResidentGoal,
  result: PlanOutcome['result'],
  reason: string,
  state?: GoalSituation,
  now = Date.now()
) {
  checkpoint.workGoal ??= {};
  const outcomes = checkpoint.workGoal.outcomes ?? [];
  const id = goal.intent?.id ?? `intent:${goal.started}:${goal.key}`;
  const previous = outcomes.find((old) => old.id === id);
  if (previous?.result === 'died' && result !== 'died') return;
  if (!previous || previous.result !== result) recordAssumption(checkpoint, goal, result, reason, now);
  const wealth =
    state && goal.before.bankKnown === state.evidence.bankKnown ? earnedGold(goal.before, state.evidence) : null;
  const entry: PlanOutcome = {
    id,
    coarse: state?.planning?.coarse,
    prediction: goal.intent?.prediction ?? goal.intent?.estimate,
    durationMs: Math.max(0, now - goal.started),
    died: outcomeLabels(state, result),
    loss: wealth === null ? null : result === 'completed' ? 0 : Math.max(0, -wealth),
    key: goal.key,
    kind: goal.kind,
    method: goal.intent?.prediction.method ?? goal.step,
    condition: goal.intent?.condition ?? (state ? planningCondition(state) : ''),
    at: now,
    result,
    reason: reason.slice(0, 240),
    wealth:
      state && goal.before.bankKnown === state.evidence.bankKnown ? earnedGold(goal.before, state.evidence) : null,
    capability: state ? skillGrowth(goal.before, state.evidence) : null
  };
  checkpointEvent(
    checkpoint,
    'planning',
    'intent_outcome',
    result === 'died' || result === 'blocked' ? 'failed' : 'completed',
    { ...entry },
    { intentId: goal.intent?.id, traceId: goal.intent?.id }
  );
  checkpoint.workGoal.outcomes = [
    ...outcomes.filter((old) => old.id !== id && now - old.at < 7 * 86400_000),
    entry
  ].slice(-32);
}
export function planAdvice(
  checkpoint: Checkpoint,
  kind: ResidentGoal['kind'],
  condition: string,
  now = Date.now(),
  method?: ResidentGoal['step'],
  coarse?: string
) {
  const events = (checkpoint.workGoal?.outcomes ?? []).filter(
    (event) =>
      event.kind === kind &&
      (!method || !event.method || event.method === method) &&
      (event.condition === condition || (coarse !== undefined && event.coarse === coarse)) &&
      event.at <= now &&
      now - event.at < 86400_000
  );
  let success = 0,
    failure = 0;
  for (const event of events) {
    const weight = 1 - (now - event.at) / 86400_000;
    if (event.result === 'completed') success += weight;
    else failure += weight;
  }
  // A small sample can alter preference, but cannot become a permanent prohibition.
  return {
    samples: events.length,
    penalty: Math.min(40, Math.max(0, (failure - success) * 12) / Math.sqrt(1 + events.length))
  };
}
