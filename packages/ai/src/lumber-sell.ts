import { gold } from '@gemwright/common/items';

import { offersBank, openBankBox, queryBankBalance } from './bank-gold';
import { vendorMenu } from './lumber-shop';
import { approachVendor } from './mobile-approach';
import type { MountContext } from './mount-types';
import { distance } from './navigation';

const board = 0x1bd7;

// At the carpenter's: the first nearby vendor whose buy list takes the carried plain boards buys
// them all. Returns what sold and the gold it brought, or undefined when nobody bought.
export async function sellBoards(
  ctx: Pick<MountContext, 'session' | 'terrain' | 'position' | 'navigate' | 'check' | 'serial' | 'status' | 'backpack'>
) {
  const { session, position, status } = ctx;
  for (const mobile of [...session.world.entities.values()]) {
    if (mobile.kind !== 'mobile' || !mobile.position || distance(position(), mobile.position) > 10) continue;
    const entry = await vendorMenu(session, mobile, 3006104);
    if (!entry) continue;
    await approachVendor(ctx, mobile.serial);
    session.world.sellOffers.delete(mobile.serial);
    const current = await vendorMenu(session, mobile, 3006104);
    if (!current) continue;
    session.selectContext(mobile.serial, current.index);
    const offered = await session
      .waitFor(() => session.world.sellOffers.has(mobile.serial), 'carpenter buying list', 2500)
      .then(() => true)
      .catch(() => false);
    if (!offered) continue;
    const sale = (session.world.sellOffers.get(mobile.serial) ?? []).filter((offer) => {
      const item = session.world.entities.get(offer.serial);
      return item?.parent === ctx.backpack() && item.graphic === board && !item.hue && offer.amount === item.amount;
    });
    if (!sale.length) continue;
    const before = status().gold;
    await session.sell(
      mobile.serial,
      sale.map((offer) => ({ serial: offer.serial, amount: offer.amount }))
    );
    await session.refreshStatus();
    return { amount: sale.reduce((sum, offer) => sum + offer.amount, 0), earned: status().gold - before };
  }
  return undefined;
}

// At the bank: gold goes into the box, and so does wood (`stored` graphics) no carpenter bought.
export async function storeAtBank(
  ctx: Pick<MountContext, 'session' | 'terrain' | 'position' | 'navigate' | 'check' | 'serial' | 'checkpoint'> & {
    carried: () => { serial: number; graphic: number }[];
  },
  stored: number[]
) {
  const { session, position, checkpoint, carried } = ctx;
  const banker = [...session.world.entities.values()].find(
    (mobile) => mobile.kind === 'mobile' && mobile.position && distance(position(), mobile.position) <= 11
  );
  if (banker && (await offersBank(session, banker.serial))) {
    const box = await openBankBox(ctx, banker.serial);
    for (const item of carried().filter((entry) => entry.graphic === gold || stored.includes(entry.graphic))) {
      await session.moveItem(item.serial, box);
      await Bun.sleep(600);
    }
    await queryBankBalance({ ...ctx, checkpoint }, banker.serial);
  }
}
