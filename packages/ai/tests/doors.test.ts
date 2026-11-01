import { expect, test } from 'bun:test';

import { createDoorOpener, isDoor } from '../src/doors';
import { createNavigator } from '../src/navigation';
import { behaviorFixture, required } from './behavior-fixture';

function fixture() {
  const f = behaviorFixture();
  const used: number[] = [];
  const logs: string[] = [];
  const door = (serial: number, graphic: number, x = 101, y = 100, z = 0) => {
    f.world.entities.set(serial, { serial, kind: 'item', graphic, position: { x, y, z, direction: 0 } });
  };
  f.session.use = (serial) => {
    used.push(serial);
    required(f.world.entities.get(serial)).graphic++;
  };
  const open = createDoorOpener(
    f.session,
    f.terrain,
    () => {},
    (line) => logs.push(line)
  );
  return { ...f, used, logs, door, open };
}

const from = { x: 100, y: 100, z: 0 };
const to = { x: 101, y: 100, z: 0 };

test('recognizes every ServUO door family without relying on client flags', () => {
  const { terrain } = fixture();
  const ranges = [
    [0xe8, 0xf7],
    [0x314, 0x363],
    [0x675, 0x6f6],
    [0x824, 0x833],
    [0x839, 0x848],
    [0x84c, 0x85b],
    [0x866, 0x875],
    [0x1fed, 0x1ffc],
    [0x2a05, 0x2a1c],
    [0x2d63, 0x2d70],
    [0x319c, 0x31af],
    [0x367b, 0x369a],
    [0x409b, 0x40a2],
    [0x410c, 0x4113],
    [0x41c2, 0x41c9],
    [0x41cf, 0x41d6],
    [0x436e, 0x437d],
    [0x46dd, 0x46e4],
    [0x4d22, 0x4d29],
    [0x50c8, 0x50d7],
    [0x5142, 0x5149],
    [0x9ad7, 0x9ae6],
    [0x9b3c, 0x9b4b]
  ];
  for (const [first, last] of ranges)
    for (let id = required(first); id <= required(last); id++) expect(isDoor(id, terrain)).toBe(true);
  for (const id of [
    0x241f, 0x2420, 0x2423, 0x2424, 0x2d46, 0x2d47, 0x2d48, 0x2d49, 0x2fe2, 0x2fe3, 0x2fe4, 0x2fe5, 0x363a, 0x3619,
    0x242, 0x244, 0x3c9, 0x3ca, 18304
  ])
    expect(isDoor(id, terrain)).toBe(true);
  expect(isDoor(0xeed, terrain)).toBe(false);
  terrain.tile = () => ({ flags: 0x20000000, height: 20, name: 'custom door', layer: 0 });
  expect(isDoor(0xf001, terrain)).toBe(true);
});

test('opens both independent gate leaves obstructing a diagonal step', async () => {
  const f = fixture();
  f.door(20, 0x845, 101, 100);
  f.door(21, 0x847, 101, 101);
  expect(await f.open(from, { x: 101, y: 101, z: 0 })).toEqual({ blocked: false, locked: false });
  expect(f.used).toEqual([20, 21]);
  await f.open(from, { x: 101, y: 101, z: 0 });
  expect(f.used).toEqual([20, 21]);
});

test('does not close a partner automatically opened by a linked door', async () => {
  const f = fixture();
  f.door(20, 0x845);
  f.door(21, 0x847, 101, 101);
  f.session.use = (serial) => {
    f.used.push(serial);
    for (const id of [20, 21]) required(f.world.entities.get(id)).graphic++;
  };
  await f.open(from, { x: 101, y: 101, z: 0 });
  expect(f.used).toEqual([20]);
});

test('ignores open doors, another floor and doors unrelated to the next step', async () => {
  const f = fixture();
  f.door(20, 0x676);
  f.door(21, 0x675, 101, 100, 20);
  f.door(22, 0x675, 100, 101);
  await f.open(from, to);
  expect(f.used).toEqual([]);
});

test('portcullis opening is confirmed by height rather than a graphic change', async () => {
  const f = fixture();
  f.door(20, 0x6f5);
  f.session.use = (serial) => {
    f.used.push(serial);
    required(required(f.world.entities.get(serial)).position).z += 20;
  };
  expect(await f.open(from, to)).toEqual({ blocked: false, locked: false });
  await f.open(from, to);
  expect(f.used).toEqual([20]);
});

test('a door that closes again can be reopened during the same journey', async () => {
  const f = fixture();
  f.door(20, 0x675);
  await f.open(from, to);
  required(f.world.entities.get(20)).graphic = 0x675;
  await f.open(from, to);
  expect(f.used).toEqual([20, 20]);
});

test('access refusals are reported instead of claiming the door opened', async () => {
  for (const cliloc of [502503, 1061637, 1113410, 1157017]) {
    const f = fixture();
    f.door(20, 0x675);
    f.session.use = () => f.world.journal.push({ at: new Date().toISOString(), serial: 1, name: '', cliloc });
    expect(await f.open(from, to)).toEqual({ blocked: true, locked: true });
    expect(f.logs.at(-1)).toContain(`refused access (${cliloc})`);
  }
});

test('a door the shard accepts without a state update is assumed open, not blocked', async () => {
  const f = fixture();
  f.door(20, 0x675);
  f.session.use = (serial) => {
    f.used.push(serial);
  };
  expect(await f.open(from, to)).toEqual({ blocked: false, locked: false });
  expect(f.used).toEqual([20]);
  expect(f.logs.some((line) => line.includes('did not open'))).toBe(false);
});

test('Caladwen can walk diagonally through the New Haven double gate without rejected movement', async () => {
  const f = fixture();
  f.world.position = { x: 3523, y: 2577, z: 7, direction: 7 };
  f.door(20, 0x845, 3522, 2577, 7);
  f.door(21, 0x847, 3522, 2576, 7);
  f.session.walk = async () => {
    expect(f.used).toEqual([20, 21]);
    f.world.position = { x: 3522, y: 2576, z: 7, direction: 7 };
    return true;
  };
  const navigate = createNavigator({
    session: f.session,
    terrain: f.terrain,
    check: () => {},
    phase: () => {},
    log: (line) => f.logs.push(line),
    purpose: 'escape',
    localOnly: true
  });
  await navigate({ x: 3522, y: 2576 }, 0);
  expect(f.world.position.x).toBe(3522);
  expect(f.logs.some((line) => line.includes('Movement rejected'))).toBe(false);
});

test('a route with no path opens adjacent gates before giving up and retries after their observed change', async () => {
  const f = fixture();
  f.world.position = { x: 3523, y: 2577, z: 7, direction: 6 };
  f.door(20, 0x845, 3522, 2577, 7);
  f.door(21, 0x847, 3522, 2576, 7);
  const closed = () => [20, 21].some((id) => [0x845, 0x847].includes(required(f.world.entities.get(id)).graphic));
  f.terrain.stand = (x, y, z) => (closed() ? null : { x, y, z });
  f.terrain.pathAsync = async () => null;
  let walks = 0;
  f.session.walk = async () => {
    expect(closed()).toBe(false);
    required(f.world.position).x--;
    walks++;
    return true;
  };
  const navigate = createNavigator({
    session: f.session,
    terrain: f.terrain,
    check: () => {},
    phase: () => {},
    log: () => {},
    purpose: 'escape',
    localOnly: true
  });
  await navigate({ x: 3521, y: 2577 }, 0);
  expect(f.used).toEqual([20, 21]);
  expect(walks).toBe(2);
  expect(f.world.position.x).toBe(3521);
});

test('a cached no-path result still permits adjacent door interaction after access changes', async () => {
  const f = fixture();
  f.world.position = { x: 3523, y: 2577, z: 7, direction: 6 };
  f.door(20, 0x845, 3522, 2577, 7);
  let denied = true;
  f.session.use = (serial) => {
    f.used.push(serial);
    if (denied) f.world.addJournal({ serial: 1, name: '', cliloc: 502503 });
    else required(f.world.entities.get(serial)).graphic++;
  };
  const closed = () => f.world.entities.get(20)?.graphic === 0x845;
  f.terrain.stand = (x, y, z) => (closed() ? null : { x, y, z });
  f.terrain.pathAsync = async () => null;
  f.session.walk = async () => {
    required(f.world.position).x--;
    return true;
  };
  const navigate = createNavigator({
    session: f.session,
    terrain: f.terrain,
    check: () => {},
    phase: () => {},
    log: () => {},
    purpose: 'escape',
    localOnly: true
  });
  await expect(navigate({ x: 3521, y: 2577 }, 0)).rejects.toThrow('No walkable route');
  denied = false;
  await navigate({ x: 3521, y: 2577 }, 0);
  expect(f.used).toEqual([20, 20]);
  expect(f.world.position.x).toBe(3521);
});

test('with no path on foot, walking to a teleporter does not take the teleporters back and forth', async () => {
  const f = fixture();
  f.world.position = { x: 1286, y: 3731, z: 0, direction: 2 };
  f.terrain.pathAsync = async () => null;
  f.session.walk = async () => false;
  // Nothing carries it anywhere: every wait for the far end times out.
  f.session.waitFor = async () => {
    throw new Error('teleport timed out');
  };
  let teleporters = 0;
  const navigate = createNavigator({
    session: f.session,
    terrain: f.terrain,
    check: () => {},
    phase: (name) => {
      if (name === 'teleporter' && ++teleporters > 20) throw new Error('teleporters taken back and forth');
    },
    log: () => {}
  });
  await expect(navigate({ x: 1420, y: 3830 }, 2)).rejects.toThrow('No walkable route');
  expect(teleporters).toBeLessThanOrEqual(2);
}, 15_000);
