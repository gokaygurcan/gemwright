import { packItems } from './inventory';
import type { PlayerSession } from './protocol/session';
import type { Entity } from './protocol/world';

// Over its maximum weight a character cannot walk (ServUO WeightOverloading). Like a player, it
// puts down what is cheapest for its weight (ore and logs before finished goods, never gold, tools
// or worn things) until it can walk, remembers the pile, and comes back for it once it has room
// (after selling): items on the ground decay after about an hour.
const DECAY_MS = 50 * 60_000;
// Cheap and heavy, put down first: ore (12 stones a piece), logs, boards, hides, ingots, sand.
const heavyFirst = [
  [0x19b7, 0x19b8, 0x19b9, 0x19ba], // ore
  [0x1bdd, 0x1be0], // logs
  [0x1bd7, 0x1bd8], // boards
  [0x1078, 0x1079], // hides
  [0x1bf2], // ingots
  [0x11ea, 0x11eb] // sand
];
const rank = (graphic: number) => {
  const tier = heavyFirst.findIndex((kind) => kind.includes(graphic));
  return tier < 0 ? heavyFirst.length : tier;
};
const spots = [-1, 0, 1].flatMap((x) => [-1, 0, 1].map((y) => ({ x, y })));
const containers = new Set([0x0e75, 0x0e76, 0x0e79, 0x09b0, 0x0eed]);

// Puts one item down at its feet or on a tile around it (one tile fills up after a few piles,
// Item.FindDropPoint). True when it left the pack; a pile merged into a like pile counts too.
// Why the last put-down failed, for the log.
export const refusals = new WeakMap<PlayerSession, string>();
export async function putDown(session: PlayerSession, serial: number, turn = 0): Promise<boolean> {
  for (let n = 0; n < 3; n++) {
    const before = session.world.status?.weight ?? 0;
    const spot = spots[(turn + n * 4) % spots.length] ?? { x: 0, y: 0 };
    try {
      await session.dropAtFeet(serial, spot);
      return true;
    } catch (error) {
      refusals.set(session, error instanceof Error ? error.message : String(error));
      await session.refreshStatus().catch(() => {});
      if ((session.world.status?.weight ?? before) < before) return true;
    }
  }
  return false;
}

interface Pile {
  map: number | null;
  x: number;
  y: number;
  serials: number[];
  at: number;
}
// By character serial, so a pile survives a relog of the same process.
const piles = new Map<number, Pile>();

const over = (session: PlayerSession) =>
  !!session.world.status && session.world.status.weight > session.world.status.maxWeight;

export async function lighten(
  session: PlayerSession,
  pack: number,
  keep: (item: Entity) => boolean,
  log: (message: string) => void
): Promise<boolean> {
  if (!over(session)) return false;
  const { openOwnBackpack } = await import('./backpack');
  await openOwnBackpack(session).catch(() => {});
  for (const bag of packItems(session, pack).filter((item) => containers.has(item.graphic))) {
    session.use(bag.serial);
    await Bun.sleep(400);
  }
  const failed = new Set<number>();
  const dropped: number[] = [];
  for (let n = 0; n < 60 && over(session); n++) {
    // Cheapest for its weight first, then the commonest goods; a bag itself is never dropped.
    const item = packItems(session, pack)
      .filter(
        (i) =>
          !keep(i) && !failed.has(i.serial) && !containers.has(i.graphic) && !session.world.childrenOf(i.serial).length
      )
      .map((i) => ({
        i,
        rank: rank(i.graphic),
        common: packItems(session, pack).filter((o) => o.graphic === i.graphic).length
      }))
      .sort((a, b) => a.rank - b.rank || b.common - a.common)[0]?.i;
    if (!item) break;
    if (await putDown(session, item.serial, n)) dropped.push(item.serial);
    else failed.add(item.serial);
    await Bun.sleep(400);
    await session.refreshStatus().catch(() => {});
  }
  const at = session.world.position;
  const me = session.world.serial;
  if (dropped.length && at && me !== null) {
    const old = piles.get(me);
    const near = old && old.map === session.world.map && Math.max(Math.abs(old.x - at.x), Math.abs(old.y - at.y)) <= 2;
    piles.set(me, {
      map: session.world.map,
      x: at.x,
      y: at.y,
      serials: [...(near ? old.serials : []), ...dropped],
      at: Date.now()
    });
  }
  const status = session.world.status;
  log(
    `Too heavy to walk; put down ${dropped.length} items to come back for` +
      (failed.size ? ` (${failed.size} would not drop)` : '') +
      (status ? `; now ${status.weight}/${status.maxWeight} stones` : '')
  );
  return true;
}

// Goes back for what it put down, once it has room, and picks up what still fits. True when it went.
export async function recoverPile(
  session: PlayerSession,
  pack: number,
  navigate: (to: { x: number; y: number }, range: number) => Promise<unknown>,
  log: (message: string) => void
): Promise<boolean> {
  const me = session.world.serial;
  const pile = me === null ? undefined : piles.get(me);
  const status = session.world.status;
  if (!pile || me === null || !status) return false;
  if (Date.now() - pile.at > DECAY_MS || pile.map !== session.world.map) {
    piles.delete(me);
    return false;
  }
  if (status.weight > status.maxWeight * 0.7) return false;
  await navigate(pile, 1).catch(() => {});
  let taken = 0;
  const left: number[] = [];
  for (const serial of pile.serials) {
    const item = session.world.entities.get(serial);
    if (!item?.position || item.parent !== undefined) continue;
    const now = session.world.status;
    if (now && now.weight >= now.maxWeight * 0.9) {
      left.push(serial);
      continue;
    }
    await session.moveItem(serial, pack).then(
      () => taken++,
      () => {}
    );
    await session.refreshStatus().catch(() => {});
  }
  if (left.length) piles.set(me, { ...pile, serials: left });
  else piles.delete(me);
  log(`Picked up ${taken} items I had put down${left.length ? `; ${left.length} still there` : ''}`);
  return true;
}
