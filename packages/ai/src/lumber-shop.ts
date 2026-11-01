import { hatchets } from '@gemwright/common/game/items';
import { Notoriety } from '@gemwright/network/opcodes';
import { Actions } from '@gemwright/network/replies';
import type { PlayerSession } from '@gemwright/network/session';
import type { Entity } from '@gemwright/network/world';

import { chargedPurchase } from './bank-gold';
import { allServiceLocations, pickLocation } from './locations';
import { approachVendor } from './mobile-approach';
import type { MountContext } from './mount-types';
import { distance } from './navigation';
import type { Checkpoint } from './store';
import { buyOffers } from './vendor-shop';

// The lumberjack's shop errands: the vendor menu entry check shared with board sales, and buying a
// replacement hatchet from the town blacksmith.
export { hatchets };

// A vendor's enabled context entry (Actions.buy buy, Actions.sell sell); only vendors (notoriety 7) are asked.
export const vendorMenu = async (session: PlayerSession, mobile: Entity, cliloc: number) =>
  (mobile.notoriety === Notoriety.invulnerable ? await session.context(mobile.serial).catch(() => []) : []).find(
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
  // Only ServUO's weapon smiths stock hatchets (SBWeaponSmith, 0xF43); a blacksmith's list may hold
  // none at all, so the town's weapon smith comes first, then its blacksmith, then the nearest of
  // each elsewhere: a town whose smiths have none is left behind, as with any shop errand.
  const nearest = (service: 'weaponsmith' | 'blacksmith') =>
    allServiceLocations(service).sort((a, b) => distance(position(), a) - distance(position(), b))[0];
  const shops = [
    pickLocation(city, 'weaponsmith'),
    pickLocation(city, 'blacksmith'),
    nearest('weaponsmith'),
    nearest('blacksmith')
  ].filter(
    (point, index, all): point is NonNullable<typeof point> =>
      !!point && all.findIndex((other) => other?.x === point.x && other?.y === point.y) === index
  );
  if (!shops.length) throw new Error('No smith landmark for a replacement hatchet');
  phase('resupply', 'Buying a replacement hatchet');
  for (const smith of shops) {
    // A town with no smith at all (Skara Brae, Magincia) sends the lumberjack through the moongate
    // to one, the way any resident travels to a shop it needs.
    if (distance(position(), smith) > 300) {
      const { travelByMoongate } = await import('./moongate');
      const { nearestGate } = await import('./gates');
      await travelByMoongate({ session, position, navigate, phase }, nearestGate(smith)).catch(() => {});
    }
    if (
      !(await navigate(smith, 4).then(
        () => true,
        () => false
      ))
    )
      continue;
    for (const mobile of [...session.world.entities.values()]) {
      if (mobile.kind !== 'mobile' || !mobile.position || distance(position(), mobile.position) > 10) continue;
      const entry = await vendorMenu(session, mobile, Actions.buy);
      if (!entry) continue;
      await approachVendor({ session, terrain, position, navigate, check, serial }, mobile.serial);
      const stock = await buyOffers(session, mobile.serial, Actions.buy);
      if ('why' in stock) continue;
      const offer = stock.offers.find((item) => hatchets.has(session.world.entities.get(item.serial)?.graphic ?? 0));
      if (!offer) continue;
      await chargedPurchase(
        { session, checkpoint, backpack },
        offer.price,
        () => session.purchaseItem(mobile.serial, offer.serial, backpack(), 1, offer.price),
        true
      );
      return;
    }
  }
  throw new Error('No vendor sold a replacement hatchet');
}
