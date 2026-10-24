import { gold } from '@gemwright/common/items';

import { tally } from './activity';
import type { PlayerSession } from './protocol/session';
import type { Entity } from './protocol/world';
import { endTrade, expectTrade } from './trade-guard';

// One agreed deal carried out in the secure trade window (protocol/trade.ts), from either side.
// The seller opens the window by handing the goods over and accepts only once the buyer's coins
// cover the price; the buyer pays only once the goods are in the window. Either side re-checks
// after every change (which clears both acceptances) and cancels when the offer no longer holds.
// A deal counts only when the goods or the coins have actually arrived in the backpack.
// Which items a deal is about (market.ts `goodMatch`): plain goods of a kind, or exceptional ones.
type Match = (item: Entity) => boolean;
const isGold: Match = (item) => item.graphic === gold && !item.hue;
const amountIn = (session: PlayerSession, container: number, match: Match) =>
  session.world
    .childrenOf(container)
    .filter(match)
    .reduce((sum, item) => sum + (item.amount ?? 1), 0);

// Moves `amount` of matching items from the backpack into the open trade window, splitting stacks.
async function offer(session: PlayerSession, backpack: number, into: number, match: Match, amount: number) {
  let left = amount;
  for (const stack of session.world.childrenOf(backpack).filter(match)) {
    if (left <= 0) break;
    const take = Math.min(left, stack.amount ?? 1);
    // A lift refused while the previous drop settles is tried again, up to three times.
    let moved = false;
    for (let tries = 0; tries < 3 && !moved; tries++) {
      if (tries) await Bun.sleep(2000);
      moved = await session.moveItem(stack.serial, into, take).then(
        () => true,
        () => false
      );
    }
    if (!moved) return false;
    left -= take;
  }
  return left <= 0;
}

// Accepts while `holds` stays true, until the window closes; false when the offer stopped holding.
async function settle(session: PlayerSession, holds: () => boolean) {
  const trade = session.world.trade;
  for (let round = 0; trade && !trade.closed && round < 4; round++) {
    if (!holds()) return false;
    if (!trade.accepted.me) session.acceptTrade(true);
    await session
      .waitFor(() => trade.closed || (round > 0 && !trade.accepted.me), 'trade completion', 30_000)
      .catch(() => {});
    if (!trade.closed && trade.accepted.me) return false;
  }
  return !!trade?.closed;
}

const opened = (session: PlayerSession, partner: number) => {
  const trade = session.world.trade;
  return !!trade && !trade.closed && trade.partner === partner;
};

// Why the last deal of a session failed, for the trade log (market.ts, trade-guard.ts).
const failures = new WeakMap<PlayerSession, string>();
const fail = (session: PlayerSession, why: string) => {
  failures.set(session, why);
  return false;
};
export const lastFailure = (session: PlayerSession) => failures.get(session);

// The partner's window is the expected one for the whole deal (trade-guard.ts).
async function withPartner(session: PlayerSession, partner: number, deal: () => Promise<boolean>) {
  expectTrade(session, partner);
  failures.delete(session);
  try {
    return await deal();
  } finally {
    endTrade(session);
  }
}

export const sellByTrade = (
  session: PlayerSession,
  backpack: number,
  buyer: number,
  match: Match,
  amount: number,
  price: number
) => withPartner(session, buyer, () => sell(session, backpack, buyer, match, amount, price));

export const buyByTrade = (
  session: PlayerSession,
  backpack: number,
  seller: number,
  match: Match,
  amount: number,
  price: number
) => withPartner(session, seller, () => buy(session, backpack, seller, match, amount, price));

async function sell(
  session: PlayerSession,
  backpack: number,
  buyer: number,
  match: Match,
  amount: number,
  price: number
): Promise<boolean> {
  if (amountIn(session, backpack, match) < amount) return fail(session, 'goods not carried');
  const coins = amountIn(session, backpack, isGold);
  // Handing over opens the window; a lift refused while another action finishes is tried again.
  for (let tries = 0; tries < 2 && !opened(session, buyer); tries++) {
    if (tries) await Bun.sleep(1500);
    // The largest stack first: a lot that fits in one handover needs no second lift.
    const stack = session.world
      .childrenOf(backpack)
      .filter(match)
      .sort((a, b) => (b.amount ?? 1) - (a.amount ?? 1))[0];
    if (!stack) return fail(session, 'goods not carried');
    await session.giveToMobile(stack.serial, buyer, Math.min(amount, stack.amount ?? 1)).catch(() => {});
    await session.waitFor(() => opened(session, buyer), 'trade window', 5000).catch(() => {});
  }
  const trade = session.world.trade;
  if (!trade || !opened(session, buyer)) return fail(session, 'window did not open');
  const rest = amount - amountIn(session, trade.mine, match);
  if (rest > 0 && !(await offer(session, backpack, trade.mine, match, rest))) {
    session.cancelTrade();
    return fail(session, 'goods refused by the window');
  }
  const paid = () => amountIn(session, trade.theirs, isGold) >= price;
  await session.waitFor(() => trade.closed || paid(), 'payment in the trade window', 60_000).catch(() => {});
  if (!(await settle(session, paid))) {
    session.cancelTrade();
    return fail(session, paid() ? 'partner did not accept' : 'not paid');
  }
  await Bun.sleep(500);
  const done = amountIn(session, backpack, isGold) - coins >= price;
  if (!done) return fail(session, 'payment did not arrive');
  tally(session, 'trades');
  tally(session, 'tradeGoldIn', price);
  return done;
}

async function buy(
  session: PlayerSession,
  backpack: number,
  seller: number,
  match: Match,
  amount: number,
  price: number
): Promise<boolean> {
  const before = amountIn(session, backpack, match);
  if (amountIn(session, backpack, isGold) < price) return fail(session, 'coins not carried');
  await session.waitFor(() => opened(session, seller), 'trade window', 60_000).catch(() => {});
  const trade = session.world.trade;
  if (!trade || !opened(session, seller)) return fail(session, 'window did not open');
  const delivered = () => amountIn(session, trade.theirs, match) >= amount;
  await session.waitFor(() => trade.closed || delivered(), 'goods in the trade window', 30_000).catch(() => {});
  if (!delivered()) {
    session.cancelTrade();
    return fail(session, 'goods not delivered');
  }
  if (!(await offer(session, backpack, trade.mine, isGold, price))) {
    session.cancelTrade();
    return fail(session, 'coins refused by the window');
  }
  if (!(await settle(session, delivered))) {
    session.cancelTrade();
    return fail(session, 'partner did not accept');
  }
  await Bun.sleep(500);
  const done = amountIn(session, backpack, match) - before >= amount;
  if (!done) return fail(session, 'window closed without the swap');
  tally(session, 'trades');
  tally(session, 'tradeGoldOut', price);
  return done;
}
