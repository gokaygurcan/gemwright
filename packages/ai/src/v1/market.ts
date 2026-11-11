import type { PlayerSession } from '@gemwright/network/session';

// The goods residents make, the shop band their prices sit in (market-goods.ts), and the fixed
// shape of market lines residents still read when spoken to (conversation.ts):
//   Selling 128 boards for 320 gold      Buying 50 boards for 125 gold
//   Rowan, 50 boards for 125 gold        Deal, Rowan: 50 boards for 125 gold
export { type Good, goodMatch, goods } from './market-goods';

import { type Good, goodMatch, goods } from './market-goods';

// The recipes that make a good, best first (an exceptional good's); none for plain goods.
export const goodRecipes = (good: Good): readonly string[] => goods[good].recipes ?? [];
export const carriedOf = (session: PlayerSession, backpack: number, good: Good) =>
  session.world
    .childrenOf(backpack)
    .filter(goodMatch(good))
    .reduce((n, item) => n + (item.amount ?? 1), 0);

const SHOUT = /^(selling|buying) (\d+) ([a-z ]+?) for (\d+) gold$/i;
const OFFER = /^(\w+), (\d+) ([a-z ]+?) for (\d+) gold\??$/i;
const DEAL = /^deal, (\w+): (\d+) ([a-z ]+?) for (\d+) gold$/i;

// The lowest a seller takes and the most a buyer pays for `n`: one gold either side of the shop.
export const floor = (good: Good, n: number) => n * goods[good].shopPays + 1;
export const ceiling = (good: Good, n: number) => n * goods[good].shopCharges - 1;
// A price at `share` of the way from the floor to the ceiling, kept inside both.
export const priceAt = (good: Good, n: number, share: number) =>
  Math.max(
    floor(good, n),
    Math.min(ceiling(good, n), Math.round(floor(good, n) + (ceiling(good, n) - floor(good, n)) * share))
  );

// A market line read into its parts: selling, buying, offer (to a named partner) or deal.
export function parseMarketLine(text: string) {
  const line = text.trim();
  const [kind, m] = ((): [string, RegExpExecArray | null] => {
    const shout = SHOUT.exec(line);
    if (shout) return [shout[1]?.toLowerCase() ?? '', shout];
    const deal = DEAL.exec(line);
    return deal ? ['deal', deal] : ['offer', OFFER.exec(line)];
  })();
  if (!m) return undefined;
  const to = kind === 'deal' || kind === 'offer' ? m[1]?.toLowerCase() : undefined;
  return { kind, to, n: Number(m[2]), good: m[3]?.toLowerCase() ?? '', total: Number(m[4]) };
}
