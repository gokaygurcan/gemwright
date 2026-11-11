import { TileFlag } from '@gemwright/common/assets/tiledata';
import { isDeathRobe } from '@gemwright/common/game/items';
import { CommandRejected } from '@gemwright/network/errors';
import { Layer } from '@gemwright/network/layers';
import type { PlayerSession } from '@gemwright/network/session';

import type { Terrain } from '../terrain';

// Layers not dressed from the pack: the hands (what it holds is chosen for what it does), and the
// pack, hair, beard, mount and bank, which are not clothes.
const undressed: ReadonlySet<number> = new Set([
  Layer.OneHanded,
  Layer.TwoHanded,
  Layer.Backpack,
  Layer.Hair,
  Layer.FacialHair,
  Layer.Mount,
  Layer.Bank
]);

// Wearing the best it has: for each place on its body, the piece it carries worth the most, put on
// in place of what it wears there if that is worth less. The white robe the shard puts on a ghost
// it raises (ServUO DeathRobe) is worth nothing to it: its own robe goes back on, and the death robe
// is dropped. A piece the shard refuses (too heavy for its strength) is not tried again. True when it
// changed anything.
export async function dress(
  session: PlayerSession,
  terrain: Terrain,
  worth: (serial: number) => number,
  // What the shard refused: a piece to wear (anywhere), or a death robe's drop (on that tile).
  refused: Map<number, string>
) {
  const world = session.world;
  const self = world.serial;
  const pack = [...world.entities.values()].find((e) => e.parent === self && e.layer === Layer.Backpack);
  if (self === null || !pack) return false;
  const value = (serial: number) => {
    const item = world.entities.get(serial);
    return item && isDeathRobe(item) ? -1 : worth(serial);
  };
  let changed = false;
  for (const item of [...world.entities.values()].filter((e) => e.parent === pack.serial && !refused.has(e.serial))) {
    const tile = terrain.tile(item.graphic, true);
    if (!(tile.flags & TileFlag.Wearable) || !tile.layer || undressed.has(tile.layer) || isDeathRobe(item)) continue;
    const worn = [...world.entities.values()].find((e) => e.parent === self && e.layer === tile.layer);
    if (worn && value(worn.serial) >= value(item.serial)) continue;
    if (worn) await session.moveItem(worn.serial, pack.serial);
    await session.equipItem(item.serial, tile.layer);
    for (const end = Date.now() + 1500; Date.now() < end && world.entities.get(item.serial)?.parent !== self; )
      await Bun.sleep(100);
    if (world.entities.get(item.serial)?.parent !== self) refused.set(item.serial, '');
    changed = true;
  }
  // A death robe no longer worn is left behind (it decays where it lies).
  // Refused on one tile, it carries on and tries again from the next tile it stands on.
  const here = world.position ? `${world.position.x},${world.position.y}` : '';
  const robe = [...world.entities.values()].find(
    (e) => e.parent === pack.serial && isDeathRobe(e) && refused.get(e.serial) !== here
  );
  if (robe) {
    refused.set(robe.serial, here);
    // On its own tile at the height the shard has for it (the client's own height can drift).
    await session.resyncPosition();
    try {
      await session.dropAtFeet(robe.serial);
    } catch (error) {
      // Refused all the same: the shard's answer, and the robe stays in the pack.
      if (!(error instanceof CommandRejected)) throw error;
      return true;
    }
    refused.delete(robe.serial);
    changed = true;
  }
  return changed;
}
