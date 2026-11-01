import type { PlayerSession } from '@gemwright/network/session';

// What residents have seen vendors charge and pay, item by item. Every buy or sell list a resident
// opens is written down here (vendor-shop.ts), and what one resident saw the others know, as players
// tell each other prices. Nothing is known before someone has looked: a sell list names only what
// the resident carried, so prices spread as residents trade. A sighting older than a week is
// forgotten, and so is a vendor that later turned the resident away.
export interface Sighting {
  vendor: number;
  x: number;
  y: number;
  z: number;
  price: number;
  at: number;
}
type Side = 'charges' | 'pays';
const WEEK = 7 * 24 * 3_600_000;
const book: Record<Side, Map<number, Map<number, Sighting>>> = { charges: new Map(), pays: new Map() };

export function notePrices(
  session: PlayerSession,
  vendor: number,
  side: Side,
  seen: { graphic: number; price: number }[]
) {
  const where = session.world.entities.get(vendor)?.position;
  if (!where) return;
  for (const { graphic, price } of seen) {
    if (!graphic || price <= 0) continue;
    const vendors = book[side].get(graphic) ?? new Map<number, Sighting>();
    book[side].set(graphic, vendors);
    vendors.set(vendor, { vendor, x: where.x, y: where.y, z: where.z, price, at: Date.now() });
  }
}

export function forgetVendor(vendor: number) {
  for (const side of Object.values(book)) for (const vendors of side.values()) vendors.delete(vendor);
}

// The cheapest vendor seen selling `graphic`, or the one paying most for it, among `near` ones.
export function bestPrice(side: Side, graphic: number, near: (s: Sighting) => boolean = () => true) {
  let best: Sighting | undefined;
  for (const seen of book[side].get(graphic)?.values() ?? []) {
    if (Date.now() - seen.at > WEEK || !near(seen)) continue;
    if (!best || (side === 'charges' ? seen.price < best.price : seen.price > best.price)) best = seen;
  }
  return best;
}

export const pricedGoods = (side: Side) => [...book[side].keys()];
