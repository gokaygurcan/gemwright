import { afterAll, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TileFlag } from '@gemwright/common/assets/tiledata';

import { geometryView, houseBarriers } from '../src/geometry';
import { PathPool } from '../src/path-pool';
import { Terrain, type TerrainBuffers } from '../src/terrain';
import { type Component, decodeMultiUop, expandDesign } from '../src/v1/multi-assets';
import { observedTerrain } from '../src/v1/observed-terrain';
import { behaviorFixture } from './behavior-fixture';

const directories: string[] = [];
afterAll(() => {
  PathPool.closeAll();
  for (const dir of directories) rmSync(dir, { recursive: true });
});
function fixture(parts: Component[] = []) {
  const directory = mkdtempSync(join(tmpdir(), 'gemwright-house-'));
  directories.push(directory);
  const tiles = Buffer.alloc(3188736);
  const art = (id: number, flags: number, height: number) => {
    const offset = 493568 + (id >> 5) * (4 + 32 * 41) + 4 + (id & 31) * 41;
    tiles.writeUInt32LE(flags, offset);
    tiles[offset + 20] = height;
  };
  art(1, TileFlag.Surface | TileFlag.Bridge, 4);
  art(2, TileFlag.Impassable | TileFlag.Wall, 20);
  art(3, TileFlag.Surface, 0);
  const copy = (b: Buffer) => {
    const a = new SharedArrayBuffer(b.length);
    new Uint8Array(a).set(b);
    return a;
  };
  const index = Buffer.alloc(8192 * 12, 255);
  const buffers: TerrainBuffers = {
    map: new SharedArrayBuffer(8192 * 196),
    index: copy(index),
    statics: new SharedArrayBuffer(0),
    tiles: copy(tiles)
  };
  const multiIndex = Buffer.alloc(24, 255);
  multiIndex.writeInt32LE(0, 12);
  multiIndex.writeInt32LE(parts.length * 16, 16);
  const data = Buffer.alloc(parts.length * 16);
  parts.forEach((p, i) => {
    data.writeUInt16LE(p.id, i * 16);
    data.writeInt16LE(p.x, i * 16 + 2);
    data.writeInt16LE(p.y, i * 16 + 4);
    data.writeInt16LE(p.z, i * 16 + 6);
    data.writeBigUInt64LE(1n, i * 16 + 8);
  });
  writeFileSync(join(directory, 'multi.idx'), multiIndex);
  writeFileSync(join(directory, 'multi.mul'), data);
  const base = new Terrain(directory, 1, buffers);
  const f = behaviorFixture('swordsman');
  f.world.position = { x: 10, y: 10, z: 24, direction: 2 };
  const view = observedTerrain(base, f.session);
  return { ...f, base, view };
}
const stairs = Array.from({ length: 12 }, (_, x) => ({ id: 1, x, y: 0, z: 22 - x * 2 }));

test('a standard house stair absent from the base map provides a real route down and back up', async () => {
  const f = fixture(stairs);
  f.world.put({
    serial: 50,
    kind: 'item',
    multi: true,
    graphic: 1,
    facet: 1,
    position: { x: 10, y: 10, z: 0, direction: 0 }
  });
  expect(f.base.path({ x: 10, y: 10, z: 24 }, { x: 22, y: 10 }, 0, new Set(), 0)).toBeNull();
  const path = f.view.path({ x: 10, y: 10, z: 24 }, { x: 22, y: 10 }, 0, new Set(), 0);
  expect(path?.at(-1)).toEqual({ x: 22, y: 10, z: 0 });
  expect(path?.[0]).toEqual({ x: 11, y: 10, z: 22 });
  expect(f.view.path({ x: 22, y: 10, z: 0 }, { x: 10, y: 10 }, 0, new Set(), 24)?.at(-1)).toEqual({
    x: 10,
    y: 10,
    z: 24
  });
  expect((await f.view.pathAsync({ x: 10, y: 10, z: 24 }, { x: 22, y: 10 }, 0, new Set(), 0))?.at(-1)).toEqual({
    x: 22,
    y: 10,
    z: 0
  });
});

test('house updates and removal invalidate the observed overlay without contaminating another session', async () => {
  const f = fixture(stairs);
  f.world.put({ serial: 50, kind: 'item', multi: true, graphic: 1, position: { x: 10, y: 10, z: 0, direction: 0 } });
  const before = f.view.geometry?.revision;
  expect(f.view.stand(11, 10, 24)).toMatchObject({ z: 22 });
  const other = behaviorFixture();
  expect(observedTerrain(f.base, other.session).stand(11, 10, 24)).toBeNull();
  f.world.houseRevisions.set(50, 1);
  const bytes = Buffer.from([0, 3, 1, 0, 24]);
  f.world.houseDesigns.set(50, { revision: 1, tiles: 1, planes: [{ id: 9, data: bytes }] });
  f.world.revision++;
  f.world.observations.context(50);
  f.world.observations.publish(null);
  expect(f.view.geometry?.revision).not.toBe(before);
  expect(f.view.stand(11, 10, 24)).toMatchObject({ z: 24 });
  expect((await f.view.pathAsync({ x: 10, y: 10, z: 24 }, { x: 22, y: 10 }, 0, new Set(), 0))?.[0]?.z).not.toBe(22);
  f.world.remove(50);
  f.world.revision++;
  f.world.observations.context(50);
  f.world.observations.publish(null);
  expect(f.view.stand(11, 10, 24)).toBeNull();
  expect(f.base.stand(11, 10, 24)).toBeNull();
});

test('changed loose surfaces and walls participate in the same height and clearance checks', () => {
  const f = fixture();
  f.world.put({ serial: 60, kind: 'item', graphic: 3, position: { x: 11, y: 10, z: 24, direction: 0 } });
  f.world.revision++;
  f.world.observations.context(50);
  f.world.observations.publish(null);
  expect(f.view.stand(11, 10, 24)).toMatchObject({ z: 24 });
  f.world.put({ serial: 61, kind: 'item', graphic: 2, position: { x: 11, y: 10, z: 24, direction: 0 } });
  f.world.revision++;
  f.world.observations.context(50);
  f.world.observations.publish(null);
  expect(f.view.stand(11, 10, 24)).toBeNull();
  f.world.remove(61);
  f.world.revision++;
  f.world.observations.context(50);
  f.world.observations.publish(null);
  expect(f.view.stand(11, 10, 24)).toMatchObject({ z: 24 });
});

test('house avoidance permits exit and deliberate visits while excluding unrelated passage', () => {
  const scene = {
    revision: 'house',
    tiles: [],
    houses: [{ serial: 50, minX: 10, maxX: 20, minY: 10, maxY: 20, unknown: false }]
  };
  expect(houseBarriers(scene, { x: 5, y: 15, z: 0 }, { x: 25, y: 15 }).has('15,15')).toBe(true);
  expect(houseBarriers(scene, { x: 15, y: 15, z: 24 }, { x: 25, y: 15 }).size).toBe(0);
  expect(houseBarriers(scene, { x: 5, y: 15, z: 0 }, { x: 15, y: 15 }).size).toBe(0);
});

test('custom planes decode signed stairs and correctly locate upper floors and walls', () => {
  const foundation = [
    { id: 3, x: -1, y: -1, z: 0 },
    { id: 3, x: 2, y: 3, z: 0 }
  ];
  const floor = Buffer.alloc(3 * 4 * 2);
  floor.writeUInt16BE(3, 0);
  const wall = Buffer.alloc(4 * 5 * 2);
  wall.writeUInt16BE(2, 0);
  expect(
    expandDesign(
      [
        { id: 0x22, data: floor },
        { id: 0x26, data: wall },
        { id: 9, data: Buffer.from([0, 1, 255, 2, 20]) }
      ],
      foundation
    )
  ).toEqual([
    { id: 3, x: 0, y: 0, z: 27 },
    { id: 2, x: -1, y: -1, z: 27 },
    { id: 1, x: -1, y: 2, z: 20 }
  ]);
});

test('UOP components retain signed coordinates and omit nonphysical placeholder components', () => {
  const bytes = Buffer.alloc(8 + 14 * 2);
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt16LE(1, 8);
  bytes.writeInt16LE(-2, 10);
  bytes.writeUInt16LE(0, 16);
  bytes.writeUInt16LE(2, 22);
  bytes.writeUInt16LE(1, 30);
  expect(decodeMultiUop(bytes)).toEqual([{ id: 1, x: -2, y: 0, z: 0 }]);
  expect(() => decodeMultiUop(bytes.subarray(0, 20))).toThrow('Truncated');
});

test('custom house explicit stairs connect floors and disappear as soon as a newer design is announced', async () => {
  const f = fixture(stairs);
  f.world.put({ serial: 50, kind: 'item', multi: true, graphic: 1, position: { x: 10, y: 10, z: 0, direction: 0 } });
  const data = Buffer.alloc(stairs.length * 5);
  stairs.forEach((p, i) => {
    data.writeUInt16BE(p.id, i * 5);
    data.writeInt8(p.x, i * 5 + 2);
    data.writeInt8(p.y, i * 5 + 3);
    data.writeInt8(p.z, i * 5 + 4);
  });
  f.world.houseRevisions.set(50, 1);
  f.world.houseDesigns.set(50, { revision: 1, tiles: stairs.length, planes: [{ id: 9, data }] });
  f.world.revision++;
  f.world.observations.context(50);
  f.world.observations.publish(null);
  expect((await f.view.pathAsync({ x: 10, y: 10, z: 24 }, { x: 22, y: 10 }, 0, new Set(), 0))?.at(-1)).toEqual({
    x: 22,
    y: 10,
    z: 0
  });
  f.world.houseRevisions.set(50, 2);
  f.world.revision++;
  f.world.observations.context(50);
  f.world.observations.publish(null);
  expect(f.view.geometry?.houses?.[0]?.unknown).toBe(true);
  // The old design is never used as if it were the new one.
  f.world.houseDesigns.set(50, { revision: 2, tiles: 0, planes: [] });
  f.world.revision++;
  f.world.observations.context(50);
  f.world.observations.publish(null);
  expect(f.view.stand(11, 10, 24)).toBeNull();
  expect(await f.view.pathAsync({ x: 10, y: 10, z: 24 }, { x: 22, y: 10 }, 0, new Set(), 0)).toBeNull();
});

test('overlapping floors, low ceilings and walls are separated by height', () => {
  const { base } = fixture();
  const tiles = [
    { id: 3, x: 11, y: 10, z: 24 },
    { id: 3, x: 11, y: 10, z: 44 },
    { id: 2, x: 12, y: 10, z: 44 }
  ];
  const view = geometryView(base, { revision: 'floors', tiles });
  expect(view.stand(11, 10, 24)).toMatchObject({ z: 24 });
  expect(view.stand(11, 10, 44)).toMatchObject({ z: 44 });
  expect(view.stand(12, 10, 0)).toMatchObject({ z: 0 });
  expect(
    geometryView(base, { revision: 'ceiling', tiles: [...tiles, { id: 3, x: 11, y: 10, z: 30 }] }).stand(11, 10, 24)
  ).toBeNull();
  expect(view.path({ x: 11, y: 10, z: 24 }, { x: 11, y: 10 }, 0, new Set(), 44)).toBeNull();
});

test('a house moved after planning is re-read before the navigator attempts its first stair step', async () => {
  const f = fixture(stairs);
  f.world.put({ serial: 50, kind: 'item', multi: true, graphic: 1, position: { x: 10, y: 10, z: 0, direction: 0 } });
  const { createNavigator } = await import('../src/v1/navigation');
  const attempted: { x: number; y: number; z: number }[] = [];
  let replaced = false;
  const search = f.view.pathAsync.bind(f.view);
  // Force the worker path rather than the direct-path optimization.
  const stand = f.view.stand.bind(f.view);
  let planning = true;
  f.view.stand = (...args) => (planning ? null : stand(...args));
  f.view.pathAsync = async (...args) => {
    planning = false;
    const route = await search(...args);
    if (!replaced) {
      replaced = true;
      f.world.put({
        serial: 50,
        kind: 'item',
        multi: true,
        graphic: 1,
        position: { x: 50, y: 50, z: 0, direction: 0 }
      });
    }
    return route;
  };
  f.session.walk = async (_direction, z) => {
    attempted.push({ x: 11, y: 10, z: z ?? 24 });
    return false;
  };
  f.session.resyncPosition = async () => false;
  const navigate = createNavigator({
    session: f.session,
    terrain: f.view,
    check: () => {},
    phase: () => {},
    log: () => {},
    localOnly: true
  });
  await expect(navigate({ x: 22, y: 10, z: 0 }, 0)).rejects.toThrow('No observed walkable surface');
  expect(replaced).toBe(true);
  expect(attempted).toEqual([]);
});

test('navigation follows the house stairs to outdoor ground instead of retrying a distant gate', async () => {
  const f = fixture(stairs);
  f.world.put({ serial: 50, kind: 'item', multi: true, graphic: 1, position: { x: 10, y: 10, z: 0, direction: 0 } });
  const { createNavigator } = await import('../src/v1/navigation');
  const accepted: number[] = [];
  f.session.walk = async (direction, z) => {
    const from = f.world.position;
    if (!from) throw new Error('Missing position');
    if (from.direction !== direction) {
      f.world.position = { ...from, direction };
      return true;
    }
    const deltas = [
      [0, -1],
      [1, -1],
      [1, 0],
      [1, 1],
      [0, 1],
      [-1, 1],
      [-1, 0],
      [-1, -1]
    ];
    const [dx = 0, dy = 0] = deltas[direction] ?? [];
    const x = from.x + dx,
      y = from.y + dy;
    const expected = y === 10 && x >= 10 && x <= 22 ? 24 - (x - 10) * 2 : undefined;
    if (expected === undefined || expected !== z) throw new Error('Attempted an unsupported movement');
    const next = { x, y, z: expected };
    f.world.position = { ...next, direction };
    accepted.push(next.z);
    return true;
  };
  const sleep = spyOn(Bun, 'sleep').mockImplementation(async () => {});
  const random = spyOn(Math, 'random').mockReturnValue(0);
  let now = Date.now();
  const clock = spyOn(Date, 'now').mockImplementation(() => (now += 1000));
  try {
    await createNavigator({
      session: f.session,
      terrain: f.view,
      check: () => {},
      phase: () => {},
      log: () => {},
      localOnly: true
    })({ x: 22, y: 10, z: 0 }, 0);
    expect(f.world.position).toMatchObject({ x: 22, y: 10, z: 0 });
    expect(accepted.slice(0, 3)).toEqual([22, 20, 18]);
  } finally {
    sleep.mockRestore();
    random.mockRestore();
    clock.mockRestore();
  }
});

test('changing house overlays reuses the immutable map buffers instead of copying them per revision', () => {
  const { base } = fixture();
  const a = geometryView(base, { revision: 'first', tiles: [{ id: 3, x: 10, y: 10, z: 24 }] });
  const b = geometryView(base, { revision: 'changed', tiles: [] });
  expect(a.sharedBuffers()).toBe(base.sharedBuffers());
  expect(b.sharedBuffers()).toBe(a.sharedBuffers());
  expect(base.geometry).toBeUndefined();
});

test('v2 hands use the same observed house stairs as v1', async () => {
  const f = fixture(stairs);
  f.world.put({ serial: 50, kind: 'item', multi: true, graphic: 1, position: { x: 10, y: 10, z: 0, direction: 0 } });
  const { Hands } = await import('../src/v2/hands');
  f.session.walk = async (direction, z) => {
    const from = f.world.position;
    if (!from) throw new Error('Missing position');
    if (direction !== 2 || z !== from.z - 2) return false;
    f.world.position = { ...from, x: from.x + 1, z };
    return true;
  };
  expect(await new Hands(f.session, f.base).do({ verb: 'walk', x: 22, y: 10, range: 0 }, () => true)).toBe(true);
  expect(f.world.position).toMatchObject({ x: 22, y: 10, z: 0 });
});
