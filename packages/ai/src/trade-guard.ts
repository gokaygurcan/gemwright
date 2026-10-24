import { notePlayer, noteTrade } from './activity';
import { engagedWith, quoteTo } from './engagement';
import { type Good, goodMatch } from './market';
import { Layer } from './protocol/layers';
import type { PlayerSession } from './protocol/session';
import { buyByTrade, lastFailure, sellByTrade } from './trade-deal';

// A trade window opens whenever someone drops an item on a resident. Only the one partner a market
// deal expects (market.ts, trade-deal.ts) may trade; any other window is cancelled, as a busy player
// would, with one in-character line per partner a minute, so the partner gets its item back at once
// and the resident's own deals never meet a stranger's window.
const expected = new WeakMap<PlayerSession, number>();
const answered = new WeakMap<PlayerSession, Map<number, number>>();

export function expectTrade(session: PlayerSession, partner: number) {
  expected.set(session, partner);
}

export function endTrade(session: PlayerSession) {
  expected.delete(session);
}

export function guardTrades(session: PlayerSession) {
  const timer = setInterval(() => {
    if (session.phase === 'offline' || session.phase === 'failed') {
      clearInterval(timer);
      return;
    }
    const trade = session.world.trade;
    if (session.phase !== 'ready' || !trade || trade.closed || trade.partner === expected.get(session)) return;
    // A player this resident quoted a lot to (engagement.ts) gets that deal in their window.
    const quote = engagedWith(session)?.partner === trade.partner ? engagedWith(session)?.quote : undefined;
    const pack = session.world.childrenOf(session.world.serial ?? -1).find((i) => i.layer === Layer.Backpack);
    if (quote && pack) {
      expectTrade(session, trade.partner);
      const match = goodMatch(quote.good as Good);
      const deal = quote.side === 'sell' ? sellByTrade : buyByTrade;
      void deal(session, pack.serial, trade.partner, match, quote.amount, quote.price).then((done) => {
        const role = quote.side === 'sell' ? 'seller' : 'buyer';
        noteTrade(session, {
          role,
          partner: trade.name,
          good: quote.good,
          amount: quote.amount,
          price: quote.price,
          market: 'here',
          done,
          reason: done ? undefined : lastFailure(session)
        });
        quoteTo(session, trade.partner, undefined);
      });
      return;
    }
    session.cancelTrade();
    notePlayer(session, `trade:${trade.partner}:${trade.mine}`, {
      kind: 'trade-attempt',
      serial: trade.partner,
      name: trade.name
    });
    const said = answered.get(session) ?? new Map<number, number>();
    answered.set(session, said);
    if (Date.now() - (said.get(trade.partner) ?? 0) < 60_000) return;
    said.set(trade.partner, Date.now());
    const name = trade.name.split(' ')[0];
    session.say(`I am not trading with thee right now${name ? `, ${name}` : ''}.`);
  }, 2000);
}
