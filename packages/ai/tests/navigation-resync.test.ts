import { expect, test } from 'bun:test';

import { rememberAttack } from '../src/danger';
import { lasting } from '../src/lasting';
import { createNavigator } from '../src/navigation';
import { behaviorFixture, required } from './behavior-fixture';

// Finn Gray, Nov 6: our height said z10 under the New Haven bank floor (z21). No route starts from
// a floor that is not there, so every walk failed at once, three hundred times in twelve minutes.
test('a position with no floor under it is checked with the shard before giving up on the route', async () => {
  const { session, world, terrain } = behaviorFixture();
  world.position = { x: 100, y: 100, z: 10, direction: 2 };
  terrain.stand = (x, y, z) => (z >= 20 ? { x, y, z: 21 } : null);
  terrain.pathAsync = async (from, goal) => (from.z >= 20 ? [{ x: goal.x, y: goal.y, z: 21 }] : null);
  let resyncs = 0;
  session.resyncPosition = async () => {
    resyncs++;
    world.position = { ...required(world.position), z: 21 };
    return true;
  };
  session.walk = async (direction) => {
    const at = required(world.position);
    if (at.direction !== direction) at.direction = direction;
    else at.x++;
    return true;
  };
  const navigate = createNavigator({ session, terrain, check: () => {}, phase: () => {}, log: () => {} });
  await navigate({ x: 101, y: 100 }, 0);
  expect(resyncs).toBe(1);
  expect(required(world.position).x).toBe(101);
});

// Rel'Ahm, Nov 6: places it was attacked lately walled in every route out of New Haven, and with
// no creature in sight it chose a new taming ground every second without taking a step.
test('remembered danger with nothing hostile in sight steers the route but never walls it off', async () => {
  const { session, world, terrain } = behaviorFixture();
  rememberAttack(session, { x: 104, y: 100, z: 0 });
  terrain.pathAsync = async (_from, goal, _range, occupied) =>
    occupied?.has('104,100') ? null : [{ x: goal.x, y: goal.y, z: 0 }];
  session.walk = async (direction) => {
    const at = required(world.position);
    if (at.direction !== direction) at.direction = direction;
    else at.x++;
    return true;
  };
  const navigate = createNavigator({ session, terrain, check: () => {}, phase: () => {}, log: () => {} });
  try {
    await navigate({ x: 101, y: 100 }, 0);
    expect(required(world.position).x).toBe(101);
  } finally {
    // The remembered attack lives in the process-wide tables: other tests share serial 1.
    for (const name of ['attacked-sites', 'danger'])
      for (const [key] of [...lasting(name).entries()]) if (key.startsWith('1|')) lasting(name).set(key, 0);
  }
});
