import { bulkOrderDeed } from '@gemwright/common/game/items';
import { skillId } from '@gemwright/common/game/skills';

import { checkedDelay, recentlyHurt } from './action-purpose';
import { bankNearbyGold, bankSurplus, registerBanking } from './bank-gold';
import { recoverBlockedWork } from './blocked-work';
import { escapeDanger } from './danger-response';
import { coreStale } from './day-plan';
import { escortOpportunity } from './escort';
import { bindIntent } from './execution-session';
import { assertNotHalted } from './gm';
import { riskBudget } from './goal-policy';
import { packFull } from './inventory';
import type { LifeContext } from './life';
import { lifeEvent } from './life-events';
import { pickLocation, townAt } from './locations';
import { meetNeeds } from './need-planning';
import { perceptionFor } from './perception-session';
import { updatePersonalGoals } from './personal-goals';
import { personalTurn } from './personal-turn';
import { rememberPlan } from './plan-memory';
import { planningContext } from './planning-context';
import type { ProfessionContext } from './profession';
import { registerRecall } from './recall';
import {
  attachGoal,
  blockGoal,
  chooseGoal,
  type GoalSituation,
  goalPermission,
  leaseGoal,
  registerGoal
} from './resident-goal';
import { isGhost, resurrectGhost } from './resurrection';
import { jobReady } from './self';
import { sellingTurn } from './selling';
import { sessionBreakTurn } from './session-habits';
import { passSetback } from './setback';
import { housekeeping, optionalTurn } from './shared-turn';
import { sideTradeTurn } from './side-trade';
import { scrapTurn } from './skirmish';
import { townTurn } from './towns';
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
  const order = ctx.carried().find((item) => item.graphic === bulkOrderDeed);
  const commitment = ctx.checkpoint.personal?.commitment;
  const completedOrder = ctx.checkpoint.personal?.orders.find(
    (o) => o.state === 'completed' && `delivery:${o.id}` === ctx.checkpoint.workGoal?.active?.key
  );
  const playerOrder = ctx.checkpoint.personal?.orders.find((o) => ['accepted', 'ready'].includes(o.state));
  const personalGoal = updatePersonalGoals(ctx);
  const savingsTarget =
    personalGoal && ['mount', 'equipment', 'home'].includes(personalGoal.kind) ? personalGoal.target : 0;
  const recoveryPending = !!ctx.checkpoint.hunting?.recovery && ctx.checkpoint.hunting.recovery.stage !== 'ready';
  return {
    evidence,
    planning: planningContext(ctx, evidence),
    recoveryPending,
    safe:
      !recoveryPending &&
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
    earningNeeded: evidence.funds < Math.max(150, ready.ready ? 0 : ready.price, savingsTarget),
    // Side work is not proposed while the resident's own work has not gained anything: a fisher does
    // not walk to another city to earn with a full tank and an unworked trade.
    coreStale: coreStale(ctx.session),
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
  assertNotHalted(session);
  townTurn(session, checkpoint, actions.trade, ctx.city);
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
  await sessionBreakTurn(actions.life ?? ctx);
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
  const last = checkpoint.workGoal?.last;
  if (last !== previous) {
    ctx.log(`[goal] ${last?.result}: ${last?.key}: ${last?.reason}`);
    persist();
  }
  // The agenda (life.ts phases) owns the day: goals are the steps of the work phase, and a completed
  // goal is a few coins, not the end of it. Only when the work phase has run its time does the
  // turn go to the agenda, which picks what comes next — more work, errands, a break.
  const life = checkpoint.life;
  if (
    (life?.phase !== 'work' || Date.now() >= life.until) &&
    goal.step === 'trade' &&
    actions.optional &&
    state.ready &&
    !state.earningNeeded &&
    !state.order &&
    !state.commitment &&
    !checkpoint.workGoal?.settle
  ) {
    const handed = checkpoint.workGoal?.active;
    if (checkpoint.workGoal) delete checkpoint.workGoal.active;
    bindIntent(session);
    persist();
    const ran = await goalPermission(
      session,
      'optional',
      async () => (await actions.optional?.()) || (await optionalTurn(ctx))
    );
    if (ran) return true;
    if (handed && checkpoint.workGoal && !checkpoint.workGoal.active) checkpoint.workGoal.active = handed;
  }
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
  persist();
  try {
    if (goal.step === 'wait') {
      ctx.phase(
        'plan-wait',
        `Productive methods are blocked (safe ${state.safe}, ready ${state.ready}, ${ctx.status().hits}/${ctx.status().maxHits} hp); reconciling observations before a bounded retry`
      );
      await session.refreshStatus();
      // A wait, not a spin: the goal's own deadline bounds the retry.
      await checkedDelay(10_000, ctx.check);
      return true;
    }
    if (goal.step === 'recover') {
      if (state.recoveryPending && actions.recover) {
        await goalPermission(session, 'recover', actions.recover);
        return true;
      }
      const budget = riskBudget(state);
      const risk = state.planning?.deathRisk ?? 1;
      if (state.safe && state.planning?.available && risk > budget) {
        const here = ctx.position();
        const before = riskWaits.get(session);
        const sameGround = before && Math.max(Math.abs(before.x - here.x), Math.abs(before.y - here.y)) <= 10;
        if (before && Date.now() - before.at < 10 * 60_000 && sameGround && before.tries > 2) {
          ctx.phase('recovery-wait', 'Assets could not be secured here; waiting for a changed risk assessment');
          await checkedDelay(10_000, ctx.check);
          return true;
        }
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
        if (next.planning?.available && (next.planning.deathRisk ?? 1) > riskBudget(next)) {
          const here = ctx.position();
          const before = riskWaits.get(session);
          const sameGround = before && Math.max(Math.abs(before.x - here.x), Math.abs(before.y - here.y)) <= 10;
          const tries = before && Date.now() - before.at < 10 * 60_000 && sameGround ? before.tries + 1 : 1;
          riskWaits.set(session, { at: Date.now(), tries, x: here.x, y: here.y });
          ctx.phase(
            'recovery-wait',
            `Risk ${(next.planning.deathRisk ?? 1).toFixed(4)} still exceeds the work budget ${riskBudget(next).toFixed(4)} after securing; waiting before reassessment (${tries})`
          );
          await checkedDelay(10_000, ctx.check);
        }
        return true;
      }
      if (state.safe && state.planning?.available === false) {
        // Missing observations are a precondition, not a step — and they must be asked for again
        // (an earlier "paced" retry stopped asking after two tries, so the observation never came
        // back and the resident waited for ever, standing still with no reason in the log).
        const missing =
          (state.planning.evidence ?? [])
            .filter((entry) => entry.id.startsWith('perception:') && entry.kind !== 'observed')
            .map(
              (entry) =>
                `${entry.id.replace('perception:', '')}=${entry.kind}${entry.at ? `@${Math.round((Date.now() - entry.at) / 1000)}s` : ''}`
            )
            .join(', ') || 'planning unavailable';
        const refreshes = statusRefreshes.get(session) ?? { count: 0, at: 0 };
        refreshes.count = Date.now() - refreshes.at > 60_000 ? 0 : refreshes.count + 1;
        const paced = refreshes.count > 2;
        refreshes.at = Date.now();
        statusRefreshes.set(session, refreshes);
        ctx.phase(
          'reconciling-status',
          `Observations missing (${missing}); refreshing${paced ? ' slowly' : ''} before resuming`
        );
        await session.refreshStatus().catch((error) => {
          if (session.phase !== 'ready') throw error;
          ctx.log(`Status refresh failed: ${error instanceof Error ? error.message : String(error)}`);
        });
        await checkedDelay(paced ? 8_000 : 1_500, ctx.check);
        return true;
      }
      if (state.safe && state.planning?.available) {
        ctx.phase('recovery-wait', 'Reassessing the recovery plan before resuming work');
        await checkedDelay(10_000, ctx.check);
        return true;
      }
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
    if (checkpoint.workGoal?.active !== goal || goalControlledFailure(ctx)) return true;
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
          (await sideTradeTurn(ctx, actions.trade, true)) ||
          (await escortOpportunity(ctx, state.evidence.funds)) ||
          // With no tool and no trade, a player scraps: weak creatures outside town, for gold and gear.
          (await scrapTurn(ctx))
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
    return goal.step !== 'trade' || checkpoint.workGoal?.active !== goal;
  } catch (error) {
    ctx.check();
    blockGoal(checkpoint, error instanceof Error ? error.message : String(error), Date.now(), goalSituation(ctx));
    throw error;
  } finally {
    persist();
  }
}
