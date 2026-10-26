import { canPause } from './action-purpose';
import { notePlayer, noteTrade } from './activity';
import { engagedWith, quoteTo } from './engagement';
import { usefulGift } from './inventory-use';
import { type Good, goodMatch } from './market';
import { Layer } from './protocol/layers';
import type { PlayerSession } from './protocol/session';
import type { Entity } from './protocol/world';
import { residentContext } from './resident-context';
import { rememberPartner } from './resident-memory';
import { buyByTrade, lastFailure, sellByTrade } from './trade-deal';
import { finishWorkOrder, orderQuote } from './work-orders';

const expected = new WeakMap<PlayerSession, number>();
const watching = new WeakSet<PlayerSession>();
const running = new WeakSet<PlayerSession>();
interface WindowMemory {
  mine: number;
  partner: number;
  openedAt: number;
  changedAt: number;
  signature: string;
  asked: boolean;
  closedAt?: number;
  gift?: { name: string; baseline: Map<string, number>; offered: Map<string, number> };
}
const windows = new WeakMap<PlayerSession, WindowMemory>();
export const expectTrade = (session: PlayerSession, partner: number) => expected.set(session, partner);
export const endTrade = (session: PlayerSession) => expected.delete(session);
const key = (item: Entity) => `${item.graphic}:${item.hue ?? 0}`;
const amounts = (items: Entity[]) => {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + (item.amount ?? 1));
  return counts;
};
const signature = (session: PlayerSession, mine: number, theirs: number) =>
  JSON.stringify(
    [mine, theirs].map((container) =>
      session.world
        .childrenOf(container)
        .map((item) => [item.serial, item.amount, item.graphic, item.hue])
        .sort()
    )
  );

export async function guardTradeTick(session: PlayerSession, now = Date.now()) {
  if (running.has(session) || session.phase !== 'ready') return;
  running.add(session);
  try {
    const trade = session.world.trade;
    const old = windows.get(session);
    const serial = session.world.serial;
    const pack = session.world.childrenOf(serial ?? -1).find((item) => item.layer === Layer.Backpack);
    if (old && (!trade || trade.closed || trade.mine !== old.mine)) {
      if (old.gift && pack) {
        old.closedAt ??= now;
        const current = amounts(session.world.childrenOf(pack.serial));
        const received = [...old.gift.offered].every(
          ([graphic, count]) => (current.get(graphic) ?? 0) >= (old.gift?.baseline.get(graphic) ?? 0) + count
        );
        if (!received && now - old.closedAt < 5000 && (!trade || trade.mine === old.mine)) return;
        if (received) {
          const ctx = residentContext(session);
          if (ctx) {
            rememberPartner(ctx.checkpoint, {
              partner: old.partner,
              name: old.gift.name,
              kind: 'gift',
              detail: 'Gave me useful supplies or equipment in a completed trade',
              id: `gift:${old.mine}`,
              result: 'completed'
            });
            ctx.persist?.();
          }
          if (canPause(session)) session.say(`Thanks, ${old.gift.name.split(' ')[0] || 'friend'}. I can use that.`);
          notePlayer(session, `gift:${old.mine}`, { kind: 'trade-attempt', serial: old.partner, name: old.gift.name });
        }
      }
      windows.delete(session);
    }
    if (!trade || trade.closed || expected.get(session) === trade.partner) return;
    if (!canPause(session)) {
      if (trade.accepted.me) session.acceptTrade(false);
      return;
    }
    const sig = signature(session, trade.mine, trade.theirs);
    let window = windows.get(session);
    if (!window || window.mine !== trade.mine) {
      window = {
        mine: trade.mine,
        partner: trade.partner,
        openedAt: now,
        changedAt: now,
        signature: sig,
        asked: false
      };
      windows.set(session, window);
      notePlayer(session, `trade:${trade.mine}`, { kind: 'trade-attempt', serial: trade.partner, name: trade.name });
    }
    if (window.signature !== sig) {
      window.signature = sig;
      window.changedAt = now;
    }
    const quote =
      orderQuote(session, trade.partner) ??
      (engagedWith(session)?.partner === trade.partner ? engagedWith(session)?.quote : undefined);
    if (quote && pack) {
      expectTrade(session, trade.partner);
      try {
        const deal = quote.side === 'sell' ? sellByTrade : buyByTrade;
        const done = await deal(
          session,
          pack.serial,
          trade.partner,
          goodMatch(quote.good as Good),
          quote.amount,
          quote.price
        );
        noteTrade(session, {
          role: quote.side === 'sell' ? 'seller' : 'buyer',
          partner: trade.name,
          good: quote.good,
          amount: quote.amount,
          price: quote.price,
          market: 'here',
          done,
          reason: done ? undefined : lastFailure(session)
        });
        const ctx = residentContext(session);
        if (done) finishWorkOrder(session, trade.partner, quote.good);
        if (done && ctx) {
          rememberPartner(ctx.checkpoint, {
            partner: trade.partner,
            name: trade.name,
            kind: 'trade',
            detail: `Completed a trade for ${quote.amount} ${quote.good}`,
            result: 'completed',
            id: `trade:${trade.mine}`
          });
          ctx.persist?.();
        }
      } finally {
        quoteTo(session, trade.partner, undefined);
        endTrade(session);
      }
      return;
    }
    const pendingOrder = residentContext(session)?.checkpoint.personal?.orders.find(
      (order) => order.partner === trade.partner && order.side === 'sell' && order.state === 'accepted'
    );
    const offered = session.world.childrenOf(trade.theirs);
    if (pendingOrder) {
      if (!window.asked) {
        window.asked = true;
        session.say('Your order is not ready yet. Keep your payment until I have the goods.');
      }
      if (trade.accepted.me) session.acceptTrade(false);
      if (now - window.changedAt > 45_000) session.cancelTrade();
      return;
    }
    if (pack && session.world.childrenOf(trade.mine).length === 0 && offered.length) {
      const usable = await Promise.all(offered.map((item) => usefulGift(session, item)));
      if (
        usable.some(Boolean) &&
        canPause(session) &&
        session.world.trade === trade &&
        signature(session, trade.mine, trade.theirs) === sig
      ) {
        window.gift = {
          name: trade.name,
          baseline: amounts(session.world.childrenOf(pack.serial)),
          offered: amounts(offered)
        };
        if (!trade.accepted.me) session.acceptTrade(true);
        return;
      }
      if (trade.accepted.me) session.acceptTrade(false);
    }
    if (!window.asked) {
      window.asked = true;
      session.say(offered.length ? 'What would you like for those?' : 'What would you like to trade?');
    }
    // An opening packet precedes its container contents. Give the player time to make an offer.
    if (now - window.changedAt > 45_000 || now - window.openedAt > 120_000) session.cancelTrade();
  } finally {
    running.delete(session);
  }
}

export function guardTrades(session: PlayerSession) {
  if (watching.has(session)) return;
  watching.add(session);
  const timer = setInterval(() => {
    if (session.phase === 'offline' || session.phase === 'failed') {
      clearInterval(timer);
      watching.delete(session);
      return;
    }
    void guardTradeTick(session).catch((error) => {
      endTrade(session);
      if (session.phase === 'ready') console.error(`[trade] ${error instanceof Error ? error.message : error}`);
    });
  }, 1000);
}
