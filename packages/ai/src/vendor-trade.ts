import { Actions } from '@gemwright/network/replies';
import type { Entity } from '@gemwright/network/world';

import { tally } from './activity';
import { canSpendOnTraining, chargedPurchase, recordTrainingSpend, refreshFunds } from './bank-gold';
import type { CraftContext } from './craft-training';
import { learnQuality, quality, shopSafe } from './item-quality';
import type { ServiceType } from './locations';
import { noteVendorKind } from './price-book';
import { buyOffers, sellChosen, sellOffers } from './vendor-shop';
import { atVendor } from './vendor-visit';
import { reservedFor } from './work-orders';

type TradeContext = CraftContext & { backpack: () => number };

// Buys up to `wanted` amounts (graphic -> count) from one vendor of `service` at whatever the shard
// asks, as long as the resident can pay it (the spending limits it was given). True when it bought.
// `one`: any one of the wanted kinds will do (a tool: a pickaxe or a shovel), the first offered is bought.
export async function buyFrom(ctx: TradeContext, service: ServiceType, wanted: Map<number, number>, one = false) {
  const { session } = ctx;
  // Gold lives in the bank: a balance it no longer knows is asked for, not counted as nothing — a
  // fisher with thousands banked was turning down every pole as unaffordable.
  await refreshFunds(ctx, ctx.city);
  return atVendor(
    ctx,
    service,
    Actions.buy,
    async (vendor) => {
      const stock = await buyOffers(session, vendor, Actions.buy);
      if ('why' in stock) return false;
      noteVendorKind(vendor, service);
      let bought = false;
      // Why each wanted offer was passed over, so a vendor that sold nothing says which it was.
      const passed = { unwanted: 0, funds: 0 };
      // Any one of several will do: the cheapest that is offered.
      const offers = one ? [...stock.offers].sort((a, b) => a.price - b.price) : stock.offers;
      for (const offer of offers) {
        const graphic = session.world.entities.get(offer.serial)?.graphic ?? 0;
        const amount = Math.min(wanted.get(graphic) ?? 0, session.world.entities.get(offer.serial)?.amount ?? 1);
        const cost = amount * offer.price;
        if (amount < 1) passed.unwanted++;
        else if (!canSpendOnTraining(session, ctx.backpack(), ctx.checkpoint, cost, ctx.limits)) passed.funds++;
        else {
          await chargedPurchase(ctx, cost, () =>
            session.purchaseItem(vendor, offer.serial, ctx.backpack(), amount, cost)
          );
          recordTrainingSpend(ctx.checkpoint, cost);
          wanted.delete(graphic);
          bought = true;
          if (one) break;
        }
      }
      if (!bought)
        ctx.log(
          `Bought nothing from vendor ${vendor}: ${stock.offers.length} offers (${passed.unwanted} not wanted, ${passed.funds} unaffordable; known funds ${(ctx.checkpoint.funds?.bank ?? 0) + (ctx.status().gold ?? 0)}); wanted ${[...wanted.keys()].map((g) => `0x${g.toString(16)}`).join(',')}; offered ${stock.offers
            .slice(0, 8)
            .map((o) => `${o.description}=0x${(session.world.entities.get(o.serial)?.graphic ?? 0).toString(16)}`)
            .join(', ')}`
        );
      return bought;
    },
    `buy:${[...wanted]
      .sort(([a], [b]) => a - b)
      .map(([graphic, count]) => `${graphic}=${count}`)
      .join(',')}`
  );
}

// Sells every carried item matching `sellable` that one vendor of `service` buys (whole stacks only);
// `sellable` also sees the price this vendor offers for the whole stack. `exceptional` lets
// exceptional pieces go too (clearing a full bank box); artifacts, blessed and magic items never do.
// A work tool that wears out (instruments 350-450 uses, ServUO BaseInstrument): a pair when
// affordable, so the spare keeps the resident working when the first breaks, else one. Every kind is
// asked for at once and the first one offered is bought, so the town's vendor sells whichever it has
// (ServUO SBTinker: a pickaxe is 0xE86, never 0xE85); one kind at a time sent a miner to every other
// town's vendor for the first kind before the next was tried.
export async function buyTool(ctx: TradeContext, service: ServiceType, kinds: readonly number[]) {
  for (const count of [2, 1])
    if (await buyFrom(ctx, service, new Map(kinds.map((graphic) => [graphic, count])), true)) return true;
  return false;
}

export async function sellTo(
  ctx: TradeContext,
  service: ServiceType,
  sellable: (item: Entity, price: number) => boolean,
  exceptional = false
) {
  const { session } = ctx;
  let earned = 0;
  await atVendor(
    ctx,
    service,
    Actions.sell,
    async (vendor) => {
      const opened = await sellOffers(session, vendor, Actions.sell);
      if ('why' in opened) return false;
      noteVendorKind(vendor, service);
      // Only plain goods go to a shop (item-quality.ts): special pieces are kept or traded.
      await learnQuality(
        session,
        opened.offers.flatMap((offer) => session.world.entities.get(offer.serial) ?? [])
      );
      const sale = opened.offers.filter((offer) => {
        const item = session.world.entities.get(offer.serial);
        return (
          !!item &&
          (shopSafe(item) || (exceptional && quality(item) === 'exceptional')) &&
          item.parent === ctx.backpack() &&
          reservedFor(session, item) === 0 &&
          offer.price > 0 &&
          offer.amount === item.amount &&
          sellable(item, offer.price)
        );
      });
      if (!sale.length) return false;
      earned = (await sellChosen(session, vendor, sale)).earned;
      tally(session, 'goldFromShops', earned);
      return earned > 0;
    },
    `sell:${ctx
      .carried(ctx.backpack())
      .map((item) => `${item.serial}=${item.amount ?? 1}`)
      .sort()
      .join(',')}`
  );
  return earned;
}
