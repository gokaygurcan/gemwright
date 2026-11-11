import { Opcode } from '@gemwright/network/opcodes';
import type { PlayerSession } from '@gemwright/network/session';

import { ActionBusy } from './action-errors';
import { forgetVendor, notePrices } from './price-book';

// Selling to a vendor as one player action for every resident: its "Sell" context entry opens the
// list of what it buys from us, the resident picks from that list, and the sale is confirmed by the
// gold that actually arrives. A failure says why, so a caller never mistakes our own busy resource
// for a vendor that buys nothing.
export interface SellOffer {
  serial: number;
  graphic: number;
  amount: number;
  price: number;
}
export type Why = 'no-entry' | 'busy' | 'no-reply' | 'no-list';

export async function sellOffers(
  session: PlayerSession,
  vendor: number,
  sell: number
): Promise<{ offers: readonly SellOffer[] } | { why: Why }> {
  let entry: { index: number; cliloc: number; flags: number } | undefined;
  try {
    entry = (await session.context(vendor)).find((e) => e.cliloc === sell && !(e.flags & 1));
  } catch (error) {
    if (session.phase !== 'ready') throw error;
    return { why: error instanceof ActionBusy ? 'busy' : 'no-reply' };
  }
  if (!entry) {
    forgetVendor(vendor);
    return { why: 'no-entry' };
  }
  session.world.sellOffers.delete(vendor);
  session.selectContext(vendor, entry.index);
  const listed = await session
    .waitFor(() => session.world.sellOffers.has(vendor), 'vendor buying list', 2500)
    .then(() => true)
    .catch(() => false);
  if (!listed) return { why: 'no-list' };
  const offers = session.world.sellOffers.get(vendor) ?? [];
  notePrices(session, vendor, 'pays', offers);
  return { offers };
}

// Sells the chosen offers (whole stacks); `earned` is the gold that arrived, 0 when none did.
export async function sellChosen(session: PlayerSession, vendor: number, sale: readonly SellOffer[]) {
  const before = session.world.status?.gold ?? 0;
  await session.sell(
    vendor,
    sale.map((offer) => ({ serial: offer.serial, amount: offer.amount }))
  );
  await session.refreshStatus();
  return {
    amount: sale.reduce((sum, offer) => sum + offer.amount, 0),
    earned: Math.max(0, (session.world.status?.gold ?? 0) - before)
  };
}

// Buying: the "Buy" entry opens the vendor's stock (its buy list packet), or says why it did not.
export type BuyOffer =
  ReturnType<PlayerSession['world']['buyOffers']['get']> extends readonly (infer O)[] | undefined ? O : never;
export async function buyOffers(
  session: PlayerSession,
  vendor: number,
  buy: number
): Promise<{ offers: readonly BuyOffer[] } | { why: Why }> {
  const before = session.world.received.get(Opcode.vendorBuyList) ?? 0;
  session.world.buyOffers.clear();
  let entry: { index: number; cliloc: number; flags: number } | undefined;
  try {
    entry = (await session.context(vendor)).find((e) => e.cliloc === buy && !(e.flags & 1));
  } catch (error) {
    if (session.phase !== 'ready') throw error;
    return { why: error instanceof ActionBusy ? 'busy' : 'no-reply' };
  }
  if (!entry) {
    forgetVendor(vendor);
    return { why: 'no-entry' };
  }
  session.selectContext(vendor, entry.index);
  const listed = await session
    .waitFor(() => (session.world.received.get(Opcode.vendorBuyList) ?? 0) > before, 'vendor stock', 2500)
    .then(() => true)
    .catch(() => false);
  if (!listed) return { why: 'no-list' };
  const offers = [...session.world.buyOffers.values()].flat();
  notePrices(
    session,
    vendor,
    'charges',
    offers.map((offer) => ({ graphic: session.world.entities.get(offer.serial)?.graphic ?? 0, price: offer.price }))
  );
  return { offers };
}
