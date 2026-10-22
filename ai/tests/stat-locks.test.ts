import { expect, test } from 'bun:test';

import { statLock } from '../src/protocol/packets';
import { WorldView } from '../src/protocol/world';
import { desiredLock } from '../src/stat-locks';

test('stats rise below the archetype target, hold at it and fall above it', () => {
  expect(desiredLock(60, 100)).toBe(0);
  expect(desiredLock(100, 100)).toBe(2);
  expect(desiredLock(40, 25)).toBe(1);
});

test('stat lock change matches ServUO StatLockChange (0xBF 0x1A)', () => {
  expect([...statLock(1, 2)]).toEqual([0xbf, 0, 7, 0x00, 0x1a, 1, 2]);
  expect(() => statLock(3, 0)).toThrow('Invalid stat lock');
});

test('StatLockInfo (0xBF 0x19) reports two bits per stat for the player', () => {
  const world = new WorldView();
  world.serial = 123;
  const packet = Buffer.from([0xbf, 0, 12, 0x00, 0x19, 2, 0, 0, 0, 123, 0, (1 << 4) | (2 << 2) | 0]);
  world.apply(packet);
  expect(world.statLocks).toEqual([1, 2, 0]);
});
