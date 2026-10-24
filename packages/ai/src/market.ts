import { gold } from '@gemwright/common/items';

import { noteTrade } from './activity';
import type { CharacterTemplate } from './config';
import { type DecisionCoordinator, decisionGuard, decisionState } from './decisions';
import { guildmates } from './guilds';
import { quality } from './item-quality';
import { allServiceLocations, type ServiceType, serviceLocations } from './locations';
import { moongates, nearestGate, travelByMoongate } from './moongate';
import type { createNavigator } from './navigation';
import { distance } from './navigation';
import { playerUnitPrice } from './player-insight';
import type { PlayerSession } from './protocol/session';
import type { Entity, JournalEntry, Position } from './protocol/world';
import type { Checkpoint } from './store';
import { buyByTrade, lastFailure, sellByTrade } from './trade-deal';
import { endTrade, expectTrade } from './trade-guard';

// Residents trade with each other at their town bank, as players do: a seller shouts its lot, a
// buyer shouts what it wants, they agree on a lot price in a turn or two of speech, and the seller
// hands the goods over in the secure trade window (trade-deal.ts). Prices sit between what the NPC
// shop pays for the goods and what it charges for them, so both sides beat the shop. Market lines
// keep a fixed shape, so every resident reads them without a model:
//   Selling 128 boards for 320 gold      Buying 50 boards for 125 gold
//   Rowan, 50 boards for 125 gold        Deal, Rowan: 50 boards for 125 gold
// `market` is the town that trades the good: for boards, where most producers live (Yew holds
// three of the four lumberjack homes); for potions, Britain, where most fighters restock. Trade
// happens at the town's bank, or at the good's shop in a town without one (Yew). Buyers and sellers
// both travel there. `lot` is the smallest deal worth the trip. Shop prices: SBCarpenter (boards),
// SBAlchemist (the lesser potions; regular ones share their graphic).
export type Good = 'boards' | 'heal potions' | 'cure potions' | 'poison potions' | 'iron ingots' | 'exceptional bows';
interface GoodDef {
  graphic: number;
  // Several graphics for one good (bow and composite bow); `graphic` alone otherwise.
  graphics?: readonly number[];
  // Only exceptional pieces count (item-quality.ts).
  exceptional?: boolean;
  // What a crafter makes for it, best first.
  recipes?: readonly string[];
  shopPays: number;
  shopCharges: number;
  market: string;
  shop: ServiceType;
  lot: number;
}
export const goods: Record<Good, GoodDef> = {
  boards: { graphic: 0x1bd7, shopPays: 2, shopCharges: 3, market: 'yew', shop: 'carpenter', lot: 10 },
  'heal potions': { graphic: 0x0f0c, shopPays: 7, shopCharges: 15, market: 'britain', shop: 'alchemist', lot: 2 },
  'cure potions': { graphic: 0x0f07, shopPays: 7, shopCharges: 15, market: 'britain', shop: 'alchemist', lot: 2 },
  'poison potions': { graphic: 0x0f0a, shopPays: 7, shopCharges: 15, market: 'britain', shop: 'alchemist', lot: 2 },
  // SBBlacksmith: sells iron at 5 (only 16 in stock), buys at 4; Minoc is the miners' town.
  'iron ingots': { graphic: 0x1bf2, shopPays: 4, shopCharges: 5, market: 'minoc', shop: 'blacksmith', lot: 10 },
  // A bowyer's exceptional bows and composite bows (item-quality.ts) for archers. Shops buy any bow
  // back for at most 27 (SBRangedWeapon), so the band starts above that and runs to 80.
  'exceptional bows': {
    graphic: 0x13b2,
    graphics: [0x13b2, 0x26c2],
    exceptional: true,
    // What the bowyer makes for it, best first; normal results go to the shop.
    recipes: ['composite bow', 'bow'],
    shopPays: 27,
    shopCharges: 81,
    market: 'yew',
    shop: 'bowyer',
    lot: 1
  }
};

// The items a good covers: plain (unhued) ones of its graphics, and only exceptional ones when so.
export const goodMatch = (good: Good) => {
  const def = goods[good];
  const graphics = def.graphics ?? [def.graphic];
  return (item: Entity) =>
    graphics.includes(item.graphic) && !item.hue && (!def.exceptional || quality(item) === 'exceptional');
};
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

export interface MarketContext {
  session: PlayerSession;
  // Temperament and Jev stances need the template; without one the market bargains fairly.
  template?: CharacterTemplate;
  checkpoint: Checkpoint;
  city: string;
  position: () => Position;
  navigate: ReturnType<typeof createNavigator>;
  phase: (phase: string, note: string) => void;
  backpack: () => number;
  decisions?: DecisionCoordinator;
}

// The lowest a seller takes and the most a buyer pays for `n`: one gold either side of the shop.
export const floor = (good: Good, n: number) => n * goods[good].shopPays + 1;
export const ceiling = (good: Good, n: number) => n * goods[good].shopCharges - 1;
// A price at `share` of the way from the floor to the ceiling, kept inside both.
export const priceAt = (good: Good, n: number, share: number) =>
  Math.max(
    floor(good, n),
    Math.min(ceiling(good, n), Math.round(floor(good, n) + (ceiling(good, n) - floor(good, n)) * share))
  );

// How hard to bargain: Jev's pick when configured, otherwise the resident's temperament.
async function stance(ctx: MarketContext, kind: string, good: Good): Promise<number> {
  // Bolder residents (risk shift -0.15..0.15) bargain harder.
  const bold = ctx.template?.behavior.temperament?.riskShift ?? 0;
  const levels = { soft: 0.25, fair: 0.5, hard: 0.75 } as const;
  // Where players have named a going price (player-insight.ts), the stance follows it.
  const unit = playerUnitPrice(good);
  const { shopPays, shopCharges } = goods[good];
  const going = unit === undefined ? undefined : (unit - shopPays) / (shopCharges - shopPays);
  const baseline =
    going !== undefined
      ? going > 0.6
        ? 'hard'
        : going < 0.4
          ? 'soft'
          : 'fair'
      : bold > 0.05
        ? 'hard'
        : bold < -0.05
          ? 'soft'
          : 'fair';
  if (!ctx.decisions || !ctx.template) return levels[baseline];
  const pick = await ctx.decisions.choose({
    kind,
    checkpoint: ctx.checkpoint,
    observationRevision: ctx.session.world.revision,
    state: decisionState(ctx.session, ctx.template, ctx.checkpoint, {
      good,
      shopPays: goods[good].shopPays,
      shopCharges: goods[good].shopCharges
    }),
    candidates: (Object.keys(levels) as (keyof typeof levels)[]).map((id) => ({
      id,
      description:
        kind === 'market-ask'
          ? `Ask a ${id} price: ${levels[id] * 100}% of the way from the shop's buying price to its selling price`
          : `Bid a ${id} price: ${(1 - levels[id]) * 100}% of the way from the shop's buying price to its selling price`,
      valid: () => true
    })),
    baseline,
    stillCurrent: decisionGuard(ctx.session)
  });
  const chosen = (pick?.id ?? baseline) as keyof typeof levels;
  ctx.decisions.finish(ctx.checkpoint, pick, 'completed', `Market stance: ${chosen}`);
  return kind === 'market-ask' ? levels[chosen] : 1 - levels[chosen];
}

const firstName = (session: PlayerSession, serial: number) =>
  (session.world.entities.get(serial)?.name ?? '').split(' ')[0] ?? '';
const me = (session: PlayerSession) => firstName(session, session.world.serial ?? -1).toLowerCase();

// New market lines heard from others since `seen`, newest last.
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

function heard(session: PlayerSession, seen: Set<JournalEntry>) {
  const fresh: { entry: JournalEntry; kind: string; to?: string; n: number; good: string; total: number }[] = [];
  for (const entry of session.world.journal) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    if (!entry.text || entry.serial === session.world.serial) continue;
    const line = parseMarketLine(entry.text);
    if (line) fresh.push({ entry, ...line });
  }
  return fresh;
}

// A market line older than 20 seconds belongs to a conversation that has moved on.
const stale = (entry: JournalEntry) => Date.now() - Date.parse(entry.at) > 20_000;

const spot = (city: string, good: Good) =>
  serviceLocations(city, 'banker')[0] ?? serviceLocations(city, goods[good].shop)[0];

// Walks to a place, through the nearest public moongate when it is far.
const travelTo = async (ctx: MarketContext, place: { x: number; y: number }) => {
  const gate = nearestGate(place);
  if (distance(ctx.position(), place) > 300 && distance(ctx.position(), moongates[gate]) > 2)
    await travelByMoongate(ctx, gate);
  await ctx.navigate(place, 3);
};
const atMarket = async (ctx: MarketContext, city: string, good: Good) => {
  const place = spot(city, good);
  if (place) await travelTo(ctx, place);
  return !!place;
};

// Stands at the good's market offering `stock` for up to `minutes`, answering buyers, then goes
// home; returns the number sold. Every deal is a separate trade window, recorded either way.
export async function sellAtMarket(ctx: MarketContext, good: Good, stock: number, minutes: number) {
  const { session } = ctx;
  const { lot, market } = goods[good];
  if (stock < lot || !(await atMarket(ctx, market, good))) return 0;
  const share = await stance(ctx, 'market-ask', good);
  const seen = new Set(session.world.journal);
  const until = Date.now() + minutes * 60_000;
  let sold = 0;
  let shoutedAt = 0;
  while (Date.now() < until && stock - sold >= lot && session.phase === 'ready') {
    const left = stock - sold;
    if (Date.now() - shoutedAt > 30_000) {
      ctx.phase('market-selling', `Offering ${left} ${good} at the bank`);
      session.say(`Selling ${left} ${good} for ${priceAt(good, left, share)} gold`);
      shoutedAt = Date.now();
    }
    for (const line of heard(session, seen)) {
      if (line.good !== good || line.n > left || line.n < 1 || stale(line.entry)) continue;
      const name = (line.entry.name ?? '').split(' ')[0] ?? '';
      const fair = line.total >= floor(good, line.n);
      // A buyer's shout within reach: answer it; the buyer's "Deal" starts the trade.
      if (line.kind === 'buying') {
        if (fair) session.say(`${name}, ${line.n} ${good} for ${line.total} gold`);
        continue;
      }
      if (line.to !== me(session)) continue;
      // A bid to me: take it when it beats the shop, else counter at my own price.
      if (line.kind === 'offer') {
        if (!fair) {
          session.say(`${name}, ${line.n} ${good} for ${priceAt(good, line.n, share)} gold`);
          continue;
        }
        session.say(`Deal, ${name}: ${line.n} ${good} for ${line.total} gold`);
      }
      const buyer = session.world.entities.get(line.entry.serial);
      if (!buyer?.position) continue;
      ctx.phase('market-trade', `Trading ${line.n} ${good} to ${name} for ${line.total} gold`);
      await ctx.navigate(buyer.position, 1).catch(() => {});
      const done = await sellByTrade(session, ctx.backpack(), buyer.serial, goodMatch(good), line.n, line.total);
      noteTrade(session, {
        role: 'seller',
        partner: line.entry.name ?? '',
        good,
        amount: line.n,
        price: line.total,
        market,
        done,
        reason: done ? undefined : lastFailure(session)
      });
      if (done) sold += line.n;
    }
    await Bun.sleep(1500);
  }
  await atMarket(ctx, ctx.city, good);
  return sold;
}

// Offers everything of the good carried (plain items only) at its market.
export const sellCarried = (ctx: MarketContext, good: Good, minutes: number) =>
  sellAtMarket(ctx, good, carriedOf(ctx.session, ctx.backpack(), good), minutes);

// Looks for `want` of a good at its market for up to `minutes`: answers sellers' shouts within its
// bid, or shouts a bid of its own; pays in coins taken from the bank. Returns the number bought.
export async function buyAtMarket(ctx: MarketContext, good: Good, want: number, minutes: number) {
  const { session } = ctx;
  // Coins come from the home bank first: the market town may have no banker to withdraw from.
  const { lot, market } = goods[good];
  if (want < lot || !(await coins(ctx, ceiling(good, want), ctx.city))) return 0;
  if (!(await atMarket(ctx, market, good))) return 0;
  const share = await stance(ctx, 'market-bid', good);
  const seen = new Set(session.world.journal.filter((entry) => Date.now() - Date.parse(entry.at) > 60_000));
  const until = Date.now() + minutes * 60_000;
  let bought = 0;
  let shoutedAt = 0;
  // One seller at a time: a bid to one waits up to 20 seconds for its answer before another.
  let courting: { serial: number; until: number } | undefined;
  bidding: while (Date.now() < until && want - bought >= lot && session.phase === 'ready') {
    const need = want - bought;
    for (const line of heard(session, seen)) {
      if (line.good !== good || line.n < 1 || stale(line.entry)) continue;
      const name = (line.entry.name ?? '').split(' ')[0] ?? '';
      const n = Math.min(need, line.n);
      const price = Math.round((line.total / line.n) * n);
      // A guildmate's lot comes before a stranger's (guilds.ts).
      const busy =
        courting &&
        courting.until > Date.now() &&
        courting.serial !== line.entry.serial &&
        !(
          guildmates(session.world.serial ?? 0, line.entry.serial) &&
          !guildmates(session.world.serial ?? 0, courting.serial)
        );
      if (line.kind === 'selling') {
        if (busy) continue;
        session.say(`${name}, ${n} ${good} for ${price <= ceiling(good, n) ? price : priceAt(good, n, share)} gold`);
        courting = { serial: line.entry.serial, until: Date.now() + 20_000 };
        continue;
      }
      if (line.to !== me(session) || line.n > need || busy) continue;
      courting = undefined;
      // This seller's window is expected from here on, even while coins are fetched (trade-guard.ts).
      expectTrade(session, line.entry.serial);
      if (line.kind === 'offer') {
        if (line.total > ceiling(good, line.n)) continue;
        if (!(await coins(ctx, line.total, market))) break bidding;
        session.say(`Deal, ${name}: ${line.n} ${good} for ${line.total} gold`);
      } else if (!(await coins(ctx, line.total, market))) break bidding;
      ctx.phase('market-trade', `Buying ${line.n} ${good} from ${name} for ${line.total} gold`);
      const done = await buyByTrade(session, ctx.backpack(), line.entry.serial, goodMatch(good), line.n, line.total);
      noteTrade(session, {
        role: 'buyer',
        partner: line.entry.name ?? '',
        good,
        amount: line.n,
        price: line.total,
        market,
        done,
        reason: done ? undefined : lastFailure(session)
      });
      if (done) bought += line.n;
    }
    if (Date.now() - shoutedAt > 45_000) {
      ctx.phase('market-buying', `Looking to buy ${need} ${good} at the bank`);
      session.say(`Buying ${need} ${good} for ${priceAt(good, need, share)} gold`);
      shoutedAt = Date.now();
    }
    await Bun.sleep(1500);
  }
  endTrade(session);
  await atMarket(ctx, ctx.city, good);
  return bought;
}

// Makes sure `price` coins are carried, withdrawing the rest from `city`'s bank when it has one.
async function coins(ctx: MarketContext, price: number, city: string) {
  const { session } = ctx;
  const carried = () =>
    session.world
      .childrenOf(ctx.backpack())
      .filter((item) => item.graphic === gold)
      .reduce((sum, item) => sum + (item.amount ?? 1), 0);
  const short = price - carried();
  if (short <= 0) return true;
  // A town without a bank (Yew) withdraws at the nearest one.
  const bank =
    serviceLocations(city, 'banker')[0] ??
    allServiceLocations('banker').sort((a, b) => distance(ctx.position(), a) - distance(ctx.position(), b))[0];
  if (!bank) return false;
  if (distance(ctx.position(), bank) > 10) await travelTo(ctx, bank).catch(() => {});
  session.say(`withdraw ${short}`);
  await session.waitFor(() => carried() >= price, 'withdrawn coins', 4000).catch(() => {});
  return carried() >= price;
}
