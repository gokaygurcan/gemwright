import { expect, test } from 'bun:test';

import { canPause, recentlyHurt, urgentAction } from '../src/action-purpose';
import { consider, engagedWith, holdWhileEngaged } from '../src/engagement';
import { createNavigator } from '../src/navigation';
import { behaviorFixture, required } from './behavior-fixture';

test('escape breaks an existing conversation and cannot be held by another question', async () => {
  const { session, world } = behaviorFixture();
  world.entities.set(2, { serial: 2, kind: 'mobile', graphic: 400, position: { ...required(world.position), x: 101 } });
  expect(consider(session, 2, 1, 'needs')).toBe('engaged');
  await urgentAction(session, 'escape', async () => {
    expect(engagedWith(session)).toBeUndefined();
    expect(consider(session, 2, 1, 'wait')).toBe('brief');
    await holdWhileEngaged(session);
    expect(canPause(session)).toBe(false);
  });
  expect(canPause(session)).toBe(true);
  expect(engagedWith(session)).toBeUndefined();
});

test('nested urgent actions release their own scope even after a failure', async () => {
  const { session } = behaviorFixture();
  await urgentAction(session, 'combat', async () => {
    await expect(
      urgentAction(session, 'escape', async () => {
        throw new Error('blocked');
      })
    ).rejects.toThrow('blocked');
    expect(canPause(session)).toBe(false);
  });
  expect(canPause(session)).toBe(true);
});

test('fresh damage suppresses optional stops and expires without inventing an attacker', () => {
  const { session, world } = behaviorFixture();
  world.healthChanges.push({ at: 1000, hits: 80, maxHits: 100, damage: 20, healed: 0 });
  expect(recentlyHurt(session, 1200)).toBe(true);
  expect(recentlyHurt(session, 9000)).toBe(false);
  expect(recentlyHurt(session, 500)).toBe(false);
});

test('escape navigation passes loose gold and an engaged player without optional actions', async () => {
  const { session, world, terrain } = behaviorFixture();
  world.entities.set(2, { serial: 2, kind: 'mobile', graphic: 400, position: { ...required(world.position), y: 101 } });
  world.entities.set(12, {
    serial: 12,
    kind: 'item',
    graphic: 0xeed,
    amount: 10,
    flags: 0x20,
    position: { ...required(world.position), x: 101 }
  });
  consider(session, 2, 1, 'wait');
  session.moveItem = async () => {
    throw new Error('Stopped to scavenge during escape');
  };
  session.walk = async (direction) => {
    if (required(world.position).direction !== direction) required(world.position).direction = direction;
    else required(world.position).x++;
    return true;
  };
  const navigate = createNavigator({
    session,
    terrain,
    check: () => {},
    phase: () => {},
    log: () => {},
    purpose: 'escape'
  });
  await navigate({ x: 102, y: 100 }, 0);
  expect(required(world.position).x).toBe(102);
  expect(canPause(session)).toBe(true);
});

test('an unchanged impossible route is not searched repeatedly', async () => {
  const { session, world, terrain } = behaviorFixture();
  terrain.stand = () => null;
  let searches = 0;
  terrain.pathAsync = async () => {
    searches++;
    return null;
  };
  const navigate = createNavigator({ session, terrain, check: () => {}, phase: () => {}, log: () => {} });
  await expect(navigate({ x: 102, y: 100 }, 0)).rejects.toThrow('No walkable route');
  await expect(navigate({ x: 102, y: 100 }, 0)).rejects.toThrow('No walkable route');
  expect(searches).toBe(1);
  world.entities.set(20, { serial: 20, kind: 'item', graphic: 1, position: { ...required(world.position), x: 101 } });
  terrain.tile = () => ({ flags: 0x20000000, height: 0, layer: 0, name: 'door' });
  await expect(navigate({ x: 102, y: 100 }, 0)).rejects.toThrow('No walkable route');
  expect(searches).toBe(2);
});
