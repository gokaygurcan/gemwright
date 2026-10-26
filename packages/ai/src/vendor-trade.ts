import { tally } from './activity';
import { canSpendOnTraining, chargedPurchase, recordTrainingSpend } from './bank-gold';
import { atVendor, type CraftContext } from './craft-training';
import { learnQuality, quality, shopSafe } from './item-quality';
import type { ServiceType } from './locations';
import type { Entity } from './protocol/world';
import { reservedFor } from './work-orders';

type TradeContext = CraftContext & { backpack: () => number };

// Buys up to `wanted` amounts (graphic -> count) from one vendor of `service`, each unit at most
// `maxPrice`, within the shared training budget. Returns whether anything was bought.
export async function buyFrom(ctx: TradeContext, service: ServiceType, wanted: Map<number, number>, maxPrice: number) {
  const { session } = ctx;
  return atVendor(
    ctx,
    service,
    3006103,
    async (vendor) => {
      const before = session.world.received.get(0x74) ?? 0;
      session.world.buyOffers.clear();
      const entry = (await session.context(vendor)).find((e) => e.cliloc === 3006103);
      if (!entry) return false;
      session.selectContext(vendor, entry.index);
      await session
        .waitFor(() => (session.world.received.get(0x74) ?? 0) > before, 'vendor stock', 2500)
        .catch(() => {});
      let bought = false;
      for (const offer of [...session.world.buyOffers.values()].flat()) {
        const graphic = session.world.entities.get(offer.serial)?.graphic ?? 0;
        const amount = Math.min(wanted.get(graphic) ?? 0, session.world.entities.get(offer.serial)?.amount ?? 1);
        const cost = amount * offer.price;
        if (
          amount < 1 ||
          offer.price > maxPrice ||
          !canSpendOnTraining(session, ctx.backpack(), ctx.checkpoint, cost, ctx.limits)
        )
          continue;
        await chargedPurchase(ctx, cost, () =>
          session.purchaseItem(vendor, offer.serial, ctx.backpack(), amount, cost)
        );
        recordTrainingSpend(ctx.checkpoint, cost);
        wanted.delete(graphic);
        bought = true;
      }
      return bought;
    },
    `buy:${[...wanted]
      .sort(([a], [b]) => a - b)
      .map(([graphic, count]) => `${graphic}=${count}`)
      .join(',')}:${maxPrice}`
  );
}

// Sells every carried item matching `sellable` that one vendor of `service` buys (whole stacks only);
// `sellable` also sees the price this vendor offers for the whole stack. `exceptional` lets
// exceptional pieces go too (clearing a full bank box); artifacts, blessed and magic items never do.
// A work tool that wears out (instruments 350-450 uses, ServUO BaseInstrument): a pair when
// affordable, so the spare keeps the resident working when the first breaks, else one. Kinds are
// tried in order and the first purchase ends it, so a vendor stocking several kinds sells one.
export async function buyTool(ctx: TradeContext, service: ServiceType, kinds: readonly number[], maxPrice: number) {
  for (const count of [2, 1])
    for (const graphic of kinds) if (await buyFrom(ctx, service, new Map([[graphic, count]]), maxPrice)) return true;
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
    3006104,
    async (vendor) => {
      const entry = (await session.context(vendor)).find((e) => e.cliloc === 3006104);
      if (!entry) return false;
      session.world.sellOffers.delete(vendor);
      session.selectContext(vendor, entry.index);
      await session.waitFor(() => session.world.sellOffers.has(vendor), 'vendor buying list', 2500).catch(() => {});
      // Only plain goods go to a shop (item-quality.ts): special pieces are kept or traded.
      await learnQuality(
        session,
        (session.world.sellOffers.get(vendor) ?? []).flatMap((offer) => session.world.entities.get(offer.serial) ?? [])
      );
      const sale = (session.world.sellOffers.get(vendor) ?? []).filter((offer) => {
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
      const gold = ctx.status().gold;
      await session.sell(
        vendor,
        sale.map((offer) => ({ serial: offer.serial, amount: offer.amount }))
      );
      await session.refreshStatus();
      earned = ctx.status().gold - gold;
      tally(session, 'goldFromShops', Math.max(0, earned));
      return true;
    },
    `sell:${ctx
      .carried(ctx.backpack())
      .map((item) => `${item.serial}=${item.amount ?? 1}`)
      .sort()
      .join(',')}`
  );
  return earned;
}
