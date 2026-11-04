import { Tiledata } from '@gemwright/common/assets/tiledata';
import { GHOST_BODIES } from '@gemwright/common/game/bodies';
import { fish, gems, gold, hides, isDeathRobe, ore, reagents, scrolls, shopBought } from '@gemwright/common/game/items';
import { skillId } from '@gemwright/common/game/skills';
import { Layer } from '@gemwright/network/layers';
import type { PlayerSession } from '@gemwright/network/session';
import type { Entity, Position, WorldView } from '@gemwright/network/world';

import { Blocked } from './blocked';
import { threatsNear } from './danger';
import { enoughTools, packItems } from './inventory';
import { useAcquiredItems, usefulGift } from './inventory-use';
import type { createNavigator } from './navigation';
import { distance } from './navigation';
import type { Terrain } from './terrain';

// Picks up worthwhile loose items lying on open ground, as any player would: gold, gems, reagents,
// bandages, potions, scrolls, ammunition, crafting materials, tools, instruments, fish, books and
// anything wearable (weapons and armour included). Food, lamps and furniture are left lying. Only items
// the server marks movable count (Item.GetPacketFlags 0x20), so world decoration is never touched;
// corpses and containers are other code's business. Nothing is picked up with a threat close by or
// a pack near its limit. What is carried is then used by the resident's own routines (healing,
// casting, crafting, dressing) or sold and banked on the next town trip.
export interface ScavengeContext {
  session: PlayerSession;
  serial: number;
  terrain: Terrain;
  position: () => Position;
  status: () => NonNullable<WorldView['status']>;
  navigate: ReturnType<typeof createNavigator>;
  check: () => void;
  phase: (phase: string, note: string) => void;
  log: (message: string) => void;
  backpack: () => number;
}

const MOVABLE = 0x20;
const RANGE = 10;
const WEARABLE = 0x400000;
const kinds: ReadonlySet<number> = new Set([
  gold,
  ...gems,
  ...reagents,
  ...scrolls,
  ...ore,
  ...hides,
  ...fish,
  ...shopBought
]);
// Items this session could not reach or the server refused; never tried again.
const skipped = new WeakMap<PlayerSession, Map<number, number>>();
const ghosts = GHOST_BODIES;

// Never a death robe: they are dropped to be rid of them.
// Ore is only worth carrying to someone who can smelt it (Mining 30 and more: miners); no shop
// buys it, so anyone else leaves it lying.
const worthwhile = (terrain: Terrain, item: Entity, session?: PlayerSession) =>
  !isDeathRobe(item) &&
  !(ore.has(item.graphic) && (session?.world.skills.get(skillId('Mining'))?.base ?? 0) < 30) &&
  (kinds.has(item.graphic) || (terrain.tile(item.graphic, true).flags & WEARABLE) !== 0);

// One pickup if something worthwhile lies within reach. True when it acted.
export async function scavenge(ctx: ScavengeContext): Promise<boolean> {
  const { session, position } = ctx;
  const self = session.world.entities.get(ctx.serial);
  if (!self || ghosts.has(self.graphic)) return false;
  const status = ctx.status();
  // Room is kept for the resident's own work: never past 85% weight or 100 items (inventory.ts).
  if (status.weight >= status.maxWeight * 0.9 || packItems(session, ctx.backpack()).length >= 100) return false;
  const skip = skipped.get(session) ?? new Map<number, number>();
  skipped.set(session, skip);
  for (const [serial, until] of skip) if (until < Date.now()) skip.delete(serial);
  const here = position();
  const entities = [...session.world.entities.values()];
  if (threatsNear(session, here, 8).length) return false;
  const candidates = entities
    .filter(
      (e) =>
        e.kind === 'item' &&
        e.parent === undefined &&
        !!e.position &&
        ((e.flags ?? 0) & MOVABLE) !== 0 &&
        !skip.has(e.serial) &&
        distance(here, e.position) <= RANGE &&
        Math.abs(here.z - e.position.z) <= 10 &&
        worthwhile(ctx.terrain, e, session) &&
        !enoughTools(session, ctx.backpack(), e.graphic)
    )
    .sort((a, b) => distance(here, a.position ?? here) - distance(here, b.position ?? here))
    .slice(0, 6);
  const wanted = await Promise.all(candidates.map((item) => usefulGift(session, item)));
  const item = candidates.find((_item, index) => wanted[index]) ?? candidates[0];
  if (!item?.position) return false;
  skip.set(item.serial, Date.now() + 60_000);
  const name = ctx.terrain.tile(item.graphic, true).name || 'item';
  try {
    ctx.phase(
      'scavenge',
      `Picking up ${item.amount && item.amount > 1 ? `${item.amount} ` : ''}${name} lying at ${item.position.x},${item.position.y}`
    );
    await ctx.navigate(item.position, 1);
    const amount = carryable(session, ctx.terrain, item);
    if (amount < 1) return false;
    await session.moveItem(item.serial, ctx.backpack(), amount);
    ctx.log(`Picked up ${amount < (item.amount ?? 1) ? `${amount} of ${item.amount} ` : ''}${name}`);
    await useAcquiredItems(session);
  } catch (error) {
    if (session.phase !== 'ready') throw error;
    if (!(error instanceof Blocked))
      ctx.log(`Could not pick up ${name}: ${error instanceof Error ? error.message : error}`);
  }
  return true;
}

// While walking: a worthwhile item within lifting reach (ServUO lifts from 2 tiles) is taken
// without leaving the route; anything farther waits for the next stop's scavenge. Quiet unless
// something is taken. True when it picked something up.
// How many of a stack it can take without passing 90% of its carrying weight (each piece's
// weight from the client's tiledata: ore 2, 7 or 12 stones by pile size, logs 2, boards 1). A
// pile too heavy to lift whole is taken in part, as a player splits a stack; the rest stays for
// another trip. 0 when not even one fits.
const tiledata = new Map<string, Tiledata>();
export function carryable(session: PlayerSession, terrain: Terrain, item: Entity) {
  const amount = item.amount ?? 1;
  const status = session.world.status;
  if (!status) return amount;
  let each = 0;
  try {
    const data = tiledata.get(terrain.directory) ?? new Tiledata(terrain.directory);
    tiledata.set(terrain.directory, data);
    each = data.item(item.graphic).weight;
  } catch {
    // No tiledata to read (a test terrain): the whole stack, as before.
  }
  if (each <= 0) return amount;
  const room = status.maxWeight * 0.9 - status.weight;
  return Math.max(0, Math.min(amount, Math.floor(room / each)));
}

export async function pickUpInReach(session: PlayerSession, terrain: Terrain, log: (note: string) => void) {
  const serial = session.world.serial;
  const here = session.world.position;
  const status = session.world.status;
  if (serial === null || !here || !status || status.weight >= status.maxWeight * 0.9) return false;
  const self = session.world.entities.get(serial);
  if (!self || ghosts.has(self.graphic)) return false;
  const pack = session.world.childrenOf(serial).find((item) => item.layer === Layer.Backpack);
  if (!pack || packItems(session, pack.serial).length >= 100) return false;
  const skip = skipped.get(session) ?? new Map<number, number>();
  skipped.set(session, skip);
  for (const [serial, until] of skip) if (until < Date.now()) skip.delete(serial);
  if (threatsNear(session, here, 8).length) return false;
  let item: Entity | undefined;
  for (const e of session.world.entities.values()) {
    if (
      !item &&
      e.kind === 'item' &&
      e.parent === undefined &&
      e.position &&
      ((e.flags ?? 0) & MOVABLE) !== 0 &&
      !skip.has(e.serial) &&
      distance(here, e.position) <= 2 &&
      Math.abs(here.z - e.position.z) <= 10 &&
      worthwhile(terrain, e, session) &&
      !enoughTools(session, pack.serial, e.graphic)
    )
      item = e;
  }
  if (!item) return false;
  skip.set(item.serial, Date.now() + 60_000);
  const name = terrain.tile(item.graphic, true).name || 'item';
  try {
    const amount = carryable(session, terrain, item);
    if (amount < 1) return false;
    await session.moveItem(item.serial, pack.serial, amount);
    log(`Picked up ${amount < (item.amount ?? 1) ? `${amount} of ${item.amount} ` : ''}${name} in passing`);
    await useAcquiredItems(session);
    return true;
  } catch {
    return false;
  }
}
