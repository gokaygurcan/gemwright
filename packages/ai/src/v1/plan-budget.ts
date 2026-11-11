import type { GoalKind, GoalSituation, ResidentGoal } from './resident-goal';

// Spending is judged against what the resident owns, never a fixed amount: the gold above a small
// reserve is what may be spent. A goal may spend a share of it in all, so a plan stuck in a loop
// cannot drain the purse, and one purchase may take a quarter of it, so a resident with 600 gold
// buys no 500-gold horse while one with 13,000 buys its 2,000-gold armor.
const RESERVE = 150;
const GOAL_SHARE: Record<GoalKind, number> = {
  recover: 0.5,
  equip: 0.5,
  learn: 0.5,
  order: 0.35,
  commitment: 0.3,
  earn: 0.2
};
const PURCHASE_SHARE = 0.25;
const spare = (funds: number) => Math.max(0, funds - RESERVE);

export function planBudget(kind: GoalKind, state: GoalSituation) {
  return Math.floor(spare(state.evidence.funds) * GOAL_SHARE[kind]);
}
export const purchaseAffordable = (funds: number, cost: number) => cost <= spare(funds) * PURCHASE_SHARE;
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
