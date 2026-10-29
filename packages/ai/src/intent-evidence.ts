import type { GoalSituation, ResidentGoal } from './resident-goal';

export interface IntentEvidence {
  id: string;
  kind: 'reference' | 'observed' | 'inferred' | 'unknown';
  source: string;
  value: unknown;
  at?: number;
}
export function intentEvidence(goal: ResidentGoal, state: GoalSituation): IntentEvidence[] {
  const prefix = `intent:${goal.started}:${goal.key}`;
  const fact = (id: string, value: unknown, kind: IntentEvidence['kind'], source: string): IntentEvidence => ({
    id: `${prefix}:${id}`,
    value,
    kind,
    source
  });
  return [
    fact(
      'funds',
      { total: state.evidence.funds, bankKnown: state.evidence.bankKnown, carriedGold: state.evidence.gold },
      'inferred',
      'Inventory and last known banker balance'
    ),
    fact('skills', state.evidence.skills, 'observed', 'Relevant server skill readings'),
    fact('readiness', state.ready, 'inferred', 'Current tools and trade requirements'),
    fact(
      'target',
      state.order ?? state.commitment ?? goal.key,
      state.order || state.commitment ? 'observed' : 'inferred',
      state.order ? 'Carried accepted deed' : state.commitment ? 'Resident commitment record' : 'Goal selection'
    ),
    fact(
      'risk-context',
      state.planning
        ? {
            available: state.planning.available,
            deathRisk: state.planning.deathRisk,
            exposed: state.planning.exposed,
            escapeKnown: state.planning.escapeKnown
          }
        : null,
      state.planning ? 'inferred' : 'unknown',
      'Perception and risk policy'
    ),
    ...(state.planning?.evidence ?? [])
  ];
}
export function intentRationale(goal: ResidentGoal, state: GoalSituation) {
  const missing = Object.entries(state.evidence.skills).filter(([, value]) => value < 100);
  const funds = `${state.evidence.funds} known gold (${state.evidence.gold} carried; bank ${state.evidence.bankKnown ? 'known' : 'unknown'})`;
  const why =
    goal.kind === 'recover'
      ? `Work is unsafe or insufficiently observed; health reading ${state.evidence.health}, ${state.planning?.exposed ?? state.evidence.gold} gold of assets exposed`
      : goal.kind === 'order'
        ? `Accepted deed ${state.order ?? goal.key} remains unfinished; crafting and vendor acceptance support capability and income`
        : goal.kind === 'commitment'
          ? `Active agreement ${state.commitment ?? goal.key} requires completion before optional work`
          : goal.kind === 'equip'
            ? `Trade prerequisites are missing; ${funds} is available to restore earning capacity`
            : goal.kind === 'learn'
              ? `${missing.length} relevant skills remain below 100.0; invest from ${funds} within the spending limit`
              : `${state.earningNeeded ? 'Working reserves are low' : 'Productive trade is available'}; grow secure wealth from ${funds}`;
  return {
    why,
    prerequisites: [
      `Perception ${state.planning?.available === false ? 'unavailable: reconcile first' : 'available for admission'}`,
      `Tools ${state.ready ? 'ready' : 'missing: acquire tools or use an income alternative'}`,
      `Funds ${state.evidence.funds}; preserve the intent's reserve`,
      ...(state.order ? [`Deed ${state.order} must remain observed`] : []),
      ...(state.commitment ? [`Agreement ${state.commitment} must remain active`] : [])
    ],
    interruption: [
      `Health reading ${state.evidence.health}: interrupt on incoming damage or aggression`,
      `Stop before spending more than ${goal.budget} gold`,
      `Reconcile if observation or target ${goal.key} changes`,
      `Stop at deadline ${goal.stepUntil}`
    ],
    recovery: state.ready
      ? `Re-observe ${goal.key}, funds and risk; preserve the intent if still admissible, otherwise select another method`
      : 'Recheck missing tools and funds; choose a supported income alternative before retrying this method'
  };
}
