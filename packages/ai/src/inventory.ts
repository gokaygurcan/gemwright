import {
  bandage,
  fishingPoles,
  hatchets,
  healPotion,
  instruments,
  isDeathRobe,
  miningTools,
  reagents,
  sewingKit
} from '@gemwright/common/items';

import { openOwnBackpack } from './backpack';
import { chaosOf } from './chaos';
import type { PlayerSession } from './protocol/session';
import type { Entity } from './protocol/world';
import type { Terrain } from './terrain';

// How full a pack is, as ServUO counts it: a backpack holds 125 items in all, nested ones included
// (Container.DefaultMaxItems), and the character carries up to its maximum weight. A gatherer
// works until one of them is nearly reached; `FULL` leaves room for a last swing and a town trip.
export const ITEM_LIMIT = 125;
export const FULL = 0.92;

export function packItems(session: PlayerSession, pack: number): Entity[] {
  const inside = (container: number): Entity[] =>
    session.world.childrenOf(container).flatMap((item) => [item, ...inside(item.serial)]);
  return inside(pack);
}

export function packFull(session: PlayerSession, pack: number, ratio = FULL) {
  const status = session.world.status;
  return packItems(session, pack).length >= ITEM_LIMIT - 8 || (!!status && status.weight >= status.maxWeight * ratio);
}

// A gatherer sometimes stops before the pack is full (chaos.ts): each call, a chance of a tenth of
// the resident's chaos once the pack is at least half full. Most loads end full.
export function leavesEarly(session: PlayerSession) {
  const status = session.world.status;
  return !!status && status.weight >= status.maxWeight * 0.5 && Math.random() < chaosOf(session) / 10;
}

// Bags and pouches inside a pack (opened to see what they hold).
const containers = new Set([
  0x0e75, // backpack
  0x0e76, // bag
  0x0e79, // pouch
  0x09b0 // leather pouch
]);

// What a resident never drops to lighten its pack: its tools and supplies.
export const workGear = new Set<number>([
  ...instruments,
  ...hatchets,
  ...miningTools,
  ...fishingPoles,
  ...reagents,
  sewingKit,
  bandage,
  healPotion,
  0x0efa, // spellbook
  0x1022, // fletcher's tools
  0x1023, // fletcher's tools (alternate)
  0x0e9b, // mortar and pestle
  0x1eb8, // tinker's tools
  0x0f9f, // scissors
  0x1f14, // recall rune
  0x0f51, // dagger (carving fish), facing east
  0x0f52 // dagger (carving fish), facing south
]);

// Tools by kind: graphics of one tool (a hatchet's two facings) count together.
const toolKinds: number[][] = [
  [...hatchets],
  [...miningTools],
  [...fishingPoles],
  [...instruments],
  [sewingKit],
  [0x0f9e, 0x0f9f], // scissors
  [0x1022, 0x1023], // fletcher's tools
  [0x0e9b], // mortar and pestle
  [0x1eb8, 0x1ebc], // tinker's tools and tool kit
  [0x13e3, 0x13e4], // smith's hammer
  [0x0fbb, 0x0fbc], // tongs
  [0x1034, 0x1035, 0x1028, 0x1029] // saws
];
const toolGraphics = new Set(toolKinds.flat());
const toolGroup = (graphic: number) => toolKinds.findIndex((kind) => kind.includes(graphic));
// True when the pack already holds two tools of this one's kind: another would only be dropped.
export function enoughTools(session: PlayerSession, pack: number, graphic: number) {
  const kind = toolGroup(graphic);
  return kind >= 0 && packItems(session, pack).filter((item) => toolGroup(item.graphic) === kind).length >= 2;
}
// Backpacks found inside a backpack: what a dead pack animal leaves (its pack's contents).
const foreignBags = new Set([
  0x0e75, // backpack
  0x09b2 // backpack (alternate)
]);

// What no player carries: more than one spellbook, and any death robe beyond the one worn after a
// resurrection (the robe is newbied, so each death in it leaves the old one in the pack). That one
// comes off as soon as there is anything else to wear. Extras are dropped, where they decay.
// Called between tasks by every runner and after every resurrection.
const SPELLBOOK = 0x0efa;
const PLAIN_BOOKS = new Set([
  0x0fef, // brown book
  0x0ff0, // tan book
  0x0ff1, // red book
  0x0ff2 // blue book
]);
const opened = new WeakSet<PlayerSession>();
export async function tidyPack(
  session: PlayerSession,
  pack: number,
  log: (message: string) => void,
  terrain?: Terrain
) {
  // Contents are known only once the pack (and the bags in it) have been opened this session.
  if (!opened.has(session)) {
    opened.add(session);
    await openOwnBackpack(session).catch(() => {});
    for (const bag of packItems(session, pack).filter((item) => containers.has(item.graphic))) {
      session.use(bag.serial);
      await Bun.sleep(400);
    }
  }
  const items = packItems(session, pack);
  const worn = session.world.childrenOf(session.world.serial ?? -1);
  const books = items.filter((item) => item.graphic === SPELLBOOK);
  const spareBooks = worn.some((item) => item.graphic === SPELLBOOK) ? books : books.slice(1);
  const robes = items.filter(isDeathRobe);
  // What the server hands every new character and no player keeps: the candle (and any light
  // source, tiledata flag 0x800000) and the blank books. Spellbooks and runebooks stay.
  const junk = items.filter(
    (item) =>
      item.parent === pack &&
      (PLAIN_BOOKS.has(item.graphic) || (!!terrain && (terrain.tile(item.graphic, true).flags & 0x800000) !== 0))
  );
  // Tools: one or two of each kind is plenty, and a lost one is cheap to replace.
  const tools = new Map<number, Entity[]>();
  for (const item of items.filter((i) => toolGraphics.has(i.graphic) && i.parent === pack))
    tools.set(toolGroup(item.graphic), [...(tools.get(toolGroup(item.graphic)) ?? []), item]);
  const spareTools = [...tools.values()].flatMap((group) => group.slice(2));
  // A dead pack animal's pack (a backpack inside the backpack): its goods join the resident's own,
  // and the bag is dropped once empty.
  for (const bag of items.filter((i) => i.parent === pack && foreignBags.has(i.graphic))) {
    for (const item of session.world.childrenOf(bag.serial)) await session.moveItem(item.serial, pack).catch(() => {});
    if (!session.world.childrenOf(bag.serial).length) {
      await (await import('./overload')).putDown(session, bag.serial);
      log("Emptied a pack animal's pack into my own and dropped the bag");
    }
  }
  // Armour and weapons picked up on the way (pickUpInReach cannot stop to dress while walking).
  await (await import('./inventory-use')).useAcquiredItems(session).catch(() => false);
  // The worn robe goes too, the moment there is anything else to wear in its place.
  // Loaded on use: death-robe.ts reaches this module again through the vendor code.
  const { shedDeathRobe } = await import('./death-robe');
  if (terrain && (await shedDeathRobe(session, terrain, items))) log('Took off the death robe for my own clothes');
  if (!spareBooks.length && !robes.length && !spareTools.length && !junk.length) return;
  const { putDown, refusals } = await import('./overload');
  let kept = 0;
  for (const [n, item] of [...spareBooks, ...robes, ...spareTools, ...junk].entries()) {
    if (!(await putDown(session, item.serial, n))) {
      kept++;
      // A refused lift usually means the pack listing is stale: it is read afresh next time.
      opened.delete(session);
    }
    await Bun.sleep(300);
  }
  log(
    `Tidied my pack: dropped ${spareBooks.length} spare spellbooks, ${robes.length} old death robes, ${spareTools.length} spare tools and ${junk.length} candles and blank books${kept ? ` (${kept} would not drop: ${refusals.get(session)})` : ''}`
  );
}

// What fills a pack, for the log when a pack is full: the commonest kinds by count.
export function packSummary(session: PlayerSession, pack: number) {
  const kinds = new Map<number, number>();
  for (const item of packItems(session, pack)) kinds.set(item.graphic, (kinds.get(item.graphic) ?? 0) + 1);
  return [...kinds]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([graphic, n]) => `0x${graphic.toString(16)} x${n}`)
    .join(', ');
}
