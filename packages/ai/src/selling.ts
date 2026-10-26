import { readdirSync } from 'node:fs';

import { arrow, bandage, bolt, gems, gold, healPotion, isDeathRobe, reagents } from '@gemwright/common/items';

import { Blocked } from './blocked';
import { type CraftContext, craftRecipes } from './craft-training';
import { workGear } from './inventory';
import { learnQuality, quality } from './item-quality';
import { type ServiceType, townAt } from './locations';
import { lighten, recoverPile } from './overload';
import type { Entity } from './protocol/world';
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
const fish = new Set([
  0x09cc, // fish
  0x09cd, // fish
  0x09ce, // fish
  0x09cf // fish
]);
const materials = new Set([
  0x1bf2, // ingots
  0x19b7, // ore
  0x19b8, // ore
  0x19b9, // ore
  0x19ba, // ore
  0x1bdd, // logs
  0x1bd7, // boards
  0x1766, // cloth
  0x1767, // uncut cloth
  0x0f95 // bolt of cloth
]);
const kept = (item: Entity) =>
  workGear.has(item.graphic) ||
  item.graphic === gold ||
  gems.has(item.graphic) ||
  reagents.has(item.graphic) ||
  [bandage, healPotion, arrow, bolt].includes(item.graphic) ||
  materials.has(item.graphic) ||
  isDeathRobe(item);

function shopsFor(ctx: Ctx, item: Entity): ServiceType[] {
  const crafted = buyers.get(item.graphic);
  if (crafted?.length) return crafted;
  if (fish.has(item.graphic)) return ['fisherman'];
  // Worn goods it is not wearing: armour and weapons to the smiths, clothing to the tailor.
  if (ctx.terrain.tile(item.graphic, true).flags & 0x400000) return ['blacksmith', 'weaponsmith', 'tailor'];
  return [];
}

const BULK_ORDER_DEED = 0x2258;
const lastTrip = new WeakMap<object, number>();
const MIN_PIECES = 6;
const REST_MS = 20 * 60_000;

// True when it went selling.
export async function sellingTurn(ctx: Ctx): Promise<boolean> {
  const { session } = ctx;
  // What it put down to be able to walk comes back with it, to be sold too (overload.ts).
  if (await recoverPile(session, ctx.backpack(), ctx.navigate, ctx.log)) return true;
  if (Date.now() - (lastTrip.get(session) ?? 0) < REST_MS) return false;
  const carried = ctx.carried(ctx.backpack());
  await learnQuality(
    session,
    carried.filter((item) => shopsFor(ctx, item).length)
  );
  // Pieces made for a bulk order stay with the deed.
  const ordering = carried.some((item) => item.graphic === BULK_ORDER_DEED);
  const exceptionalKept = new Set<number>();
  const goods = carried.filter((item) => {
    if (kept(item) || reservedFor(session, item) || !shopsFor(ctx, item).length) return false;
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
  if (goods.length < MIN_PIECES && !(heavy && goods.length >= 2)) return false;
  lastTrip.set(session, Date.now());
  const shops = [...new Set(goods.flatMap((item) => shopsFor(ctx, item)))];
  ctx.phase('selling-goods', `Taking ${goods.length} pieces to sell (${shops.join(', ')})`);
  // It sells in the town it is in, not the one it calls home (a Trinsic fighter hunting near
  // Jhelom sells in Jhelom).
  const town = townAt(ctx.position(), ctx.city);
  const local = { ...ctx, city: town };
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
  ctx.log(
    `Sold goods for ${earned} gold; ${ctx.carried(ctx.backpack()).filter((i) => forSale.has(i.serial)).length} pieces unsold`
  );
  return true;
}
