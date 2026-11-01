import { board, gold } from '@gemwright/common/game/items';
import { Actions } from '@gemwright/network/replies';
import type { Entity } from '@gemwright/network/world';

import { deposit, type Moved, openBank } from './bank-box';
import { vendorMenu } from './lumber-shop';
import { approachVendor } from './mobile-approach';
import type { MountContext } from './mount-types';
import { distance } from './navigation';
import { sellChosen, sellOffers } from './vendor-shop';

// At the carpenter's: the first nearby vendor whose buy list takes the carried plain boards buys
// them all. Returns what sold and the gold it brought, or undefined when nobody bought.
export async function sellBoards(
  ctx: Pick<MountContext, 'session' | 'terrain' | 'position' | 'navigate' | 'check' | 'serial' | 'status' | 'backpack'>
) {
  const { session, position } = ctx;
  for (const mobile of [...session.world.entities.values()]) {
    if (mobile.kind !== 'mobile' || !mobile.position || distance(position(), mobile.position) > 10) continue;
    if (!(await vendorMenu(session, mobile, Actions.sell))) continue;
    await approachVendor(ctx, mobile.serial);
    const opened = await sellOffers(session, mobile.serial, Actions.sell);
    if ('why' in opened) continue;
    const sale = opened.offers.filter((offer) => {
      const item = session.world.entities.get(offer.serial);
      return item?.parent === ctx.backpack() && item.graphic === board && !item.hue && offer.amount === item.amount;
    });
    if (!sale.length) continue;
    return sellChosen(session, mobile.serial, sale);
  }
  return undefined;
}

// At the bank: gold goes into the box, and so does wood (`stored` graphics) no carpenter bought.
export async function storeAtBank(
  ctx: Pick<MountContext, 'session' | 'terrain' | 'position' | 'navigate' | 'check' | 'serial' | 'checkpoint'> & {
    carried: () => Entity[];
    phase: (phase: string, note: string) => void;
  },
  stored: number[]
): Promise<Moved | undefined> {
  const bank = await openBank(ctx);
  // The shard's own reason, not a silent "still full": the loop guard and the log see why.
  if (!bank) {
    ctx.phase('bank-refused', 'No banker here opened a bank box');
    return;
  }
  const result = await deposit(
    ctx,
    bank,
    ctx.carried().filter((entry) => entry.graphic === gold || stored.includes(entry.graphic))
  );
  if (result.refused.length)
    ctx.phase('bank-refused', `The bank took ${result.moved.length}, refused: ${result.refused[0]?.reason}`);
  return result;
}
