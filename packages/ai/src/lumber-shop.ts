import { hatchets } from '@gemwright/common/items';

import { chargedPurchase } from './bank-gold';
import { allServiceLocations, pickLocation } from './locations';
import { approachVendor } from './mobile-approach';
import type { MountContext } from './mount-types';
import { distance } from './navigation';
import type { PlayerSession } from './protocol/session';
import type { Entity } from './protocol/world';
import type { Checkpoint } from './store';

// The lumberjack's shop errands: the vendor menu entry check shared with board sales, and buying a
// replacement hatchet from the town blacksmith.
export { hatchets };

// A vendor's enabled context entry (3006103 buy, 3006104 sell); only vendors (notoriety 7) are asked.
export const vendorMenu = async (session: PlayerSession, mobile: Entity, cliloc: number) =>
  (mobile.notoriety === 7 ? await session.context(mobile.serial).catch(() => []) : []).find(
    (entry) => entry.cliloc === cliloc && !(entry.flags & 1)
  );

export async function buyHatchetFrom(
  ctx: Pick<
    MountContext,
    'session' | 'terrain' | 'position' | 'navigate' | 'check' | 'serial' | 'phase' | 'backpack'
  > & {
    checkpoint: Checkpoint;
    city: string;
  }
) {
  const { session, terrain, position, navigate, check, serial, phase, checkpoint, city, backpack } = ctx;
  // The town's own blacksmith, else the nearest catalogued one (Yew has none: Britain's or Minoc's).
  const smith =
    pickLocation(city, 'blacksmith') ??
    allServiceLocations('blacksmith').sort((a, b) => distance(position(), a) - distance(position(), b))[0];
  if (!smith) throw new Error('No blacksmith landmark for a replacement hatchet');
  phase('resupply', 'Buying a replacement hatchet');
  await navigate(smith, 4);
  for (const mobile of [...session.world.entities.values()]) {
    if (mobile.kind !== 'mobile' || !mobile.position || distance(position(), mobile.position) > 10) continue;
    const entry = await vendorMenu(session, mobile, 3006103);
    if (!entry) continue;
    await approachVendor({ session, terrain, position, navigate, check, serial }, mobile.serial);
    const before = session.world.received.get(0x74) ?? 0;
    session.world.buyOffers.clear();
    const current = await vendorMenu(session, mobile, 3006103);
    if (!current) continue;
    session.selectContext(mobile.serial, current.index);
    await session.waitFor(() => (session.world.received.get(0x74) ?? 0) > before, 'smith stock', 2500).catch(() => {});
    const offer = [...session.world.buyOffers.values()]
      .flat()
      .find((item) => hatchets.has(session.world.entities.get(item.serial)?.graphic ?? 0) && item.price <= 60);
    if (!offer) continue;
    await chargedPurchase({ session, checkpoint, backpack }, offer.price, () =>
      session.purchaseItem(mobile.serial, offer.serial, backpack(), 1, 60)
    );
    return;
  }
  throw new Error('No vendor sold a replacement hatchet');
}
