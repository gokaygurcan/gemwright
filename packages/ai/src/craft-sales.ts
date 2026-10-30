import { Actions } from '@gemwright/network/replies';

import { atVendor, type CraftContext, type CraftSkill } from './craft-training';
import { reservedFor } from './work-orders';

export async function sellCrafted(ctx: CraftContext, craft: CraftSkill, made: Set<number>, backpack: number) {
  const { session } = ctx;
  await atVendor(ctx, craft.vendor, Actions.sell, async (vendor) => {
    const entry = (await session.context(vendor)).find((e) => e.cliloc === Actions.sell);
    if (!entry) return false;
    session.world.sellOffers.delete(vendor);
    session.selectContext(vendor, entry.index);
    await session.waitFor(() => session.world.sellOffers.has(vendor), 'craft buying list', 2500).catch(() => {});
    // Up to 20 of each held graphic stay in the pack (already held ones count); the rest are sold.
    const kept = new Map<number, number>();
    const held = (serial: number) => {
      const graphic = session.world.entities.get(serial)?.graphic ?? 0;
      if (!ctx.hold?.has(graphic)) return false;
      if (!kept.has(graphic))
        kept.set(graphic, ctx.carried(backpack).filter((i) => i.graphic === graphic && !made.has(i.serial)).length);
      if ((kept.get(graphic) ?? 0) >= 20) return false;
      kept.set(graphic, (kept.get(graphic) ?? 0) + 1);
      // Held goods leave the sale list, so they never send the crafter back to the shop.
      made.delete(serial);
      return true;
    };
    const sale = (session.world.sellOffers.get(vendor) ?? []).filter(
      (offer) =>
        made.has(offer.serial) &&
        offer.price > 0 &&
        !held(offer.serial) &&
        reservedFor(
          session,
          session.world.entities.get(offer.serial) ?? { serial: offer.serial, kind: 'item', graphic: 0 }
        ) === 0
    );
    if (!sale.length) return false;
    await session.sell(
      vendor,
      sale.map((offer) => ({ serial: offer.serial, amount: offer.amount }))
    );
    for (const offer of sale) made.delete(offer.serial);
    return true;
  });
}
