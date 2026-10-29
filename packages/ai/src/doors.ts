import type { PlayerSession } from '@gemwright/network/session';
import type { Entity } from '@gemwright/network/world-types';

import type { Point, Terrain } from './terrain';

// ServUO Doors.cs, SecretDoors.cs, SlidingDoors.cs and BaseHouse.AddDoor.
const pairs = new Map<number, 'closed' | 'open'>();
function family(first: number, count: number) {
  for (let i = 0; i < count; i++) {
    pairs.set(first + i * 2, 'closed');
    pairs.set(first + i * 2 + 1, 'open');
  }
}
for (const first of [
  0xe8, // SecretStoneDoor1
  0x314, // SecretDungeonDoor
  0x324, // SecretStoneDoor2; craftable stone house doors
  0x334, // SecretWoodenDoor
  0x344, // SecretLightWoodDoor
  0x354, // SecretStoneDoor3
  0x675, // MetalDoor; metal house doors
  0x685, // BarredMetalDoor; Wrong dungeon doors
  0x695, // RattanDoor
  0x6a5, // DarkWoodDoor; dark wood house doors
  0x6b5, // MediumWoodDoor
  0x6c5, // MetalDoor2; Experimental Room doors
  0x6d5, // LightWoodDoor
  0x6e5, // StrongWoodDoor
  0x824, // IronGate
  0x839, // LightWoodGate; New Haven double gate
  0x84c, // IronGateShort
  0x866, // DarkWoodGate
  0x1fed, // BarredMetalDoor2
  0x367b, // GenericHouseDoor, first expansion set
  0x368b, // GenericHouseDoor, second expansion set
  0x9ad7, // Metal house doors, first modern set
  0x9b3c // Metal house doors, second modern set
])
  family(first, 8);
for (const first of [
  0x2a05, // PaperSlidingDoor
  0x2a0d, // ClothSlidingDoor
  0x2a15, // WoodenSlidingDoor
  0x409b, // Gargoyle wallset 3 doors
  0x410c, // Gargoyle doors
  0x41c2, // Gargoyle wallset 2 doors
  0x41cf, // Gargoyle wallset 1 doors
  0x46dd, // Ruin doors
  0x4d22, // Queen doors
  0x50c8, // GenericHouseDoor, first 0x50c8 set
  0x50d0, // GenericHouseDoor, second 0x50d0 set
  0x5142 // GenericHouseDoor, 0x5142 set
])
  family(first, 4);
family(0x2d63, 7); // Simple house doors
family(0x319c, 10); // House doors with alternate facings, including 0x31ae
family(0x436e, 8); // House doors with irregular facing order
for (const first of [
  0x241f, // Special north-facing house door
  0x2423, // Special west-facing house door
  0x2d46, // Wooden house door, north-facing
  0x2d48, // Wooden house door, south-facing
  0x2fe2, // Moon door, south-facing
  0x2fe4, // Moon door, west-facing
  0x3c9 // SecretStoneWallNS
])
  family(first, 1);
pairs.set(0x363a, 'closed'); // SecretShadowWallNS
pairs.set(0x3619, 'open'); // SecretShadowWallNS, opened
pairs.set(0x242, 'closed'); // SecretDungeonWallNS
pairs.set(0x244, 'open'); // SecretDungeonWallNS, opened

export function isDoor(graphic: number, terrain: Pick<Terrain, 'tile'>): boolean {
  return (
    pairs.has(graphic) ||
    graphic === 0x6f5 || // PortcullisNS
    graphic === 0x6f6 || // PortcullisEW
    graphic === 0x4780 || // TombOfKingsSecretDoor
    !!(terrain.tile(graphic, true).flags & 0x20000000)
  );
}

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
      } else if ([0x363a, 0x242, 0x3c9].includes(graphic)) {
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
