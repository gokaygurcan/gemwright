import type { PlayerSession } from '@gemwright/network/session';

import { ore } from './miner-dig';

export function minerInventory(session: PlayerSession, unsmeltable: Set<number>) {
  const carried = (backpack: number) => [...session.world.entities.values()].filter((item) => item.parent === backpack);
  const smeltable = (backpack: number) =>
    carried(backpack).filter(
      (item) =>
        ore.has(item.graphic) && !unsmeltable.has(item.serial) && !(item.graphic === 0x19b7 && (item.amount ?? 1) < 2)
    );
  const retainedOre = (backpack: number) => {
    const usable = new Set(smeltable(backpack).map((item) => item.serial));
    return carried(backpack).filter((item) => ore.has(item.graphic) && !usable.has(item.serial));
  };
  return { carried, smeltable, retainedOre };
}
