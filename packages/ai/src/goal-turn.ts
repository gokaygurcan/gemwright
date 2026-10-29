import { skillId } from '@gemwright/common/skills';

import { checkedDelay, recentlyHurt } from './action-purpose';
import { bankNearbyGold, bankSurplus, registerBanking } from './bank-gold';
import { recoverBlockedWork } from './blocked-work';
import { escapeDanger } from './danger-response';
import { escortOpportunity } from './escort';
import { bindIntent } from './execution-session';
import { riskBudget } from './goal-policy';
import { packFull } from './inventory';
import type { LifeContext } from './life';
import { lifeEvent } from './life-events';
import { pickLocation, townAt } from './locations';
import { meetNeeds } from './need-planning';
import { perceptionFor } from './perception-session';
import { personalTurn } from './personal-turn';
import { rememberPlan } from './plan-memory';
import { planningContext } from './planning-context';
import type { ProfessionContext } from './profession';
import { registerRecall } from './recall';
import {
  attachGoal,
  blockGoal,
  chooseGoal,
  failResidentGoal,
  type GoalSituation,
  goalPermission,
  leaseGoal,
  registerGoal
} from './resident-goal';
import { isGhost, resurrectGhost } from './resurrection';
import { jobReady } from './self';
import { sellingTurn } from './selling';
import { passSetback } from './setback';
import { housekeeping, optionalTurn } from './shared-turn';
import { sideTradeTurn } from './side-trade';
import { rememberBalance, workEvidence } from './work-evidence';

// Status refreshes spent on observations that stayed unavailable (see the recover step below).
const statusRefreshes = new WeakMap<
  import('@gemwright/network/session').PlayerSession,
  { count: number; at: number }
>();

// Securing-away-the-risk waits already spent on the same ground (see the recover step below).
const riskWaits = new WeakMap<
  import('@gemwright/network/session').PlayerSession,
  { at: number; tries: number; x: number; y: number }
>();

export interface GoalActions {
  trade: string;
  keep: (item: import('@gemwright/network/world').Entity) => boolean;
  settle?: () => Promise<unknown>;
  order?: () => Promise<boolean>;
  recover?: () => Promise<unknown>;
  prepare?: () => Promise<unknown>;
  life?: LifeContext;
  optional?: () => Promise<boolean>;
}
const reconciled = new WeakSet<object>();
const goalControlledFailure = (ctx: ProfessionContext) => !!ctx.checkpoint.workGoal?.active?.blocker;
export function goalSituation(ctx: ProfessionContext): GoalSituation {
  const skills = [
    ...(ctx.template.archetype?.primarySkills ?? []),
    ...(ctx.template.archetype?.supportingSkills ?? [])
  ].map(skillId);
  const evidence = workEvidence(ctx.session, ctx.checkpoint, skills.length ? skills : undefined);
  const ready = jobReady(ctx.session, ctx.template);
  const order = ctx.carried().find((item) => item.graphic === 0x2258);
  const commitment = ctx.checkpoint.personal?.commitment;
  const completedOrder = ctx.checkpoint.personal?.orders.find(
    (o) => o.state === 'completed' && `delivery:${o.id}` === ctx.checkpoint.workGoal?.active?.key
  );
  const playerOrder = ctx.checkpoint.personal?.orders.find((o) => ['accepted', 'ready'].includes(o.state));
  return {
    evidence,
    planning: planningContext(ctx, evidence),
    safe:
      !isGhost(ctx) &&
      ctx.status().hits >= ctx.status().maxHits * 0.85 &&
      !(ctx.session.world.poisonLevel ?? 0) &&
      !recentlyHurt(ctx.session) &&
      !perceptionFor(ctx.session).underAttack(),
    ready: ready.ready,
    learning: skills.some((id) => (ctx.session.world.skills.get(id)?.base ?? 0) < 100),
    order: order ? `order:${order.serial}` : undefined,
    commitment:
      commitment?.state === 'active'
        ? `commitment:${commitment.id}`
        : playerOrder
          ? `delivery:${playerOrder.id}`
          : undefined,
    completedCommitment:
      commitment?.state === 'completed'
        ? `commitment:${commitment.id}`
        : completedOrder
          ? `delivery:${completedOrder.id}`
          : undefined,
    earningNeeded: evidence.funds < Math.max(150, ready.ready ? 0 : ready.price),
    settlementReady:
      packFull(ctx.session, ctx.backpack(), 0.8) ||
      ctx.status().weight >= ctx.status().maxWeight * 0.8 ||
      Date.now() - (ctx.checkpoint.workGoal?.active?.started ?? Date.now()) >= 5 * 60_000
  };
}

// True means the selected plan step consumed this turn. False permits only the trade's own
// bounded work step; optional runners cannot preempt it while an objective is active.
export async function residentTurn(ctx: ProfessionContext, actions: GoalActions): Promise<boolean> {
  const { session, checkpoint } = ctx;
  let savedGoal = JSON.stringify(checkpoint.workGoal);
  const persist = () => {
    const current = JSON.stringify(checkpoint.workGoal);
    if (current === savedGoal) return;
    ctx.persist();
    savedGoal = current;
  };
  attachGoal(session);
  registerGoal(session, checkpoint, () => goalSituation(ctx), ctx.persist);
  registerRecall(ctx);
  registerBanking(ctx);
  if (checkpoint.funds) rememberBalance(session, checkpoint.funds.bank);
  if (isGhost(ctx)) {
    const lost = checkpoint.workGoal?.suspended ?? checkpoint.workGoal?.active;
    if (lost && lost.kind !== 'recover')
      rememberPlan(checkpoint, lost, 'died', 'Death observed before the intent completed', goalSituation(ctx));
    if (checkpoint.workGoal) delete checkpoint.workGoal.suspended;
    if (checkpoint.workGoal?.active?.kind !== 'recover') blockGoal(checkpoint, 'Died; recover before working');
    await (actions.recover ? actions.recover() : resurrectGhost(ctx));
    persist();
    return true;
  }
  let state = goalSituation(ctx);
  if (!actions.order && actions.trade !== 'tailor') delete state.order;
  if (!reconciled.has(session)) {
    reconciled.add(session);
    for (const goal of [checkpoint.workGoal?.active, checkpoint.workGoal?.suspended]) {
      if (!goal) continue;
      goal.before.products = state.evidence.products;
      goal.before.orders = state.evidence.orders;
    }
  }
  const previous = checkpoint.workGoal?.last;
  const previousGoal = checkpoint.workGoal?.active;
  const goal = chooseGoal(checkpoint, state);
  if (goal !== previousGoal)
    lifeEvent(
      session,
      'objective',
      'started',
      {
        key: goal.key,
        kind: goal.kind,
        step: goal.step,
        budget: goal.budget,
        before: goal.before,
        intent: goal.intent
      },
      `objective:${session.world.serial}:${goal.started}:${goal.key}`
    );
  leaseGoal(session, goal);
  if (goal.intent) bindIntent(session, goal.intent);
  const last = checkpoint.workGoal?.last;
  if (last !== previous) {
    ctx.log(`[goal] ${last?.result}: ${last?.key}: ${last?.reason}`);
    persist();
    if (
      last?.result === 'completed' &&
      !['recover', 'equip'].includes(last.key) &&
      actions.optional &&
      state.ready &&
      !state.earningNeeded &&
      !state.order &&
      !state.commitment &&
      !checkpoint.workGoal?.settle
    ) {
      if (checkpoint.workGoal) delete checkpoint.workGoal.active;
      if (
        await goalPermission(session, 'optional', async () => (await actions.optional?.()) || (await optionalTurn(ctx)))
      )
        return true;
      if (checkpoint.workGoal) checkpoint.workGoal.active = goal;
    }
  }
  persist();
  try {
    if (goal.step === 'recover') {
      const budget = riskBudget(state);
      const risk = state.planning?.deathRisk ?? 1;
      if (state.safe && state.planning?.available && risk > budget) {
        const here = ctx.position();
        const before = riskWaits.get(session);
        const sameGround = before && Math.max(Math.abs(before.x - here.x), Math.abs(before.y - here.y)) <= 10;
        // This ground was already found unsecurable (worn gear and threats are not bankable): the
        // trade keeps its turn without going through the settle trip again on every single turn.
        if (before && Date.now() - before.at < 10 * 60_000 && sameGround && before.tries > 2) return false;
        ctx.phase(
          'securing-assets',
          `Risk ${risk.toFixed(4)} exceeds the work budget ${budget.toFixed(4)}; securing carried goods before resuming`
        );
        if (actions.settle) await actions.settle();
        else {
          await sellingTurn(ctx, true);
          if (!(await bankNearbyGold(ctx))) await bankSurplus(ctx, ctx.city);
        }
        const next = goalSituation(ctx);
        lifeEvent(session, 'risk_recovery', 'observed', { before: state.planning, after: next.planning });
        // Securing did not change the risk (worn gear and threats are not bankable): pace the retry
        // with the numbers in the log, but only twice on the same ground. Waiting forever on a risk
        // it cannot put down never earns, never rests, and reads as a resident doing nothing; after
        // that the trade's own bounded step keeps the turn (its danger handling flees what attacks).
        if (next.planning?.available && (next.planning.deathRisk ?? 1) > riskBudget(next)) {
          const here = ctx.position();
          const before = riskWaits.get(session);
          const sameGround = before && Math.max(Math.abs(before.x - here.x), Math.abs(before.y - here.y)) <= 10;
          const tries = before && Date.now() - before.at < 10 * 60_000 && sameGround ? before.tries + 1 : 1;
          riskWaits.set(session, { at: Date.now(), tries, x: here.x, y: here.y });
          if (tries > 2) {
            lifeEvent(session, 'risk_recovery', 'observed', { waited: tries, risk: next.planning.deathRisk });
            ctx.log(
              `Risk ${(next.planning.deathRisk ?? 1).toFixed(4)} cannot be secured away here; working on and leaving the danger to the trade`
            );
            return false;
          }
          ctx.phase(
            'recovery-wait',
            `Risk ${(next.planning.deathRisk ?? 1).toFixed(4)} still exceeds the work budget ${riskBudget(next).toFixed(4)} after securing; waiting before retrying (${tries}/2)`
          );
          await checkedDelay(10_000, ctx.check);
        }
        return true;
      }
      if (state.safe && state.planning?.available === false) {
        // Missing observations are a precondition, not a step: asking again every turn is a spin
        // (it was the town's top loop). Two refreshes, then the goal is failed so the plan layer
        // takes another course, and the asking is paced until the observations come back.
        const refreshes = statusRefreshes.get(session) ?? { count: 0, at: 0 };
        if (Date.now() - refreshes.at > 60_000) refreshes.count = 0;
        refreshes.at = Date.now();
        refreshes.count += 1;
        statusRefreshes.set(session, refreshes);
        if (refreshes.count > 2) {
          failResidentGoal(session, 'Safety observations stay unavailable; cannot judge the work');
          ctx.phase('reconciling-status', 'Observations still missing; waiting before asking again');
          await checkedDelay(10_000, ctx.check);
          return true;
        }
        ctx.phase('reconciling-status', 'Refreshing missing or stale safety observations before resuming');
        await session.refreshStatus();
        // One refresh is a request: give the shard a beat to answer before calling it stale again.
        await checkedDelay(1500, ctx.check);
        return true;
      }
      // Safe and within the budget: the fallback recovery has nothing to secure or heal, so the
      // trade's own bounded work step keeps the turn.
      if (state.safe && state.planning?.available) return false;
      const status = ctx.status();
      const idle = status.hits >= status.maxHits * 0.9 && !(session.world.poisonLevel ?? 0);
      const note = `Getting safely back to working health before resuming the plan (${status.hits}/${status.maxHits} hp, poison ${session.world.poisonLevel ?? 'unknown'}, hurt ${recentlyHurt(session)}, attacked ${perceptionFor(session).underAttack()})`;
      ctx.phase(idle ? 'recovery-wait' : 'recovering', note);
      if (idle) {
        // Nothing to heal: recovery is waiting on its own gates, so its turns are paced instead of
        // spinning until the goal deadline.
        await checkedDelay(10_000, ctx.check);
        return true;
      }
      if (actions.recover) await actions.recover();
      else {
        const bank = pickLocation(townAt(ctx.position(), ctx.city), 'banker');
        await escapeDanger(ctx, bank);
        await passSetback(
          {
            ...ctx,
            items: () => [...session.world.childrenOf(ctx.serial), ...ctx.carried()],
            archetype: ctx.template.archetype
          },
          'Recovering health before work'
        );
      }
      return true;
    }
    if (await housekeeping(ctx, actions.keep)) return true;
    if (goalControlledFailure(ctx)) return true;
    if (goal.step === 'equip') {
      await goalPermission(session, 'equip', async () => {
        await actions.prepare?.();
        if (!jobReady(session, ctx.template).ready) await meetNeeds(actions.life ?? ctx);
      });
      if (!jobReady(session, ctx.template).ready)
        blockGoal(checkpoint, 'Work tool unavailable; choose another way to earn', Date.now(), goalSituation(ctx));
      return true;
    }
    if (goal.step === 'order' && actions.order) {
      const worked = await goalPermission(session, 'order', actions.order);
      state = goalSituation(ctx);
      if (!worked)
        blockGoal(
          checkpoint,
          checkpoint.bulkOrders?.stalledReason ?? 'Accepted order is blocked; earn while it waits',
          Date.now(),
          state
        );
      return true;
    }
    if (goal.step === 'commitment') {
      const worked = await goalPermission(session, 'commitment', () => personalTurn(actions.life ?? ctx));
      if (!worked) blockGoal(checkpoint, 'Commitment cannot advance now', Date.now(), goalSituation(ctx));
      return true;
    }
    if (goal.step === 'settle') {
      await goalPermission(session, 'settle', async () => {
        if (actions.settle) await actions.settle();
        else {
          await sellingTurn(ctx, true);
          if (!(await bankNearbyGold(ctx))) await bankSurplus(ctx, ctx.city);
        }
      });
      state = goalSituation(ctx);
      if (state.evidence.funds > goal.before.funds && checkpoint.workGoal) delete checkpoint.workGoal.settle;
      // Unsold production is a blocker, not a completed job. Earn another way while it waits.
      if (state.evidence.funds <= goal.before.funds && state.evidence.goods >= goal.before.goods)
        blockGoal(checkpoint, 'Produced goods did not become income', Date.now(), state);
      else if (state.evidence.funds <= goal.before.funds)
        blockGoal(checkpoint, 'Settlement produced no net income', Date.now(), state);
      return true;
    }
    if (goal.step === 'income') {
      const ran = await goalPermission(
        session,
        'income',
        async () =>
          (await sideTradeTurn(ctx, actions.trade, true)) || (await escortOpportunity(ctx, state.evidence.funds))
      );
      if (!ran) {
        blockGoal(
          checkpoint,
          'No reachable income action with the tools currently owned',
          Date.now(),
          goalSituation(ctx)
        );
        await recoverBlockedWork(ctx);
        const retryAt = Date.now() + 15_000;
        await ctx.practise(1);
        await checkedDelay(Math.max(0, retryAt - Date.now()), ctx.check);
      }
      return true;
    }
    return false;
  } catch (error) {
    ctx.check();
    blockGoal(checkpoint, error instanceof Error ? error.message : String(error), Date.now(), goalSituation(ctx));
    throw error;
  } finally {
    persist();
  }
}
