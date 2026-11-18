import { doorGraphics, graphicsOf, kindsOf } from '@gemwright/common/game/rules';
import type { PlayerSession } from '@gemwright/network/session';
import type { Entity } from '@gemwright/network/world-types';

import type { Point, Terrain } from './terrain';

const pairs = new Map<number, 'closed' | 'open'>();
for (const [closed, open] of doorGraphics) {
  pairs.set(closed, 'closed');
  if (open !== closed) pairs.set(open, 'open');
}

// Secret walls that slide aside (ServUO BaseSliding), by their closed graphic.
const slidingWalls = new Set(kindsOf('BaseSliding').flatMap((type) => graphicsOf(type).slice(0, 1)));

export function isDoor(graphic: number, terrain: Pick<Terrain, 'tile'>): boolean {
  return pairs.has(graphic) || !!(terrain.tile(graphic, true).flags & 0x20000000);
}

export const isOpenDoor = (graphic: number) => pairs.get(graphic) === 'open';

function overlaps(entity: Entity, from: Point, to: Point) {
  const at = entity.position;
  if (!at || at.z >= Math.max(from.z, to.z) + 16 || at.z + 20 <= Math.min(from.z, to.z)) return false;
  // Diagonal movement also checks both orthogonal corners.
  return (
    (at.x === to.x && at.y === to.y) ||
    (from.x !== to.x && from.y !== to.y && ((at.x === from.x && at.y === to.y) || (at.x === to.x && at.y === from.y)))
  );
}

export function createDoorOpener(
  session: PlayerSession,
  terrain: Terrain,
  check: () => void,
  log: (note: string) => void
) {
  const attempts = new Map<number, { at: number; count: number }>();
  return async (from: Point, to: Point): Promise<{ blocked: boolean; locked: boolean }> => {
    const doors = [...session.world.entities.values()].filter(
      (entity) => entity.kind === 'item' && overlaps(entity, from, to) && isDoor(entity.graphic, terrain)
    );
    let blocked = false;
    let locked = false;
    for (const candidate of doors) {
      check();
      // Opening one leaf can open its linked partner too. Re-read each entity before using it.
      const door = session.world.entities.get(candidate.serial);
      if (!door?.position || !overlaps(door, from, to) || pairs.get(door.graphic) === 'open') continue;
      const previous = attempts.get(door.serial);
      const count = previous && Date.now() - previous.at < 5000 ? previous.count : 0;
      if (count >= 2) {
        blocked = true;
        continue;
      }
      attempts.set(door.serial, { at: Date.now(), count: count + 1 });
      const graphic = door.graphic;
      const at = { ...door.position };
      const journal = new Set(session.world.journal);
      const denial = () =>
        session.world.journal.find(
          (entry) =>
            !journal.has(entry) && [502503, 1061637, 1060014, 1113410, 1113411, 1157017].includes(entry.cliloc ?? 0)
        );
      const changed = () => {
        const now = session.world.entities.get(door.serial);
        return (
          !now ||
          now.graphic !== graphic ||
          !now.position ||
          now.position.x !== at.x ||
          now.position.y !== at.y ||
          now.position.z !== at.z
        );
      };
      log(
        `Opening ${terrain.tile(graphic, true).name || 'door'} 0x${graphic.toString(16)} (${door.serial}) at ${at.x},${at.y},${at.z}`
      );
      session.use(door.serial);
      // The shard toggles a door without sending its new state to the user (the classic client
      // predicts it), so an open is assumed unless the journal refuses it.
      const until = Date.now() + 350;
      while (!denial() && !changed() && Date.now() < until) {
        check();
        await Bun.sleep(50);
      }
      const refused = denial();
      if (refused) {
        blocked = true;
        locked = true;
        log(`Door ${door.serial} refused access (${refused.cliloc}); avoiding this step`);
      } else if (slidingWalls.has(graphic)) {
        // BaseSliding changes art immediately, then lowers the wall after 1.6 seconds.
        const until = Date.now() + 1800;
        while (
          overlaps(session.world.entities.get(door.serial) ?? { ...door, position: undefined }, from, to) &&
          Date.now() < until
        ) {
          check();
          await Bun.sleep(50);
        }
      }
    }
    return { blocked, locked };
  };
}

export async function openNearbyDoors(
  session: PlayerSession,
  terrain: Terrain,
  from: Point,
  open: ReturnType<typeof createDoorOpener>
): Promise<boolean> {
  let changed = false;
  for (const door of [...session.world.entities.values()]) {
    const at = door.position;
    if (
      door.kind !== 'item' ||
      !at ||
      Math.max(Math.abs(at.x - from.x), Math.abs(at.y - from.y)) > 1 ||
      Math.abs(at.z - from.z) >= 16 ||
      !isDoor(door.graphic, terrain) ||
      pairs.get(door.graphic) === 'open'
    )
      continue;
    const before = `${door.graphic}:${at.x},${at.y},${at.z}`;
    await open(from, at);
    const after = session.world.entities.get(door.serial);
    changed ||=
      !after?.position || `${after.graphic}:${after.position.x},${after.position.y},${after.position.z}` !== before;
  }
  return changed;
}
