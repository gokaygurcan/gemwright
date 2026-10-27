import { fundsStale, knownBankGold, refreshFunds, TOOLS } from './bank-gold';
import type { LifeContext } from './life';
import { forcedToWork } from './loop-watch';
import { residentNeeds } from './needs';
import { completeObjective, failObjective, objectiveBlocked, suppliesCondition } from './objective-memory';
import { Layer } from './protocol/layers';
import { buyFrom, buyTool } from './vendor-trade';

export function needPriority(ctx: Pick<LifeContext, 'session' | 'checkpoint' | 'template'>) {
  const needs = residentNeeds(ctx.session, ctx.checkpoint, ctx.template);
  return {
    needs,
    income: needs.some((need) => need.kind === 'income'),
    supplies: needs.filter((need) => need.purchase)
  };
}

// Returns to the profession's own work when funds are short; errands never claim success
// unless the shared needs assessment sees the shortage disappear.
export async function meetNeeds(ctx: LifeContext): Promise<'work' | 'handled' | undefined> {
  const { session, checkpoint } = ctx;
  if (forcedToWork(session)) return undefined;
  let priority = needPriority(ctx);
  const pack = session.world.childrenOf(session.world.serial ?? -1).find((item) => item.layer === Layer.Backpack);
  const status = session.world.status;
  if (!pack || !status) return undefined;
  if (fundsStale(checkpoint) && (priority.income || priority.supplies.length)) {
    const key = 'need:bank-balance';
    const condition = suppliesCondition(session, checkpoint);
    if (!objectiveBlocked(checkpoint, key, condition)) {
      await refreshFunds({ ...ctx, serial: session.world.serial ?? -1 }, ctx.city);
      if (fundsStale(checkpoint))
        failObjective(checkpoint, key, suppliesCondition(session, checkpoint), 'No current bank balance available');
      priority = needPriority(ctx);
    }
  }
  for (const need of priority.supplies) {
    const purchase = need.purchase;
    if (!purchase) continue;
    const key = `need:${purchase.service}:${purchase.graphics.join(',')}`;
    const condition = suppliesCondition(session, checkpoint);
    if (objectiveBlocked(checkpoint, key, condition)) continue;
    const funds = status.gold + knownBankGold(checkpoint);
    // A tool it cannot afford: no begging; it earns bare-handed (run-session.ts) until it can.
    if (need.kind === 'tool' && funds < purchase.maxPrice) continue;
    // Supplies are optional: bought only with money to spare, never a trip that keeps it from work.
    if (need.kind === 'supply' && funds < purchase.maxPrice * Math.min(purchase.amount, 5) + 50) continue;
    ctx.phase('supplies', `Looking for ${need.what}: ${need.why}`);
    const trade = {
      ...ctx,
      serial: session.world.serial ?? -1,
      status: () => session.world.status ?? status,
      carried: (parent: number) => session.world.childrenOf(parent),
      backpack: () => pack.serial,
      limits: TOOLS
    };
    const bought =
      need.kind === 'tool'
        ? await buyTool(trade, purchase.service, purchase.graphics, purchase.maxPrice)
        : await buyFrom(
            trade,
            purchase.service,
            new Map(purchase.graphics.map((graphic) => [graphic, purchase.wanted?.[graphic] ?? purchase.amount])),
            purchase.maxPrice
          );
    const remaining = residentNeeds(session, checkpoint, ctx.template).some(
      (other) =>
        other.purchase?.service === purchase.service &&
        other.purchase.graphics.join(',') === purchase.graphics.join(',')
    );
    if (!remaining) completeObjective(checkpoint, key);
    else
      failObjective(
        checkpoint,
        key,
        suppliesCondition(session, checkpoint),
        `Still short of ${need.what}; work or another source comes next`
      );
    ctx.persist();
    if (bought) return 'handled';
  }
  return priority.income || priority.supplies.length ? 'work' : undefined;
}
