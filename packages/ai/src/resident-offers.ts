import { gold } from '@gemwright/common/items';

import { canPause } from './action-purpose';
import { tally } from './activity';
import { distance } from './navigation';
import type { PlayerSession } from './protocol/session';
import { buyByTrade, buyPetByTrade, sellByTrade, sellPetByTrade } from './trade-deal';

// Goods residents sell each other face to face at a discount, so both do better than with the
// shop: a tailor's spare garments to a resident still in its death robe, a tamer's spare mount or
// pack animal to one who needs it. The price sits at about 60% of what the shop charges: less
// than the buyer would pay the shop, more than the shop pays the seller (about half), or than a
// released animal brings (nothing). A seller posts what it carries or leads; a buyer finds an
// offer nearby, walks up, says so and claims it; the seller's trade tick (trade-guard.ts,
// serveClaims) opens the trade window with the goods and the buyer pays in it.
export type OfferKind = 'clothes' | 'mount' | 'pack' | 'scroll' | 'runebook';
interface Offer {
  seller: number;
  kind: OfferKind;
  item: number;
  label: string;
  price: number;
  at: { x: number; y: number };
  until: number;
  buyer?: number;
  claimedAt?: number;
}
const offers = new Map<number, Offer>();
const busy = new WeakSet<PlayerSession>();

export const shopShare = (shopPrice: number) => Math.max(1, Math.round(shopPrice * 0.6));

export function postOffer(offer: Omit<Offer, 'until'>, minutes = 45) {
  const old = offers.get(offer.item);
  offers.set(offer.item, {
    ...offer,
    until: Date.now() + minutes * 60_000,
    buyer: old?.buyer,
    claimedAt: old?.claimedAt
  });
}
export const withdrawOffer = (item: number) => offers.delete(item);
export const offered = (item: number) => offers.has(item);

// An unclaimed offer of `kind` within `radius`, cheapest first, that this buyer can pay for.
export function findOffer(
  kind: OfferKind,
  near: { x: number; y: number },
  radius: number,
  purse: number,
  me: number,
  label?: string
) {
  const now = Date.now();
  return [...offers.values()]
    .filter(
      (o) =>
        o.kind === kind &&
        (!label || o.label === label) &&
        o.until > now &&
        o.seller !== me &&
        o.price <= purse &&
        (!o.buyer || now - (o.claimedAt ?? 0) > 120_000) &&
        distance(o.at, near) <= radius
    )
    .sort((a, b) => a.price - b.price)[0];
}

// The buyer's side: to the seller, a word, the claim, and the purchase in the trade window.
export async function buyOffer(
  ctx: {
    session: PlayerSession;
    serial: number;
    backpack: () => number;
    navigate: (goal: { x: number; y: number }, range: number) => Promise<unknown>;
    phase: (phase: string, note: string) => void;
  },
  offer: Offer
): Promise<boolean> {
  const { session } = ctx;
  const seller = session.world.entities.get(offer.seller);
  const coins = session.world
    .childrenOf(ctx.backpack())
    .filter((i) => i.graphic === gold && !i.hue)
    .reduce((n, i) => n + (i.amount ?? 1), 0);
  if (!seller?.position || coins < offer.price) return false;
  ctx.phase(
    'buying-from-resident',
    `Buying ${offer.label} from ${seller.name ?? 'a resident'} for ${offer.price} gold`
  );
  await ctx.navigate(seller.position, 2).catch(() => {});
  const here = session.world.entities.get(offer.seller)?.position;
  if (!here || !session.world.position || distance(session.world.position, here) > 3) return false;
  session.say(
    `${(seller.name ?? '').split(' ')[0] || 'Friend'}, I'll take the ${offer.label} for ${offer.price} gold.`
  );
  offer.buyer = ctx.serial;
  offer.claimedAt = Date.now();
  const done =
    offer.kind === 'clothes' || offer.kind === 'scroll' || offer.kind === 'runebook'
      ? await buyByTrade(session, ctx.backpack(), offer.seller, (i) => i.serial === offer.item, 1, offer.price)
      : await buyPetByTrade(session, ctx.backpack(), offer.seller, offer.price);
  if (done) {
    offers.delete(offer.item);
    tally(session, 'boughtFromResidents');
  } else if (offer.buyer === ctx.serial) delete offer.buyer;
  return done;
}

// The seller's side, from its trade tick: a buyer standing by for one of its offers gets the
// goods handed over in the trade window. One deal at a time, and only when it may pause.
export async function serveClaims(session: PlayerSession, backpack: number) {
  const me = session.world.serial;
  if (me === null || busy.has(session) || session.world.target || !canPause(session)) return;
  const claim = [...offers.values()].find(
    (o) => o.seller === me && o.buyer !== undefined && Date.now() - (o.claimedAt ?? 0) < 90_000
  );
  const buyer = claim?.buyer === undefined ? undefined : session.world.entities.get(claim.buyer);
  if (!claim || !buyer?.position || !session.world.position || distance(session.world.position, buyer.position) > 3)
    return;
  busy.add(session);
  try {
    session.say(`Here, ${(buyer.name ?? '').split(' ')[0] || 'friend'}.`);
    const done =
      claim.kind === 'clothes' || claim.kind === 'scroll' || claim.kind === 'runebook'
        ? await sellByTrade(session, backpack, buyer.serial, (i) => i.serial === claim.item, 1, claim.price)
        : await sellPetByTrade(session, backpack, buyer.serial, claim.item, claim.price);
    if (done) {
      offers.delete(claim.item);
      tally(session, 'soldToResidents');
    } else delete claim.buyer;
  } finally {
    busy.delete(session);
  }
}

// For the stable-bound: a resident's animal on offer nearby, bought in place of the stable's.
export async function animalFromResident(
  ctx: Parameters<typeof buyOffer>[0] & { position: () => { x: number; y: number } },
  kind: 'mount' | 'pack'
): Promise<boolean> {
  const coins = ctx.session.world
    .childrenOf(ctx.backpack())
    .filter((i) => i.graphic === gold && !i.hue)
    .reduce((n, i) => n + (i.amount ?? 1), 0);
  const offer = findOffer(kind, ctx.position(), 60, coins, ctx.serial);
  return !!offer && (await buyOffer(ctx, offer).catch(() => false));
}
