import { packItems } from './inventory';
import type { PlayerSession } from './protocol/session';

// A bank box holds 125 items, nested ones included; a full one refuses every deposit (residents
// then stood at the bank retrying). Past 110, the oldest kept pieces (exceptional smithing, spare
// gear: anything but gold, ingots and ore) come back out to be sold, as a player clears a box.
const ROOM = 110;
const staples = new Set([
  0x0eed, // gold coins
  0x1bf2, // ingots
  0x19b7, // ore, the smallest pile
  0x19b8, // ore
  0x19b9, // ore, the largest pile
  0x19ba // ore
]);

// Pieces (anything but the staples) last seen in each resident's bank box: a crafter keeps a new
// exceptional piece only while fewer than five are stored (miner-crafting.ts).
const pieces = new WeakMap<PlayerSession, number>();
export const storedPieces = (session: PlayerSession) => pieces.get(session) ?? 0;

export async function clearBankRoom(session: PlayerSession, box: number, backpack: number, keep: number[] = []) {
  const stored = packItems(session, box);
  pieces.set(session, session.world.childrenOf(box).filter((item) => !staples.has(item.graphic)).length);
  if (stored.length < ROOM) return [];
  const spare = session.world
    .childrenOf(box)
    .filter((item) => !staples.has(item.graphic) && !session.world.childrenOf(item.serial).length)
    .slice(0, stored.length - ROOM + 10);
  const taken: number[] = [];
  // As many as the pack can carry (a lift the character cannot carry is refused).
  for (const item of spare) {
    const status = session.world.status;
    if (!status || status.maxWeight - status.weight < 15) break;
    const moved = await session.moveItem(item.serial, backpack).then(
      () => true,
      () => false
    );
    if (!moved) break;
    taken.push(item.serial);
    await Bun.sleep(600);
  }
  keep.splice(0, keep.length, ...keep.filter((serial) => !taken.includes(serial)));
  return taken;
}
