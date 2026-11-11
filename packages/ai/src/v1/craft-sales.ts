import { Actions } from '@gemwright/network/replies';

import type { CraftContext, CraftSkill } from './craft-training';
import { sellChosen, sellOffers } from './vendor-shop';
import { atVendor } from './vendor-visit';
import { reservedFor } from './work-orders';

export async function sellCrafted(ctx: CraftContext, craft: CraftSkill, made: Set<number>, backpack: number) {
  const { session } = ctx;
  await atVendor(ctx, craft.vendor, Actions.sell, async (vendor) => {
    const opened = await sellOffers(session, vendor, Actions.sell);
    if ('why' in opened) return false;
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
    const sale = opened.offers.filter(
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
    // Only a sale the gold confirms leaves the list; one that brought nothing is offered again.
    if (!(await sellChosen(session, vendor, sale)).earned) return false;
    for (const offer of sale) made.delete(offer.serial);
    return true;
  });
}
