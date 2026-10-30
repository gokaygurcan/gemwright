import { type PlanEstimate, planningCondition } from './intent';
import { progressAssumption } from './plan-assumptions';
import { calibrateEstimate, calibration } from './plan-calibration';
import { planAdvice } from './plan-memory';
import type { GoalKind, GoalSituation, GoalStep } from './resident-goal';
import type { Checkpoint } from './store';

export interface GoalProposal {
  kind: GoalKind;
  key: string;
  estimate: PlanEstimate;
  riskBudget: number;
  utility: number;
  allowed: boolean;
  reason: string;
  step?: GoalStep;
}
export function riskBudget(state: GoalSituation) {
  const context = state.planning;
  const tolerance = Math.min(1, Math.max(0, context?.riskTolerance ?? 0.5));
  // Only securable goods count as exposure: a resident's working gear cannot be banked away, so
  // including it would gate any geared resident whose cash is smaller than its kit. The penalty is
  // capped too: unbounded, a resident carrying valuable goods no shop buys (funds 0, cargo in the
  // thousands) would never be allowed to work again.
  const exposure = Math.max(0, context?.securable ?? context?.exposed ?? state.evidence.gold);
  const ratio = Math.min(4, exposure / Math.max(150, state.evidence.funds));
  const uncertainty = Math.min(1, Math.max(0, context?.uncertainty ?? 1));
  return (
    ((0.02 + tolerance * 0.04) / (1 + ratio)) * (context?.escapeKnown === false ? 0.8 : 1) * (1 - 0.5 * uncertainty)
  );
}
export const utility = (estimate: PlanEstimate) =>
  estimate.wealth +
  (estimate.coefficients?.alpha ?? 2) * estimate.capability -
  (estimate.coefficients?.beta ?? 4) * estimate.loss -
  estimate.cost;
export function proposeGoals(checkpoint: Checkpoint, state: GoalSituation, now = Date.now()): GoalProposal[] {
  const condition = planningCondition(state);
  const blocked = (key: string) => {
    if (
      ['recover', 'equip', 'earn', 'learn', 'order', 'commitment'].includes(key) &&
      progressAssumption(checkpoint, key as GoalKind, condition, now).status === 'invalidated'
    )
      return true;
    const failed = checkpoint.workGoal?.failed?.[key];
    return !!failed && failed.until > now && (!failed.condition || failed.condition === condition);
  };
  const budget = riskBudget(state);
  const proposal = (
    kind: GoalKind,
    key: string,
    wealth: number,
    capability: number,
    cost: number,
    prerequisite: boolean
  ): GoalProposal => {
    const recovery = kind === 'recover';
    const deathRisk = recovery ? null : (state.planning?.deathRisk ?? null);
    const uncertainty = state.planning?.uncertainty ?? 1;
    const loss = (deathRisk ?? 0) * Math.max(state.evidence.gold, state.planning?.exposed ?? 0);
    const failedKey =
      kind === 'earn' &&
      (!state.ready ||
        blocked('earn') ||
        blocked('learn') ||
        (checkpoint.workGoal?.active?.step === 'income' && !!checkpoint.workGoal.active.incomeTrade))
        ? 'income'
        : key;
    const prior: PlanEstimate = {
      source: 'policy-estimate',
      method: failedKey === 'income' ? 'income' : kind === 'earn' || kind === 'learn' ? 'trade' : kind,
      wealth,
      capability,
      loss,
      cost,
      deathRisk,
      uncertainty
    };
    const estimate = calibrateEstimate(checkpoint, kind, condition, prior, now);
    estimate.coefficients = calibration(checkpoint, now);

    const riskAllowed =
      recovery ||
      !state.planning ||
      (state.planning.available && estimate.deathRisk !== null && estimate.deathRisk <= budget);

    const assumption = progressAssumption(checkpoint, failedKey === 'income' ? 'income' : kind, condition, now);
    const allowed =
      prerequisite &&
      !(failedKey === 'income' && state.coreStale && state.ready) &&
      ((recovery && state.recoveryPending) || (!blocked(failedKey) && assumption.status !== 'invalidated')) &&
      riskAllowed;
    return {
      kind,
      key,
      estimate,
      riskBudget: budget,
      utility:
        utility(estimate) -
        planAdvice(checkpoint, kind, condition, now, estimate.method, state.planning?.coarse).penalty,
      allowed,
      reason: !prerequisite
        ? 'Prerequisite unavailable'
        : blocked(key)
          ? 'Unchanged failed context is cooling down'
          : !riskAllowed
            ? 'Risk is unknown or exceeds the budget; recover and reconcile first'
            : 'Prerequisites and risk budget permit this plan'
    };
  };
  // Values are policy priors in comparable utility units, not promises about shard rewards.
  return [
    proposal(
      'recover',
      'recover',
      0,
      0,
      0,
      !state.safe ||
        state.planning?.available === false ||
        state.planning?.deathRisk === null ||
        (state.planning?.deathRisk ?? 0) > budget
    ),
    proposal('equip', 'equip', 140, 0, 10, state.safe && !state.ready),
    proposal('order', state.order ?? 'order', 130, 5, 15, state.safe && !!state.order),
    proposal('commitment', state.commitment ?? 'commitment', 100, 5, 10, state.safe && !!state.commitment),
    proposal(
      'learn',
      'learn',
      10,
      35,
      10,
      state.safe &&
        state.ready &&
        state.learning &&
        !state.earningNeeded &&
        !(checkpoint.workGoal?.last?.key === 'learn' && checkpoint.workGoal.last.result === 'completed')
    ),
    proposal('earn', 'earn', state.earningNeeded ? 100 : 55, 5, 10, state.safe)
  ];
}
export function selectGoal(checkpoint: Checkpoint, state: GoalSituation, now = Date.now()): GoalProposal {
  const proposals = proposeGoals(checkpoint, state, now);
  const selected = proposals.filter((candidate) => candidate.allowed).sort((a, b) => b.utility - a.utility)[0];
  const recovery = proposals[0];
  if (!recovery) throw new Error('Planner requires a recovery proposal');
  return (
    selected ?? {
      ...recovery,
      allowed: true,
      key: 'wait',
      step: 'wait',
      reason: 'No admissible productive plan; wait for changed evidence or a bounded retry'
    }
  );
}
