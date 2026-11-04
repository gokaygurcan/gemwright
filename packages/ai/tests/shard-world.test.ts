import { expect, test } from 'bun:test';

import { havenFromSpawners } from '../src/haven-spawns';
import { allServiceLocations, useShardVendors, useTowns, vendorLocations } from '../src/locations';
import { parseSpawners } from '../src/spawns';

const spawner = (name: string, x: number, y: number, objects: string) =>
  `<Points><Name>${name}</Name><Map>Trammel</Map><CentreX>${x}</CentreX><CentreY>${y}</CentreY><CentreZ>0</CentreZ>` +
  `<MaxCount>5</MaxCount><Objects2>${objects}</Objects2></Points>`;

test("a town's vendors stand where the shard's vendor spawners are, not where a stock catalogue put them", () => {
  useTowns([{ name: 'Britain', rects: [{ x: 1380, y: 1500, width: 200, height: 300 }] }]);
  useShardVendors(
    parseSpawners(
      spawner('Britain#1', 1430, 1690, 'Banker:MX=1:SB=0:OBJ=Minter:MX=1') +
        spawner('Wilds#1', 3000, 200, 'WanderingHealer:MX=1')
    )
  );
  expect(vendorLocations('Britain', 'banker')).toEqual([{ x: 1430, y: 1690, z: 0 }]);
  expect(allServiceLocations('healer')).toEqual([]);
});

test("Haven Island's monster grounds come from the shard's spawners on the island", () => {
  const island = { x0: 3300, y0: 2300, x1: 3800, y1: 2800 };
  const town = { x0: 3400, y0: 2500, x1: 3550, y1: 2650 };
  const { grounds } = havenFromSpawners(
    parseSpawners(
      spawner('Haven#1', 3500, 2550, 'Banker:MX=1') +
        spawner('Haven#2', 3470, 2741, 'Mongbat:MX=4:OBJ=Ettin:MX=1') +
        spawner('Britain#1', 1430, 1690, 'Banker:MX=1')
    ),
    island,
    town
  );
  expect(grounds.map((g) => g.creatures)).toEqual([{ Mongbat: 4, Ettin: 1 }]);
});
