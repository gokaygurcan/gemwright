import { TileFlag } from '@gemwright/common/assets/tiledata';
import { gold, isDeathRobe } from '@gemwright/common/game/items';
import { LAYERS } from '@gemwright/common/game/layers';
import { soldAs } from '@gemwright/common/game/rules';
import type { PlayerSession } from '@gemwright/network/session';
import type { Entity } from '@gemwright/network/world';

import type { CraftContext } from './craft-training';
import { isGargoyle } from './flight';
import { buyOffer, findOffer } from './resident-offers';
import type { Terrain } from './terrain';
import { buyFrom } from './vendor-trade';

// The white robe ServUO puts on a resurrected character (DeathRobe, a robe that decays a minute
// after it is dropped). Going back to its corpse (corpse-recovery.ts) puts its own clothes back on
// and leaves the robe behind. Otherwise it sheds the robe once it has its own clothes to wear: a
// carried robe, shirt, tunic or chest piece goes on in its place, and a resident with none buys a
// robe (or a shirt) from a tailor once it can afford one with 50 gold to spare.
export { isDeathRobe };

const TORSO = [
  LAYERS.outerTorso, // robe
  LAYERS.middleTorso, // tunic, surcoat
  LAYERS.innerTorso, // chest armour
  LAYERS.shirt
];

export const wearsDeathRobe = (session: PlayerSession) =>
  session.world.childrenOf(session.world.serial ?? -1).some(isDeathRobe);

// Drops the death robe and puts on the first carried torso clothing; true when it changed clothes.
// Without anything of its own to wear, the robe stays on.
export async function shedDeathRobe(session: PlayerSession, terrain: Terrain, carried: Entity[]): Promise<boolean> {
  const robe = session.world.childrenOf(session.world.serial ?? -1).find(isDeathRobe);
  if (!robe) return false;
  const own = carried
    .filter((item) => !isDeathRobe(item) && terrain.tile(item.graphic, true).flags & TileFlag.Wearable)
    .map((item) => ({ item, layer: terrain.tile(item.graphic, true).layer }))
    .filter(({ layer }) => TORSO.includes(layer as (typeof TORSO)[number]))
    .sort(
      (a, b) => TORSO.indexOf(a.layer as (typeof TORSO)[number]) - TORSO.indexOf(b.layer as (typeof TORSO)[number])
    )[0];
  if (!own) return false;
  await session.dropAtFeet(robe.serial);
  try {
    await session.equipItem(own.item.serial, own.layer);
  } catch (error) {
    // A piece the shard will not wear (race, gender or another requirement): put the robe back on
    // rather than stand naked; the piece itself is dealt with as loot.
    if (session.phase !== 'ready') throw error;
    await session.equipItem(robe.serial, robe.layer ?? LAYERS.outerTorso).catch(() => {});
    return false;
  }
  return true;
}

// A robe or a shirt from a tailor (ServUO SBTailor).
const ROBE = soldAs('Robe');
const SHIRT = soldAs('Shirt');
const CLOTHES = { reserve: 50, perHour: 100 };
const lastTry = new WeakMap<PlayerSession, number>();

// New clothes for a resident still in the death robe with nothing of its own: from a resident
// tailor nearby when there is one, else the shop at most every half hour with a robe's price and
// the reserve. Then the robe comes off.
export async function replaceDeathRobe(ctx: CraftContext & { backpack: () => number }): Promise<boolean> {
  const { session } = ctx;
  // Each death in the robe leaves the old one in the pack (it is newbied, so it survives death).
  // Dropped, it decays within a minute.
  const { putDown } = await import('./overload');
  for (const [n, spare] of ctx.carried(ctx.backpack()).filter(isDeathRobe).entries())
    await putDown(session, spare.serial, n);
  if (!wearsDeathRobe(session)) return false;
  if (await shedDeathRobe(session, ctx.terrain, ctx.carried(ctx.backpack()))) return true;
  // Human robes and shirts do not fit a gargoyle; it keeps its own gear (flight.ts).
  if (isGargoyle(session)) return false;
  if (Date.now() - (lastTry.get(session) ?? 0) < 30 * 60_000) return false;
  // A resident tailor nearby sells for less than the shop (resident-offers.ts): even the
  // poorest can afford a shirt from one.
  const coins = ctx
    .carried(ctx.backpack())
    .filter((i) => i.graphic === gold && !i.hue)
    .reduce((n, i) => n + (i.amount ?? 1), 0);
  const offer = findOffer('clothes', ctx.position(), 40, coins, ctx.serial);
  if (offer && (await buyOffer(ctx, offer).catch(() => false))) {
    lastTry.set(session, Date.now());
    return shedDeathRobe(session, ctx.terrain, ctx.carried(ctx.backpack()));
  }
  const funds = (session.world.status?.gold ?? 0) + (ctx.checkpoint.funds?.bank ?? 0);
  if (funds < 18 + CLOTHES.reserve) return false;
  lastTry.set(session, Date.now());
  ctx.phase('buying-clothes', 'Buying a robe to wear instead of the death robe');
  for (const graphic of [ROBE, SHIRT])
    if (await buyFrom({ ...ctx, limits: CLOTHES }, 'tailor', new Map([[graphic, 1]]))) break;
  return shedDeathRobe(session, ctx.terrain, ctx.carried(ctx.backpack()));
}
