import type { GoalKind, GoalSituation, ResidentGoal } from './resident-goal';

export function planBudget(kind: GoalKind, state: GoalSituation) {
  const available = Math.max(0, state.evidence.funds - 150);
  const cap = { recover: 150, equip: 300, order: 750, commitment: 500, earn: 250, learn: 300 }[kind];
  const share = kind === 'learn' || kind === 'equip' || kind === 'recover' ? 1 : kind === 'order' ? 0.35 : 0.2;
  return Math.max(0, Math.floor(Math.min(cap, available * share)));
}
export function spendWithinPlan(goal: ResidentGoal, cost: number) {
  if (!Number.isFinite(cost) || cost < 0) return false;
  const budget = goal.intent?.budget;
  return !budget || budget.spent + budget.reserved + cost <= budget.maxSpend;
}
export function reserveSpend(goal: ResidentGoal | undefined, cost: number) {
  const budget = goal?.intent?.budget;
  if (!budget) return (_result: 'confirmed' | 'refused' | 'unknown') => {};
  budget.reserved += cost;
  let settled = false;
  return (result: 'confirmed' | 'refused' | 'unknown') => {
    if (settled) return;
    settled = true;
    if (result === 'unknown') return;
    budget.reserved -= cost;
    if (result === 'confirmed') budget.spent += cost;
  };
}
