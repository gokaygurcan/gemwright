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
import { learnQuality, quality, shopSafe } from './item-quality';
import { pickLocation, type ServiceType, serviceLocations, townAt } from './locations';
import { distance as nearDistance } from './navigation';
import { lighten, putDown, recoverPile } from './overload';
import { buyersOf } from './price-book';
import { sellTo } from './vendor-trade';
import { reachRegion } from './work-areas';
import { reservedFor } from './work-orders';
import { world } from './world';

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
  if (fishingFootwear.has(item.graphic)) return ['cobbler'];
  const crafted = buyers.get(item.graphic);
  if (crafted?.length) return crafted;
  if (fish.has(item.graphic)) return ['fisherman'];
  // Worn goods it is not wearing: first the shops residents have seen paying for the piece
  // (price-book.ts), else by its kind: weapons to the weaponsmith and blacksmith, metal armour to
  // the blacksmith, the rest (cloth, leather) to the tailor.
  const tile = ctx.terrain.tile(item.graphic, true);
  if (!(tile.flags & TileFlag.Wearable)) return [];
  const known = buyersOf(item.graphic);
  if (known.length) return known;
  if ((tile.layer === 1 || tile.layer === 2) && !/shield|buckler/i.test(tile.name))
    return ['weaponsmith', 'blacksmith'];
  if (/plate|chain|ring|bone|helm|bascinet|gorget|shield|buckler/i.test(tile.name)) return ['blacksmith'];
  return ['tailor'];
}

// The one answer to "will a shop buy this?": looting, town-trip planning and selling all ask it.
export const isSaleable = (ctx: Pick<Ctx, 'session' | 'terrain'>, item: Entity) =>
  !kept(item) && !reservedFor(ctx.session, item) && shopsFor(ctx, item).length > 0;

const BULK_ORDER_DEED = bulkOrderDeed;
const lastTrip = new WeakMap<object, number>();
const MIN_PIECES = 6;
const REST_MS = 20 * 60_000;

// True when it went selling.
export async function sellingTurn(ctx: Ctx, force = false): Promise<boolean> {
  const { session } = ctx;
  // What it put down to be able to walk comes back with it, to be sold too (overload.ts).
  if (await recoverPile(session, ctx.backpack(), ctx.navigate, ctx.log)) return true;
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
    if (listed.has(item.serial)) return true;
    if (ordering && buyers.has(item.graphic)) return false;
    // One exceptional piece of each kind is kept (it goes to the bank).
    const fresh = session.world.entities.get(item.serial) ?? item;
    if (quality(fresh) === 'exceptional' && !exceptionalKept.has(item.graphic)) {
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
  // It sells in the town it is in, not the one it calls home (a Trinsic fighter hunting near
  // Jhelom sells in Jhelom) — unless that town has no shop for what is carried: shoes and sandals
  // with no cobbler about is a load that walks to the nearest town whose shops cover it (Britain,
  // usually, with every trade under one roof). Once per rest period, like any other selling trip.
  const town = townAt(ctx.position(), ctx.city);
  let market = town;
  const missing = shops.filter((service) => serviceLocations(town, service).length === 0);
  if (missing.length && goods.length >= MIN_PIECES) {
    const here = ctx.position();
    const target = (Object.keys(world.cities) as string[])
      .filter((name) => name !== town && world.cities[name]?.enabled)
      .flatMap((name) => {
        const bank = pickLocation(name, 'banker');
        if (!bank || !missing.every((service) => serviceLocations(name, service).length > 0)) return [];
        return [{ name, bank, away: nearDistance(here, bank) }];
      })
      .sort((a, b) => a.away - b.away)[0];
    if (target) {
      ctx.phase(
        'selling-travel',
        `No ${missing.join(', ')} shop in ${town}; taking ${goods.length} pieces to ${target.name}`
      );
      await reachRegion(ctx, target.bank);
      market = target.name;
    }
  }
  const local = { ...ctx, city: market };
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
  // Pieces marked unfit that no shop will take (magic, blessed, exceptional) are left where another
  // resident may find them rather than carried forever; sold or gone pieces leave the list.
  let left = 0;
  for (const serial of listed) {
    const item = session.world.entities.get(serial);
    if (!item || item.parent !== ctx.backpack() || shopSafe(item)) continue;
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
