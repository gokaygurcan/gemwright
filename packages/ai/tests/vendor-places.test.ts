import { expect, test } from 'bun:test';

import { serviceLocations, useShardVendors } from '../src/locations';
import { parseSpawners } from '../src/spawns';
import { useTestWorld } from './world-fixture';

const point = (name: string, x: number, y: number, range: number, objects: string) =>
  `<Points><Name>${name}</Name><Map>Trammel</Map><CentreX>${x}</CentreX><CentreY>${y}</CentreY><CentreZ>0</CentreZ><Range>${range}</Range><MaxCount>1</MaxCount><Objects2>${objects}</Objects2></Points>`;

test('a healer place is where a healer stays, not a wildlife spawner it roams from', () => {
  useTestWorld();
  useShardVendors(
    parseSpawners(
      point('Britain healer', 1480, 1610, 0, 'Healer:MX=1') +
        point('WildLife#1', 1500, 1650, 50, 'Sheep:MX=7:OBJ=WanderingHealer:MX=1')
    )
  );
  expect(serviceLocations('Britain', 'healer').map((p) => `${p.x},${p.y}`)).toEqual(['1480,1610']);
  useTestWorld();
});
