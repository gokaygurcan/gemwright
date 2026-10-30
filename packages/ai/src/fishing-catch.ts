import { fish } from '@gemwright/common/game/items';

import { bankNearbyGold, bankSurplus } from './bank-gold';
import { Blocked } from './blocked';
import { townAt } from './locations';
import type { ProfessionContext } from './profession';
import { sellTo } from './vendor-trade';

// ServUO Fishing's footwear catches and SBCobbler's buyback list.
export const fishingFootwear = new Set([0x170b, 0x170c, 0x170d, 0x170e, 0x170f, 0x1710, 0x1711, 0x1712]);

export async function sellFishingCatch(ctx: ProfessionContext): Promise<void> {
  const local = { ...ctx, city: townAt(ctx.position(), ctx.city) };
  let unsoldFish = false;
  try {
    if (ctx.carried().some((item) => fish.has(item.graphic))) {
      ctx.phase('selling', 'Selling the catch to a fisherman');
      const earned = await sellTo(local, 'fisherman', (item) => fish.has(item.graphic));
      ctx.progress.earned = (ctx.progress.earned ?? 0) + earned;
      unsoldFish = !earned && ctx.carried().some((item) => fish.has(item.graphic));
    }
  } finally {
    try {
      if (ctx.carried().some((item) => fishingFootwear.has(item.graphic))) {
        ctx.phase('selling-footwear', 'Selling fished boots and shoes to a cobbler');
        const earned = await sellTo(local, 'cobbler', (item) => fishingFootwear.has(item.graphic));
        ctx.progress.earned = (ctx.progress.earned ?? 0) + earned;
      }
    } finally {
      if (!(await bankNearbyGold(ctx))) await bankSurplus(ctx, townAt(ctx.position(), ctx.city));
    }
  }
  if (unsoldFish) throw new Blocked('no-vendor', 'No fisherman here bought the catch');
}
