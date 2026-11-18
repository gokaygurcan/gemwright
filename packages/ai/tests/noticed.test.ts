import { expect, test } from 'bun:test';

import { Mind } from '../src/mind';
import { traitsOf } from '../src/traits';

// What makes it think again in the middle of a plan: only what changes its plan's worth. A vendor or a
// passer-by coming into view tells it nothing it did not know; a creature, a blow, its own things do.
test('only what matters to a plan in progress is noticed', () => {
  const mind = new Mind('r', () => {}, traitsOf([], () => 0.5).traits);
  const where = { x: 100, y: 100, z: 0, map: 1 };
  const event = (kind: string, data: object) => mind.observe({ resident: 'r', at: 1, kind, data, where });
  event('awake', { serial: 1, self: { health: { current: 50, max: 50 } }, skills: {} });
  event('revealed', { serial: 2, graphic: 3701, layer: 21, parent: 1, is: ['Backpack'] });
  const noticed = () => mind.noticed;

  let before = noticed();
  event('seen', { serial: 20, kind: 'mobile', graphic: 400, x: 105, y: 100, is: ['Person'] });
  event('gone', { serial: 20 });
  event('seen', { serial: 21, graphic: 3617, x: 103, y: 100, is: ['Bandage'] });
  event('self', { mana: { current: 10, max: 20 } });
  event('self', { health: { current: 50, max: 50 } });
  event('seen', { serial: 22, kind: 'mobile', graphic: 204, notoriety: 1, x: 106, y: 100, is: ['Horse'] });
  event('gone', { serial: 22 });
  expect(noticed()).toBe(before);
  const town = { map: 1, kind: 'town', guarded: true, land: 5 };
  event('place', { ...town, regions: ['New Haven'] });
  before = noticed();
  event('place', { ...town, regions: ["Gorge's Shop", 'New Haven'] });
  expect(noticed()).toBe(before);

  for (const [kind, data] of [
    ['seen', { serial: 30, kind: 'mobile', graphic: 39, x: 105, y: 100, is: ['Mongbat'] }],
    ['animated', { serial: 30, type: 0, action: 0 }],
    ['animated', { serial: 30, type: null, action: 16 }],
    ['gained', { serial: 7, graphic: 7154, amount: 3, parent: 2, is: ['IronIngot'] }],
    ['lost', { serial: 7 }],
    ['self', { health: { current: 40, max: 50 } }],
    ['gone', { serial: 30 }],
    ['place', { map: 1, kind: 'wild', guarded: false, land: 5, regions: [] }]
  ] as const) {
    before = noticed();
    event(kind, data);
    expect([kind, noticed() > before]).toEqual([kind, true]);
  }
});
