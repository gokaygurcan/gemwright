import { fundsStale, knownBankGold, refreshFunds, TOOLS } from './bank-gold';
import type { LifeContext } from './life';
import { residentNeeds } from './needs';
import { completeObjective, failObjective, objectiveBlocked, suppliesCondition } from './objective-memory';
import { Layer } from './protocol/layers';
import { begForTool } from './subsistence';
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
    if (need.kind === 'tool' && priority.income && status.gold + knownBankGold(checkpoint) < purchase.maxPrice) {
      const key = `subsistence:${purchase.graphics.join(',')}`;
      if (!objectiveBlocked(checkpoint, key, condition)) {
        const before = status.gold;
        await begForTool(
          {
            ...ctx,
            serial: session.world.serial ?? -1,
            count: (graphic: number) =>
              session.world
                .childrenOf(pack.serial)
                .filter((item) => item.graphic === graphic)
                .reduce((sum, item) => sum + (item.amount ?? 1), 0)
          },
          purchase.maxPrice
        );
        if ((session.world.status?.gold ?? before) > before) {
          ctx.persist();
          return 'handled';
        }
        failObjective(
          checkpoint,
          key,
          suppliesCondition(session, checkpoint),
          'No working funds obtained; waiting for a different opportunity'
        );
      }
    }
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
