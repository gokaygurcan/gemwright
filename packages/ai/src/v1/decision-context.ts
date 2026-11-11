import { FIGHTER_GOAL, LIFE_GOAL } from './life-goal';
import type { ResidentGoal } from './resident-goal';
import type { Checkpoint } from './store';

const intention = (goal: ResidentGoal | undefined) =>
  goal
    ? {
        id: goal.intent?.id,
        key: goal.key,
        kind: goal.kind,
        step: goal.step,
        deadline: Math.min(goal.until, goal.stepUntil),
        blocker: goal.blocker,
        outcome: goal.intent?.outcome,
        why: goal.intent?.why,
        completionEvidence: goal.intent?.completionEvidence,
        budget: goal.intent?.budget ?? { maxSpend: goal.budget },
        riskBudget: goal.intent?.riskBudget,
        deathRisk: goal.intent?.estimate.deathRisk
      }
    : null;

export function decisionContext(checkpoint: Checkpoint, now = Date.now()) {
  const work = checkpoint.workGoal;
  return {
    lifeGoal: LIFE_GOAL,
    fighterGoal: FIGHTER_GOAL,
    active: intention(work?.active),
    suspended: intention(work?.suspended),
    personalGoal: checkpoint.personal?.goals.find((goal) => goal.state === 'active') ?? null,
    life: checkpoint.life
      ? { phase: checkpoint.life.phase, until: checkpoint.life.until, city: checkpoint.life.city }
      : null,
    habits: checkpoint.personal?.habits ?? null,
    failures: Object.entries(work?.failed ?? {})
      .filter(([, failure]) => failure.until > now)
      .slice(-6)
      .map(([key, failure]) => ({ key, until: failure.until, reason: failure.reason })),
    blockedErrands: Object.entries(checkpoint.objectives ?? {})
      .filter(([, failure]) => failure.until > now)
      .sort(([, a], [, b]) => b.until - a.until)
      .slice(0, 4)
      .map(([key, failure]) => ({ key, until: failure.until, reason: failure.reason })),
    assumptions: (work?.assumptions ?? []).slice(-4).map(({ claim, status, reason, until }) => ({
      claim,
      status,
      reason,
      until
    })),
    outcomes: (work?.outcomes ?? []).slice(-4).map(({ key, method, result, reason, at, wealth, capability }) => ({
      key,
      method,
      result,
      reason,
      at,
      wealth,
      capability
    }))
  };
}

// World packets do not cover a cancellation or a planner changing its mind while a request is in flight.
export const decisionContextRevision = (checkpoint: Checkpoint) =>
  JSON.stringify([
    intention(checkpoint.workGoal?.active),
    intention(checkpoint.workGoal?.suspended),
    checkpoint.workGoal?.failed,
    checkpoint.workGoal?.assumptions,
    checkpoint.workGoal?.outcomes,
    checkpoint.objectives,
    checkpoint.personal?.goals.find((goal) => goal.state === 'active'),
    checkpoint.personal?.commitment,
    checkpoint.personal?.orders.filter((order) => ['accepted', 'ready'].includes(order.state)),
    checkpoint.life,
    checkpoint.personal?.habits
  ]);
