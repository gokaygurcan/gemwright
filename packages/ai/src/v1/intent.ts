import { type IntentEvidence, intentEvidence, intentRationale } from './intent-evidence';
import { LIFE_GOAL } from './life-goal';
import type { PlanAssumption } from './plan-assumptions';
import type { GoalKind, GoalSituation, GoalStep, ResidentGoal } from './resident-goal';

export interface PlanEstimate {
  source: 'policy-estimate' | 'outcome-calibrated';
  method?: GoalStep;
  calibration?: { samples: number; effectiveSamples: number; horizonMs: number; deaths: number; censored: number };
  coefficients?: { alpha: number; beta: number; samples: number; provenance: string };
  wealth: number;
  capability: number;
  loss: number;
  cost: number;
  deathRisk: number | null;
  uncertainty: number;
}
export interface ResidentIntent {
  id: string;
  lifeGoal?: string;
  evidence: IntentEvidence[];
  assumptions: PlanAssumption[];
  budget: { maxSpend: number; spent: number; reserved: number; reserve: number; deadline: number };
  outcome: string;
  why: string;
  prerequisites: string[];
  steps: GoalStep[];
  currentStep: GoalStep;
  completionEvidence: string;
  interruption: string[];
  recovery: string;
  condition: string;
  estimate: PlanEstimate;
  prediction: PlanEstimate;
  utility: number;
  riskBudget: number;
}
export interface PlanningContext {
  condition: string;
  // Where and as whom: the part of the condition that outlives a shopping trip (plan-memory.ts).
  coarse: string;
  evidence?: IntentEvidence[];
  available: boolean;
  riskTolerance: number;
  exposed: number;
  securable: number;
  escapeKnown: boolean;
  uncertainty: number;
  deathRisk: number | null;
}
const descriptions: Record<GoalKind, { outcome: string; steps: GoalStep[]; evidence: string }> = {
  recover: {
    outcome: 'Recover to safe working health',
    steps: ['recover'],
    evidence: 'Alive, no immediate aggression or poison, and working health observed'
  },
  equip: {
    outcome: 'Obtain usable tools and supplies',
    steps: ['equip', 'trade', 'settle'],
    evidence: 'Required work tool observed and ready'
  },
  order: {
    outcome: 'Fulfil the accepted bulk order',
    steps: ['equip', 'order', 'settle'],
    evidence: 'Vendor acceptance observed; production alone is insufficient'
  },
  commitment: {
    outcome: 'Complete the agreed commitment',
    steps: ['commitment', 'settle'],
    evidence: 'The specific commitment is observed completed'
  },
  earn: {
    outcome: 'Increase net wealth through the trade',
    steps: ['trade', 'settle'],
    evidence: 'Comparable before/after funds show a net gain'
  },
  learn: {
    outcome: 'Improve trade capability within budget',
    steps: ['trade', 'settle'],
    evidence: 'Relevant base skills increase within the spending budget'
  }
};
export function describeIntent(
  goal: ResidentGoal,
  state: GoalSituation,
  estimate: PlanEstimate,
  utility: number,
  riskBudget: number
): ResidentIntent {
  const description = descriptions[goal.kind];
  const rationale = intentRationale(goal, state);
  return {
    id: `intent:${crypto.randomUUID()}`,
    lifeGoal: LIFE_GOAL,
    evidence: intentEvidence(goal, state),
    assumptions: [],
    budget: {
      maxSpend: goal.budget,
      spent: 0,
      reserved: 0,
      reserve: Math.min(150, state.evidence.funds),
      deadline: goal.until
    },
    outcome: goal.step === 'wait' ? 'Reconcile blocked methods before resuming work' : description.outcome,
    why: goal.step === 'wait' ? 'No productive method currently satisfies the plan prerequisites' : rationale.why,
    prerequisites: rationale.prerequisites,
    steps:
      goal.step === 'wait'
        ? ['wait']
        : goal.step === 'income'
          ? ['income', 'equip', 'trade', 'settle']
          : [...description.steps],
    currentStep: goal.step,
    completionEvidence:
      goal.step === 'wait'
        ? 'Changed observations or an expired failure cooldown permit replanning'
        : description.evidence,
    interruption: rationale.interruption,
    recovery: rationale.recovery,
    condition: planningCondition(state),
    estimate,
    prediction: structuredClone(estimate),
    utility,
    riskBudget
  };
}
export function planningCondition(state: GoalSituation): string {
  const context =
    state.planning?.condition ??
    JSON.stringify([
      state.ready,
      state.evidence.bankKnown,
      Math.floor(Math.log2(Math.max(0, state.evidence.funds) + 1)),
      Object.entries(state.evidence.skills)
        .sort()
        .map(([id, value]) => [id, Math.floor(value / 10)])
    ]);
  return `${context}|${state.order ?? ''}|${state.commitment ?? ''}`;
}
