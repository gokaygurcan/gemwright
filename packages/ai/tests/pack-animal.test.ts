import { expect, test } from 'bun:test';

import type { MountContext } from '../src/mount-types';
import { createPackAnimal } from '../src/pack-animal';
import { behaviorFixture, required } from './behavior-fixture';

function fixture() {
  const f = behaviorFixture('miner');
  let purchases = 0;
  f.session.context = async () => [];
  f.session.say = () => {};
  f.session.refreshStatus = async () => {};
  f.session.purchaseAnimal = async () => {
    purchases++;
  };
  f.checkpoint.funds = { bank: 10000, at: Date.now() };
  f.checkpoint.packAnimal = { schemaVersion: 1, state: 'seeking', fullLoads: 3 };
  const ctx: MountContext = { ...f.ctx, serial: 1, backpack: () => 10, status: () => required(f.world.status) };
  return { ...f, ctx, purchases: () => purchases };
}

for (const state of ['missing', 'lost', 'purchase-pending'] as const)
  test(`a ${state} pack animal is recovered or left missing, never replaced`, async () => {
    const f = fixture();
    const memory = required(f.checkpoint.packAnimal);
    memory.state = state;
    memory.lastSeen = { map: 0, x: 100, y: 100, z: 0 };
    if (state === 'lost') memory.abandoned = 3;
    if (state === 'missing') memory.horse = 42;
    const pack = createPackAnimal(f.ctx, 'Britain');
    for (let i = 0; i < 5; i++) await pack.acquire();
    expect(f.purchases()).toBe(0);
    if (state === 'missing') expect(memory.horse).toBe(42);
  });

test('a nearby owned pack animal is recognized before considering a purchase', async () => {
  const f = fixture();
  f.world.entities.set(42, {
    serial: 42,
    kind: 'mobile',
    graphic: 0x123,
    position: { x: 101, y: 100, z: 0, direction: 0 }
  });
  let checks = 0;
  f.session.context = async () => {
    checks++;
    return [{ index: 0, cliloc: 3006145, flags: 0 }];
  };
  const pack = createPackAnimal(f.ctx, 'Britain');
  await Promise.all(Array.from({ length: 10 }, () => pack.acquire()));
  expect(f.checkpoint.packAnimal?.horse).toBe(42);
  expect(f.checkpoint.packAnimal?.state).toBe('owned');
  expect(checks).toBe(1);
  expect(f.purchases()).toBe(0);
});

test('an unaccounted follower blocks a first purchase even when the old memory was lost', async () => {
  const f = fixture();
  required(f.world.status).followers = 1;
  const pack = createPackAnimal(f.ctx, 'Britain');
  await pack.acquire();
  expect(f.purchases()).toBe(0);
  expect(f.checkpoint.packAnimal?.state).toBe('missing');
});

test('a confirmed death clears the tracked animal without forgetting other unresolved animals', async () => {
  const f = fixture();
  const memory = required(f.checkpoint.packAnimal);
  memory.horse = 42;
  memory.state = 'owned';
  memory.abandoned = 2;
  f.world.deaths.set(42, { corpse: 50 });
  const pack = createPackAnimal(f.ctx, 'Britain');
  await pack.keepUp();
  expect(memory.horse).toBeUndefined();
  expect(memory).toMatchObject({ state: 'seeking', abandoned: 2 });
  await pack.acquire();
  expect(f.purchases()).toBe(0);
});
