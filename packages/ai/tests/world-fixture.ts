import { type Areas, useAreas } from '../src/areas';
import type { Placement } from '../src/decoration';
import type { Link } from '../src/links';
import { useShardWorld } from '../src/shard-world';
import { parseSpawners, type Spawner, type Town } from '../src/spawns';
import { useWorkAreas } from '../src/work-areas';
import areas from './fixtures/areas.json';
import places from './fixtures/world-places.json';

// A small shard world for tests, read the way the service reads the shard's own at start
// (shard-world.ts): stock ServUO town regions, vendor, graveyard and inn spawners, forges, ankhs and
// teleporters (fixtures/world-places.json)
// and the walkable areas between them (fixtures/areas.json),
// graveyards, an ogre and troll ground, and weak creatures near Vesper.
const spawner = (name: string, x: number, y: number, max: number, objects: string) =>
  `<Points><Name>${name}</Name><Map>Trammel</Map><CentreX>${x}</CentreX><CentreY>${y}</CentreY>` +
  `<CentreZ>0</CentreZ><MaxCount>${max}</MaxCount><Objects2>${objects}</Objects2></Points>`;

export function useTestWorld() {
  useShardWorld({
    spawners: [
      // The fixture's own graveyards and grounds stand in for the stock ones.
      ...(places.spawners as unknown as Omit<Spawner, 'range'>[])
        .filter((s) => !s.name.startsWith('Graveyards#'))
        .map((s) => ({ range: 0, ...s })),
      ...parseSpawners(
        spawner('Graveyards#0', 1369, 1475, 9, 'Spectre:MX=2:OBJ=Wraith:MX=2:OBJ=Skeleton:MX=3:OBJ=Zombie:MX=4') +
          spawner('Graveyards#2', 2438, 1100, 6, 'Spectre:MX=1:OBJ=Shade:MX=1:OBJ=Wraith:MX=1:OBJ=Lich:MX=1') +
          spawner('Graveyards#4', 2758, 867, 9, 'Spectre:MX=2:OBJ=Wraith:MX=2:OBJ=Skeleton:MX=3:OBJ=Zombie:MX=4') +
          spawner('Graveyards#5', 722, 1119, 10, 'Skeleton:MX=10') +
          spawner('Graveyards#1', 1285, 3731, 9, 'Spectre:MX=2:OBJ=Wraith:MX=2:OBJ=Shade:MX=2:OBJ=Skeleton:MX=3') +
          spawner('Hills#1', 1010, 1210, 8, 'Ogre:MX=4:OBJ=Troll:MX=4') +
          spawner('Vesper#1', 2905, 815, 8, 'Mongbat:MX=4:OBJ=Rat:MX=4') +
          spawner('Haven#1', 3470, 2741, 39, 'Mongbat:MX=36:OBJ=Ettin:MX=3') +
          spawner('Trinsic#1', 1830, 2986, 8, 'Mongbat:MX=8') +
          spawner('Trinsic#2', 1900, 2700, 6, 'Horse:MX=3:OBJ=Llama:MX=3') +
          spawner('Britain#2', 1500, 1700, 6, 'Horse:MX=3:OBJ=Llama:MX=3')
      )
    ],
    regions: [],
    towns: places.towns as Town[],
    // Haven Island (Regions.xml NoHousingRegion) beside the towns.
    named: [
      ...(places.towns as Town[]),
      { name: 'Haven Island', rects: [{ x: 3314, y: 2345, width: 500, height: 750 }] }
    ],
    decoration: places.decoration as Placement[],
    teleporters: places.teleporters as Link[]
  });
  // Mines and woods as work-area-build.ts finds them on the stock map.
  useWorkAreas('mining', [
    { city: 'Minoc', x: 2582, y: 454, weight: 4 },
    { city: 'Cove', x: 2198, y: 1225, weight: 1, toolCity: 'Britain' },
    { city: 'New Haven', x: 3512, y: 2780, weight: 0 }
  ]);
  useWorkAreas('woods', [
    { city: 'Yew', x: 772, y: 1047, weight: 4 },
    { city: 'Britain', x: 1236, y: 1524, weight: 1 },
    { city: 'Minoc', x: 2340, y: 630, weight: 1 },
    { city: 'Vesper', x: 2796, y: 663, weight: 1 },
    { city: 'Moonglow', x: 4528, y: 1209, weight: 1 },
    { city: 'Skara Brae', x: 648, y: 2088, weight: 1 },
    { city: 'New Haven', x: 3572, y: 2538, weight: 0 }
  ]);
  // Built from the stock world by area-build.ts, as the service builds the shard's own.
  useAreas(areas as Areas, 'test');
}
