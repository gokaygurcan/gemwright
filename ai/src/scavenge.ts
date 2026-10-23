import { Blocked } from './blocked';
import type { createNavigator } from './navigation';
import { distance } from './navigation';
import { Layer } from './protocol/layers';
import type { PlayerSession } from './protocol/session';
import type { Entity, Position, WorldView } from './protocol/world';
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
const kinds: [number, number][] = [
  [0x0eed, 0x0eed], // gold
  [0x0f0f, 0x0f30], // gems
  [0x0f7a, 0x0f91], // reagents
  [0x0e21, 0x0e21], // bandages
  [0x0f06, 0x0f0d], // potions
  [0x1f2d, 0x1f6c], // spell scrolls
  [0x0f3f, 0x0f3f], // arrows
  [0x1bfb, 0x1bfb], // bolts
  [0x1bf2, 0x1bf2], // ingots
  [0x19b7, 0x19ba], // ore
  [0x1bd7, 0x1bd7], // boards
  [0x1bdd, 0x1bdd], // logs
  [0x1766, 0x1767], // cloth and uncut cloth
  [0x1078, 0x1079], // hides
  [0x1081, 0x1081], // leather
  [0x0f95, 0x0f9c], // bolts of cloth
  // Things any shop buys back or a resident's work uses (ServUO SB* sell lists).
  [0x0e85, 0x0e86], // pickaxes
  [0x0f39, 0x0f3a], // shovels
  [0x0f43, 0x0f4a], // hatchets and axes
  [0x13fa, 0x13fb], // large battle axes
  [0x1022, 0x1023], // fletcher's tools
  [0x0e9b, 0x0e9b], // mortar and pestle
  [0x1eb8, 0x1ebc], // tinker's tools
  [0x0f9d, 0x0f9f], // sewing kit and scissors
  [0x0dbf, 0x0dc0], // fishing poles
  [0x0f0e, 0x0f0e], // empty bottles
  [0x1bd1, 0x1bd1], // feathers
  [0x1bd4, 0x1bd4], // shafts
  [0x0e9c, 0x0e9e], // drums and tambourines
  [0x0eb1, 0x0eb3], // harps and lutes
  [0x09cc, 0x09cf], // fish
  [0x0efa, 0x0efa], // spellbooks
  [0x1f14, 0x1f14] // recall runes
];
// Items this session could not reach or the server refused; never tried again.
const skipped = new WeakMap<PlayerSession, Set<number>>();
const ghosts = new Set([0x192, 0x193, 0x25f, 0x260]);

const worthwhile = (terrain: Terrain, item: Entity) =>
  kinds.some(([low, high]) => item.graphic >= low && item.graphic <= high) ||
  (terrain.tile(item.graphic, true).flags & WEARABLE) !== 0;

// One pickup if something worthwhile lies within reach. True when it acted.
export async function scavenge(ctx: ScavengeContext): Promise<boolean> {
  const { session, position } = ctx;
  const self = session.world.entities.get(ctx.serial);
  if (!self || ghosts.has(self.graphic)) return false;
  const status = ctx.status();
  if (status.weight >= status.maxWeight * 0.85) return false;
  const skip = skipped.get(session) ?? new Set<number>();
  skipped.set(session, skip);
  const here = position();
  const entities = [...session.world.entities.values()];
  // Never with a monster or aggressor close by.
  if (
    entities.some(
      (m) =>
        m.kind === 'mobile' &&
        [3, 4, 5, 6].includes(m.notoriety ?? 0) &&
        !!m.position &&
        distance(here, m.position) <= 8
    )
  )
    return false;
  const item = entities
    .filter(
      (e) =>
        e.kind === 'item' &&
        e.parent === undefined &&
        !!e.position &&
        ((e.flags ?? 0) & MOVABLE) !== 0 &&
        !skip.has(e.serial) &&
        distance(here, e.position) <= RANGE &&
        Math.abs(here.z - e.position.z) <= 10 &&
        worthwhile(ctx.terrain, e)
    )
    .sort((a, b) => distance(here, a.position ?? here) - distance(here, b.position ?? here))[0];
  if (!item?.position) return false;
  skip.add(item.serial);
  const name = ctx.terrain.tile(item.graphic, true).name || 'item';
  try {
    ctx.phase(
      'scavenge',
      `Picking up ${item.amount && item.amount > 1 ? `${item.amount} ` : ''}${name} lying at ${item.position.x},${item.position.y}`
    );
    await ctx.navigate(item.position, 1);
    await session.moveItem(item.serial, ctx.backpack());
    ctx.log(`Picked up ${name}`);
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
export async function pickUpInReach(session: PlayerSession, terrain: Terrain, log: (note: string) => void) {
  const serial = session.world.serial;
  const here = session.world.position;
  const status = session.world.status;
  if (serial === null || !here || !status || status.weight >= status.maxWeight * 0.85) return false;
  const self = session.world.entities.get(serial);
  if (!self || ghosts.has(self.graphic)) return false;
  const pack = session.world.childrenOf(serial).find((item) => item.layer === Layer.Backpack);
  if (!pack) return false;
  const skip = skipped.get(session) ?? new Set<number>();
  skipped.set(session, skip);
  let item: Entity | undefined;
  for (const e of session.world.entities.values()) {
    if (e.kind === 'mobile' && [3, 4, 5, 6].includes(e.notoriety ?? 0) && e.position && distance(here, e.position) <= 8)
      return false;
    if (
      !item &&
      e.kind === 'item' &&
      e.parent === undefined &&
      e.position &&
      ((e.flags ?? 0) & MOVABLE) !== 0 &&
      !skip.has(e.serial) &&
      distance(here, e.position) <= 2 &&
      Math.abs(here.z - e.position.z) <= 10 &&
      worthwhile(terrain, e)
    )
      item = e;
  }
  if (!item) return false;
  skip.add(item.serial);
  const name = terrain.tile(item.graphic, true).name || 'item';
  try {
    await session.moveItem(item.serial, pack.serial);
    log(`Picked up ${name} in passing`);
    return true;
  } catch {
    return false;
  }
}
