import { expect, test } from 'bun:test';

import { encounterTarget } from '../src/encounter-target';
import type { Entity } from '../src/protocol/world';
import { WorldView } from '../src/protocol/world';

const mobile = (serial: number, x: number): Entity => ({
  serial,
  kind: 'mobile',
  graphic: 3,
  hits: 100,
  maxHits: 100,
  position: { x, y: 0, z: 0, direction: 0 }
});
const current = mobile(2, 8),
  additional = mobile(3, 1);
const base = () => ({
  current,
  self: 1,
  allies: new Set<number>(),
  entities: [current, additional],
  swings: new Map([[2, { target: 1, at: 1000 }]]),
  origin: { x: 0, y: 0 },
  committedUntil: 0,
  eligible: () => true,
  now: 2000
});

test('duels and unrelated nearby creatures keep the original target', () => {
  expect(encounterTarget(base()).target.serial).toBe(2);
  const options = base();
  options.swings.set(3, { target: 99, at: 1000 });
  expect(encounterTarget(options).target.serial).toBe(2);
});

test('only a fresh confirmed additional attacker can justify a change, with commitment and finishing protection', () => {
  const options = base();
  options.swings.set(3, { target: 1, at: 1000 });
  expect(encounterTarget(options).target.serial).toBe(3);
  expect(encounterTarget({ ...options, committedUntil: 3000 }).target.serial).toBe(2);
  expect(encounterTarget({ ...options, current: { ...current, hits: 10 } }).target.serial).toBe(2);
  expect(encounterTarget({ ...options, now: 10000 }).target.serial).toBe(2);
  expect(encounterTarget({ ...options, eligible: () => false }).target.serial).toBe(2);
});

test('confirmed attackers exceeding nearby support call for disengagement', () => {
  const options = base();
  const third = mobile(4, 3);
  options.entities.push(third);
  options.swings.set(3, { target: 1, at: 1000 });
  options.swings.set(4, { target: 1, at: 1000 });
  expect(encounterTarget(options).overwhelmed).toBe(true);
});

test('swing packets preserve attacker and defender, never assigning the source of an unlabelled damage packet', () => {
  const world = new WorldView();
  const swing = Buffer.alloc(10);
  swing[0] = 0x2f;
  swing.writeUInt32BE(2, 2);
  swing.writeUInt32BE(1, 6);
  world.apply(swing);
  expect(world.swings.get(2)?.target).toBe(1);
  const damage = Buffer.alloc(7);
  damage[0] = 0x0b;
  damage.writeUInt32BE(1, 1);
  damage.writeUInt16BE(20, 5);
  world.apply(damage);
  expect(world.swings.size).toBe(1);
  expect(world.swings.has(1)).toBe(false);
  expect(() => world.apply(swing.subarray(0, 9))).toThrow('Invalid swing');
});
