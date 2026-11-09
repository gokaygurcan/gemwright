import { readdirSync } from 'node:fs';

import { TileFlag } from '@gemwright/common/assets/tiledata';
import {
  arrow,
  bandage,
  board,
  boltOfCloth,
  bulkOrderDeed,
  cloth,
  crossbowBolt,
  fish,
  gems,
  gold,
  healPotion,
  ingot,
  isDeathRobe,
  logPile,
  magicFish,
  ore,
  reagents,
  uncutCloth
} from '@gemwright/common/game/items';
import type { Entity } from '@gemwright/network/world';

import { Blocked } from './blocked';
import { type CraftContext, craftRecipes } from './craft-training';
import { fishingFootwear } from './fishing-catch';
import { packFull, workGear } from './inventory';
import { knownNewbied, learnQuality, provenRegular, shopTakes, traits } from './item-quality';
import { type ServiceType, townAt } from './locations';
import { lighten, putDown, recoverPile } from './overload';
import { tradesBuying } from './shops';
import { sellTo } from './vendor-trade';
import { reservedFor } from './work-orders';

// Selling is a task of its own, chosen between others like mining or practice: a resident whose
// pack holds goods it has no use for (what it made, caught or picked up) takes them to the shops
// of its town that buy them. It never sells its tools, money, gems, supplies or raw materials.
type Ctx = CraftContext & { backpack: () => number };

// What each trade's shop buys back: everything its crafters make (catalogs/crafts; a recipe's
// label is 1020000 + its graphic).
const crafts: Record<string, ServiceType[]> = {
  blacksmith: ['blacksmith', 'weaponsmith'],
  tailoring: ['tailor'],
  bowcraft: ['bowyer'],
  carpentry: ['carpenter'],
  tinkering: ['tinker'],
  alchemy: ['alchemist']
};
const buyers = new Map<number, ServiceType[]>();
for (const file of readdirSync(new URL('../catalogs/crafts/', import.meta.url))) {
  const name = file.replace('.json', '');
  const skill = name === 'bowcraft' ? 'Bowcraft' : name.charAt(0).toUpperCase() + name.slice(1);
  for (const recipe of craftRecipes(skill)) {
    const graphic = recipe.label - 1020000;
    if (!buyers.has(graphic)) buyers.set(graphic, crafts[name] ?? []);
  }
}
// Everything a trade makes (catalogs/crafts), sold rather than hoarded.
export const craftedGoods: ReadonlySet<number> = new Set(buyers.keys());
const materials = new Set([ingot, ...ore, logPile, board, cloth, uncutCloth, boltOfCloth]);
const kept = (item: Entity) =>
  workGear.has(item.graphic) ||
  item.graphic === gold ||
  gems.has(item.graphic) ||
  reagents.has(item.graphic) ||
  [bandage, healPotion, arrow, crossbowBolt].includes(item.graphic) ||
  materials.has(item.graphic) ||
  isDeathRobe(item);

export function shopsFor(ctx: Pick<Ctx, 'terrain'>, item: Entity): ServiceType[] {
  // Goods a resident sells: what it caught or made, and wearables it is not wearing. Who buys them
  // is the shard's vendor lists, never a guess: a trade that does not list a piece never buys it
  // anywhere, so no shop is walked to for it.
  const goods =
    fishingFootwear.has(item.graphic) ||
    buyers.has(item.graphic) ||
    fish.has(item.graphic) ||
    (ctx.terrain.tile(item.graphic, true).flags & TileFlag.Wearable) !== 0;
  return goods ? tradesBuying(item.graphic) : [];
}

// The one answer to "will a shop buy this?": looting, town-trip planning and selling all ask it.
// A piece known to be blessed, insured or cursed never goes to a shop.
export const isSaleable = (ctx: Pick<Ctx, 'session' | 'terrain'>, item: Entity) =>
  !kept(item) &&
  !reservedFor(ctx.session, item) &&
  (!traits(ctx.session.world.entities.get(item.serial) ?? item) ||
    shopTakes(ctx.session.world.entities.get(item.serial) ?? item)) &&
  shopsFor(ctx, item).length > 0;

const BULK_ORDER_DEED = bulkOrderDeed;
const lastTrip = new WeakMap<object, number>();
const MIN_PIECES = 6;
const REST_MS = 20 * 60_000;

// True when it went selling.
export async function sellingTurn(ctx: Ctx, force = false): Promise<boolean> {
  const { session } = ctx;
  // What it put down to be able to walk comes back with it, to be sold too (overload.ts).
  if (await recoverPile(session, ctx.backpack(), ctx.navigate, ctx.log)) return true;
  // Listed pieces sold, dropped or banked leave the list, so it never fills with serials long gone.
  // Newbied pieces (item-quality.ts) leave the list for good.
  const stillCarried = (ctx.checkpoint.forSale ?? []).filter(
    (serial) => session.world.entities.get(serial)?.parent === ctx.backpack() && !knownNewbied(session, serial)
  );
  if (stillCarried.length !== (ctx.checkpoint.forSale ?? []).length) {
    ctx.checkpoint.forSale = stillCarried;
    ctx.persist?.();
  }
  if (!force && Date.now() - (lastTrip.get(session) ?? 0) < REST_MS) return false;
  const carried = ctx.carried(ctx.backpack());
  await learnQuality(
    session,
    carried.filter((item) => shopsFor(ctx, item).length)
  );
  // Pieces made for a bulk order stay with the deed.
  const ordering = carried.some((item) => item.graphic === BULK_ORDER_DEED);
  const exceptionalKept = new Set<number>();
  // Equipment it picked up but cannot use is sold at once, without waiting for a full load
  // (inventory-use.ts marked it).
  const listed = new Set(ctx.checkpoint.forSale ?? []);
  const goods = carried.filter((item) => {
    if (!isSaleable(ctx, item)) return false;
    // Properties read just above: one still unknown is not taken to a shop on a guess.
    if (!traits(session.world.entities.get(item.serial) ?? item)) return false;
    if (knownNewbied(session, item.serial)) return false;
    if (listed.has(item.serial)) return true;
    if (ordering && buyers.has(item.graphic)) return false;
    // One exceptional piece of each kind is kept (it goes to the bank).
    const fresh = session.world.entities.get(item.serial) ?? item;
    if (traits(fresh)?.exceptional && !exceptionalKept.has(item.graphic)) {
      exceptionalKept.add(item.graphic);
      return false;
    }
    return true;
  });
  const status = ctx.status();
  const heavy = status.weight >= status.maxWeight * 0.9;
  const urgent = goods.some((item) => listed.has(item.serial));
  if (!goods.length || (!force && !urgent && goods.length < MIN_PIECES && !(heavy && goods.length >= 2))) return false;
  lastTrip.set(session, Date.now());
  const shops = [...new Set(goods.flatMap((item) => shopsFor(ctx, item)))];
  ctx.phase('selling-goods', `Taking ${goods.length} pieces to sell (${shops.join(', ')})`);
  // It sells in the town it is in, to the shops of the trades that buy each piece (shops.ts):
  // never another town, and a piece no shop here took is put down (below), not carried on.
  const local = { ...ctx, city: townAt(ctx.position(), ctx.city) };
  await lighten(session, ctx.backpack(), kept, ctx.log);
  const forSale = new Set(goods.map((item) => item.serial));
  let earned = 0;
  for (const shop of shops) {
    if (!ctx.carried(ctx.backpack()).some((item) => forSale.has(item.serial))) break;
    ctx.check();
    const sell = () => sellTo(local, shop, (item) => forSale.has(item.serial), true);
    earned += await sell().catch(async (error) => {
      // Too heavy to walk to the shop: it puts down what is cheapest for its weight, then goes.
      if (!(error instanceof Blocked && error.reason === 'overweight')) return 0;
      await lighten(session, ctx.backpack(), kept, ctx.log);
      return sell().catch(() => 0);
    });
  }
  // Wear, sell, drop: a piece this town's buyers listed and still did not take is put down here,
  // where another resident may find it; every vendor of a trade buys the same things, so no other
  // town would take it. Only a listed piece is proven not newbied: one left off the list is newbied
  // (kept for good, vendor-trade.ts), and one no vendor answered for stays in the pack.
  let left = 0;
  for (const serial of forSale) {
    const item = session.world.entities.get(serial);
    if (!item || item.parent !== ctx.backpack() || !provenRegular(session, serial)) continue;
    if (await putDown(session, serial).catch(() => false)) left++;
  }
  const remaining = (ctx.checkpoint.forSale ?? []).filter(
    (serial) => session.world.entities.get(serial)?.parent === ctx.backpack()
  );
  if (remaining.length !== (ctx.checkpoint.forSale ?? []).length) {
    ctx.checkpoint.forSale = remaining;
    ctx.persist?.();
  }
  if (left) ctx.log(`Left ${left} piece(s) no shop would take where another resident may find them`);
  // A pack near full of things no shop type buys is the dead weight of the road: a bag, a tool of
  // another trade, an oddity of a player. A few pieces go per town visit where another may find
  // them, rather than being carried into the water until the pack can hold nothing else.
  const full = packFull(session, ctx.backpack(), 0.85) || status.weight >= status.maxWeight * 0.85;
  if (full) {
    let dumped = 0;
    for (const item of ctx.carried(ctx.backpack())) {
      if (dumped >= 5) break;
      if (item.graphic === gold || magicFish.has(item.graphic)) continue;
      if (kept(item) || reservedFor(session, item) || shopsFor(ctx, item).length) continue;
      // Only a piece proven not newbied (a vendor once listed it) is ever left behind.
      if (!provenRegular(session, item.serial)) continue;
      if (session.world.childrenOf(item.serial).length) continue; // a bag with things inside
      if (await putDown(session, item.serial).catch(() => false)) dumped++;
    }
    if (dumped) ctx.log(`Left ${dumped} piece(s) no shop buys where another resident may find them`);
  }
  ctx.log(
    `Sold goods for ${earned} gold; ${ctx.carried(ctx.backpack()).filter((i) => forSale.has(i.serial)).length} pieces unsold`
  );
  return true;
}
