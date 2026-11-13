import { expect, test } from 'bun:test';

import { variable } from '@gemwright/network/packets';
import type { PlayerSession } from '@gemwright/network/session';
import { WorldView } from '@gemwright/network/world';

import { Mind } from '../src/v2/mind';
import { perceive } from '../src/v2/perceive';
import { traitsOf } from '../src/v2/traits';

function protection(cliloc: number) {
  const body = Buffer.alloc(47);
  body.writeUInt32BE(0xffffffff, 0);
  body.writeUInt32BE(cliloc, 11);
  body.write('System', 15, 'ascii');
  return variable(0xc1, body);
}

test('both guard-border messages reach the mind synchronously through real incoming packets', () => {
  const mind = new Mind('r', () => {}, traitsOf([], () => 0.5).traits);
  const world = new WorldView();
  world.serial = 1;
  world.map = 1;
  world.position = { x: 10, y: 10, z: 0, direction: 2 };
  const stop = perceive({ world } as unknown as PlayerSession, 'r', (e) => mind.observe(e));
  try {
    expect(mind.guarded).toBeUndefined();
    for (const cliloc of [500112, 500113, 500112]) {
      const revision = mind.revision;
      world.apply(protection(cliloc));
      expect(mind.guarded).toBe(cliloc === 500112);
      expect(mind.revision).toBeGreaterThan(revision);
    }
    world.map = 0;
    world.observations.publish(null, ['map']);
    expect(mind.guarded).toBeUndefined();
  } finally {
    stop();
  }
});

test('login reads current guard protection and reconnect cannot inherit the previous session state', () => {
  const mind = new Mind('r', () => {}, traitsOf([], () => 0.5).traits);
  const world = new WorldView();
  world.serial = 1;
  world.apply(protection(500112));
  const stop = perceive({ world } as unknown as PlayerSession, 'r', (e) => mind.observe(e));
  expect(mind.guarded).toBe(true);
  stop();
  const next = new WorldView();
  next.serial = 1;
  next.apply(protection(500113));
  const stopNext = perceive({ world: next } as unknown as PlayerSession, 'r', (e) => mind.observe(e));
  expect(mind.guarded).toBe(false);
  stopNext();
});
