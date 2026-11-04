import { expect, test } from 'bun:test';

import { type Areas, useAreas } from '../src/areas';
import { routeOut } from '../src/dungeon-exit';
import { parseTeleporters } from '../src/links';
import { useTestWorld } from './world-fixture';

test('from a lower level the way out goes up level by level, never deeper, then to the open world', () => {
  // New Haven's mine (3508,2777 <-> 5912,355) with a lower level reached from 5831,323.
  const links = parseTeleporters(
    '3508,2777,26,Trammel,5912,355,0,Trammel,True\n5831,323,0,Trammel,5849,239,0,Trammel,True\n5800,200,0,Trammel,5700,100,0,Trammel,False\n'
  );
  const point = (x: number, y: number, section: number) => ({ x, y, kind: 'teleporter', area: 0, section });
  useAreas(
    {
      areas: [{ id: 0, gates: [] }],
      points: [
        point(3508, 2777, 0),
        point(5912, 355, 1),
        point(5831, 323, 1),
        point(5849, 239, 2),
        point(5800, 200, 2),
        point(5700, 100, 3)
      ]
    } as Areas,
    'dungeon-exit-test'
  );
  const route = routeOut(2, links);
  expect(route?.map((link) => `${link.from.x},${link.from.y}>${link.to.x},${link.to.y}`)).toEqual([
    '5849,239>5831,323',
    '5912,355>3508,2777'
  ]);
  useTestWorld();
});
