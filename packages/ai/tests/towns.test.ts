import { expect, test } from 'bun:test';

import { HAVEN_CITY } from '../src/haven';
import { allServiceLocations } from '../src/locations';
import { failObjective } from '../src/objective-memory';
import { townFor } from '../src/towns';
import { behaviorFixture } from './behavior-fixture';

test('a resident works from the town it stands in while that supports its trade, else the nearest that does', () => {
  const f = behaviorFixture('fisherman');
  Object.assign(f.template, { creation: { city: 'Vesper' } });
  f.world.position = { x: 1436, y: 1699, z: 0, direction: 2 };
  expect(townFor(f.session, f.checkpoint, 'fisher')).toBe('britain');
  // Yew: no bank and no fisherman in the catalogue. Through Yew's moongate, Skara Brae's bank is a
  // short walk from its gate and Britain's a long one, so Skara Brae — not its creation city.
  f.world.position = { x: 545, y: 990, z: 0, direction: 2 };
  expect(townFor(f.session, f.checkpoint, 'fisher')).toBe('skara brae');
});

test('with no town that supports its trade, a resident outside any town falls back to the haven, not to no town', () => {
  const f = behaviorFixture('fisherman');
  f.world.position = { x: 200, y: 200, z: 0, direction: 2 };
  for (const shop of allServiceLocations('fisherman'))
    failObjective(f.checkpoint, `vendor-absent:${f.world.map}:fisherman:${shop.x},${shop.y}`, 'absent', 'gone');
  expect(townFor(f.session, f.checkpoint, 'fisher')).toBe(HAVEN_CITY.toLowerCase());
});
