import { expect, test } from 'bun:test';

import { Mind } from '../src/v2/mind';
import { traitsOf } from '../src/v2/traits';

test('it knows what it wears, carries, banks, and what lies about and in corpses', () => {
  const mind = new Mind('r', () => {}, traitsOf([], () => 0.5).traits);
  const where = { x: 100, y: 100, z: 0, map: 1 };
  const event = (kind: string, data: object) => mind.observe({ resident: 'r', at: 1, kind, data, where });
  event('awake', { serial: 1, self: {}, skills: {} });
  event('revealed', { serial: 2, graphic: 3701, layer: 21, parent: 1, is: ['Backpack'] });
  event('revealed', { serial: 3, graphic: 3700, layer: 29, parent: 1, is: ['BankBox'] });
  event('revealed', { serial: 4, graphic: 5049, layer: 2, parent: 1, is: ['Longsword'] });
  event('revealed', { serial: 5, graphic: 3702, parent: 2, is: ['Bag'] });
  event('revealed', { serial: 6, graphic: 3821, amount: 50, parent: 5, is: ['Gold'] });
  event('revealed', { serial: 7, graphic: 7154, amount: 300, parent: 3, is: ['IronIngot'] });
  event('seen', { serial: 8, graphic: 3617, amount: 10, x: 103, y: 100, z: 0, flags: 0x20, is: ['Bandage'] });
  event('seen', { serial: 9, graphic: 3617, x: 160, y: 100, z: 0, flags: 0x20, is: ['Bandage'] });
  event('seen', { serial: 10, kind: 'mobile', graphic: 50, x: 104, y: 100, z: 0, is: ['Skeleton'] });
  event('death', { serial: 10, corpse: 11 });
  event('seen', { serial: 11, graphic: 8198, x: 104, y: 100, z: 0, is: ['Corpse'] });
  event('seen', { serial: 12, graphic: 3821, amount: 20, parent: 11, is: ['Gold'] });

  const has = mind.has();
  expect(has.worn.map((i) => [i.name, i.layer, i.kind])).toEqual([['Longsword', 2, 'weapon']]);
  expect(has.pack.map((i) => [i.name, i.amount, i.kind])).toEqual([
    ['Bag', 1, 'container'],
    ['Gold', 50, 'gold']
  ]);
  expect(has.bank.map((i) => [i.name, i.amount, i.kind])).toEqual([['IronIngot', 300, 'resource']]);
  expect(has.ground.map((i) => [i.name, i.amount, i.kind])).toEqual([['Bandage', 10, 'bandage']]);
  expect(has.corpses).toMatchObject([
    { serial: 11, name: 'Corpse of Skeleton', items: [{ name: 'Gold', amount: 20 }] }
  ]);
});

// What it has is known again only when something changed: asked twice with nothing in between, the
// same answer; anything gained, lost or moved shows in the very next answer.
test('what it has is rebuilt only on a change, and every change shows at once', () => {
  const mind = new Mind('r', () => {}, traitsOf([], () => 0.5).traits);
  const where = { x: 100, y: 100, z: 0, map: 1 };
  const event = (kind: string, data: object) => mind.observe({ resident: 'r', at: 1, kind, data, where });
  event('awake', { serial: 1, self: {}, skills: {} });
  event('revealed', { serial: 2, graphic: 3701, layer: 21, parent: 1, is: ['Backpack'] });
  event('revealed', { serial: 6, graphic: 3821, amount: 50, parent: 2, is: ['Gold'] });
  const first = mind.has();
  expect(mind.has()).toBe(first);
  event('gained', { serial: 7, graphic: 7154, amount: 3, parent: 2, is: ['IronIngot'] });
  expect(mind.has().pack.map((i) => [i.name, i.amount])).toEqual([
    ['Gold', 50],
    ['IronIngot', 3]
  ]);
  event('lost', { serial: 6 });
  expect(mind.has().pack.map((i) => i.name)).toEqual(['IronIngot']);
});

// A container's contents arriving (its bank box opened, a trade window) are known at the next ask.
test('contents listed by the shard show at once', () => {
  const mind = new Mind('r', () => {}, traitsOf([], () => 0.5).traits);
  const where = { x: 100, y: 100, z: 0, map: 1 };
  const event = (kind: string, data: object) => mind.observe({ resident: 'r', at: 1, kind, data, where });
  event('awake', { serial: 1, self: {}, skills: {} });
  event('revealed', { serial: 3, graphic: 3700, layer: 29, parent: 1, is: ['BankBox'] });
  expect(mind.has().bank).toEqual([]);
  event('revealed', { serial: 7, graphic: 7154, amount: 300, parent: 3, is: ['IronIngot'] });
  event('listed', { serial: 3, contents: [7] });
  expect(mind.has().bank.map((i) => [i.name, i.amount])).toEqual([['IronIngot', 300]]);
});
