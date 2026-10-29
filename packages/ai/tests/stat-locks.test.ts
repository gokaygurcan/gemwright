import { expect, test } from 'bun:test';

import type { PlayerSession } from '@gemwright/network/session';
import { WorldView } from '@gemwright/network/world';

import { outgrewYoung } from '../src/progression';
import { desiredLock } from '../src/stat-locks';

test('stats rise below the archetype target, hold at it and fall above it', () => {
  expect(desiredLock(60, 100)).toBe(0);
  expect(desiredLock(100, 100)).toBe(2);
  expect(desiredLock(40, 25)).toBe(1);
});

test('Young status requires at least three skills at 100.0 base', () => {
  const world = new WorldView();
  const session = { world } as PlayerSession;
  expect(outgrewYoung(session)).toBe(false);
  for (let id = 0; id < 7; id++) world.skills.set(id, { base: 60, value: 60, cap: 100, lock: 0 });
  expect(outgrewYoung(session)).toBe(false);
  for (const id of [0, 1]) world.skills.set(id, { base: 100, value: 100, cap: 120, lock: 0 });
  expect(outgrewYoung(session)).toBe(false);
  world.skills.set(2, { base: 99.9, value: 110, cap: 120, lock: 0 });
  expect(outgrewYoung(session)).toBe(false);
  world.skills.set(2, { base: 100, value: 100, cap: 120, lock: 0 });
  expect(outgrewYoung(session)).toBe(true);
  world.skills.set(3, { base: 120, value: 120, cap: 120, lock: 0 });
  expect(outgrewYoung(session)).toBe(true);
});
