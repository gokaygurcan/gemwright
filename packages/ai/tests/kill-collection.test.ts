import { expect, test } from 'bun:test';

import { createKillCollection } from '../src/v1/fighter-victory';
import { fighterFixture } from './fighter-fixture';

test('a recorded kill survives an interrupted loot attempt and is collected by the next turn', async () => {
  const f = fighterFixture();
  f.world.deaths.set(50, { corpse: 30, position: { x: 101, y: 100, z: 0 } } as never);
  let attempts = 0;
  const collection = createKillCollection(f.ctx, async () => {
    if (++attempts === 1) throw new Error('interrupted by danger');
    return true;
  });
  collection.record(50);
  expect(f.ctx.trip.pendingLoot).toHaveLength(1);
  await expect(collection.collect()).rejects.toThrow('danger');
  expect(f.ctx.trip.pendingLoot).toHaveLength(1);
  f.ctx.trip = JSON.parse(JSON.stringify(f.ctx.trip));
  const resumed = createKillCollection(f.ctx, async () => {
    attempts++;
    return true;
  });
  await resumed.collect();
  expect(f.ctx.trip.pendingLoot).toHaveLength(0);
  expect(attempts).toBe(2);
});
