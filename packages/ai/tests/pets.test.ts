import { expect, test } from 'bun:test';

import type { PlayerSession } from '@gemwright/network/session';
import { WorldView } from '@gemwright/network/world';

import { petSource, waitForPets } from '../src/pets';

function road() {
  const world = new WorldView();
  world.position = { x: 100, y: 100, z: 0, direction: 0 };
  world.entities.set(5, { serial: 5, kind: 'mobile', graphic: 0xcc, position: { x: 110, y: 100, z: 0, direction: 0 } });
  const session = { world } as unknown as PlayerSession;
  petSource(session, 'companion', () => [5]);
  const position = () => world.position ?? { x: 0, y: 0, z: 0, direction: 0 };
  return { world, session, position };
}

test('a pet falling behind on the road is waited for until it catches up', async () => {
  const { world, session, position } = road();
  let waits = 0;
  const caught = await waitForPets(session, position, async () => {
    waits++;
    const pet = world.entities.get(5);
    if (pet?.position) pet.position = { ...pet.position, x: pet.position.x - 2 };
  });
  expect(caught).toBe(true);
  expect(waits).toBe(4);
});

test('a pet that never closes in is waited for once, then not again for a minute', async () => {
  const { session, position } = road();
  const start = Date.now();
  let clock = start;
  const realNow = Date.now;
  Date.now = () => clock;
  const tick = async () => {
    clock += 250;
  };
  try {
    expect(await waitForPets(session, position, tick)).toBe(true);
    expect(await waitForPets(session, position, tick)).toBe(false);
  } finally {
    Date.now = realNow;
  }
  expect(clock - start).toBeGreaterThanOrEqual(8000);
});
