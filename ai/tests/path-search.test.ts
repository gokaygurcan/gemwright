import { expect, test } from 'bun:test';

import { ConnectionAdmission } from '../src/connection-admission';
import { directRoute } from '../src/direct-route';
import { RouteCorridors } from '../src/path-corridors';
import { PathPool } from '../src/path-pool';
import { RouteSearch } from '../src/path-search';
import { RouteWaypoints } from '../src/route-waypoints';
import type { Terrain, TerrainBuffers } from '../src/terrain';

const fake = (walls = new Set<string>()) =>
  ({
    facet: 1,
    stand: (x: number, y: number, z: number) => (walls.has(`${x},${y}`) ? null : { x, y, z }),
    cell: () => ({ land: { id: 0 } }),
    tile: () => ({ name: 'grass' })
  }) as unknown as Terrain;

test('bounded search detours around walls and preserves legal adjacent steps', () => {
  const walls = new Set(Array.from({ length: 10 }, (_, i) => `15,${5 + i}`));
  const search = new RouteSearch();
  const result = search.run(fake(walls), {
    start: { x: 10, y: 10, z: 0 },
    goal: { x: 20, y: 10 },
    range: 0,
    blocked: []
  });
  expect(result.path?.at(-1)).toEqual({ x: 20, y: 10, z: 0 });
  let previous = { x: 10, y: 10, z: 0 };
  for (const p of result.path ?? []) {
    expect(walls.has(`${p.x},${p.y}`)).toBe(false);
    expect(Math.max(Math.abs(p.x - previous.x), Math.abs(p.y - previous.y))).toBe(1);
    previous = p;
  }
  expect(
    search.run(fake(), { start: { x: 25, y: 25, z: 0 }, goal: { x: 30, y: 30 }, range: 1, blocked: [] }).path?.length
  ).toBe(4);
});
test('unreachable routes have bounded work, support partial progress, and cancel', () => {
  const search = new RouteSearch();
  const request = { start: { x: 10, y: 10, z: 0 }, goal: { x: 1000, y: 1000 }, range: 0, blocked: [] };
  const enclosure = new Set<string>();
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++) if (dx || dy) enclosure.add(`${1000 + dx},${1000 + dy}`);
  const result = search.run(fake(enclosure), request);
  expect(result.expanded).toBeLessThanOrEqual(200000);
  expect(result.path).toBeNull();
  expect(search.run(fake(enclosure), { ...request, partial: true }).path?.length).toBeGreaterThan(0);
  expect(search.run(fake(), request, () => true).expanded).toBe(0);
});
test('direct travel stops at obstacles and does not cut diagonal corners', () => {
  const terrain = fake(new Set(['12,10', '11,11']));
  expect(directRoute(terrain, { x: 10, y: 10, z: 0 }, { x: 20, y: 10 }, 0, new Set())).toEqual([
    { x: 11, y: 10, z: 0 }
  ]);
  expect(directRoute(terrain, { x: 10, y: 10, z: 0 }, { x: 20, y: 20 }, 0, new Set())).toBeNull();
});
function buffers(): TerrainBuffers {
  const tiles = new SharedArrayBuffer(3188736);
  new Uint8Array(tiles).set(Buffer.from('grass'), 14);
  const index = new SharedArrayBuffer(8192 * 12);
  new Int32Array(index).fill(-1);
  return { map: new SharedArrayBuffer(8192 * 196), index, statics: new SharedArrayBuffer(0), tiles };
}
test('worker pool services concurrent routes and cancels queued work without retaining it', async () => {
  const pool = new PathPool('/fixture', 1, 2, buffers());
  try {
    const request = { start: { x: 10, y: 10, z: 0 }, goal: { x: 30, y: 30 }, range: 0, blocked: [] };
    const requests = Array.from({ length: 50 }, () => pool.run(request));
    const controller = new AbortController();
    const cancelled = pool.run(request, controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toThrow('cancelled');
    const results = await Promise.all(requests);
    expect(results.every((r) => r.path?.length === 20)).toBe(true);
    expect(pool.stats.completed).toBe(50);
  } finally {
    pool.close();
  }
});
test('connection admission bounds handshakes and releases cancelled waiters', async () => {
  const admission = new ConnectionAdmission(2);
  let active = 0;
  let peak = 0;
  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      admission.run(async () => {
        peak = Math.max(peak, ++active);
        await Bun.sleep(1);
        active--;
        return true;
      })
    )
  );
  expect(peak).toBe(2);
  expect(results.every(Boolean)).toBe(true);
  const abort = new AbortController();
  abort.abort();
  await expect(admission.run(async () => {}, abort.signal)).rejects.toThrow('cancelled');
});

test('city corridors can be joined from a different start without crossing an obstacle', () => {
  const walls = new Set(Array.from({ length: 100 }, (_, i) => `30,${i + 1}`));
  const terrain = fake(walls);
  const corridors = new RouteCorridors();
  const request = { start: { x: 10, y: 10, z: 0 }, goal: { x: 50, y: 10 }, range: 0, blocked: [] };
  const first = corridors.run(terrain, request, () => false);
  expect(first.path?.at(-1)).toEqual({ x: 50, y: 10, z: 0 });
  const second = corridors.run(terrain, { ...request, start: { x: 11, y: 10, z: 0 } }, () => false);
  expect(second.path?.at(-1)).toEqual({ x: 50, y: 10, z: 0 });
  expect(second.expanded).toBeLessThan(first.expanded);
  expect(second.path?.every((p) => !walls.has(`${p.x},${p.y}`))).toBe(true);
});

test('vendor interactions use the offered eight-tile range and require navigation outside it', async () => {
  const { approachVendor } = await import('../src/mobile-approach');
  const { WorldView } = await import('../src/protocol/world');
  const world = new WorldView();
  world.serial = 1;
  world.position = { x: 10, y: 10, z: 0, direction: 2 };
  const vendor = {
    serial: 2,
    kind: 'mobile' as const,
    graphic: 0x190,
    notoriety: 7,
    position: { x: 18, y: 10, z: 0, direction: 0 }
  };
  world.entities.set(2, vendor);
  const ctx = {
    session: { world },
    terrain: fake(),
    serial: 1,
    position: () => world.position ?? { x: 0, y: 0, z: 0 },
    navigate: async () => {
      throw new Error('Navigation required');
    },
    check: () => {}
  } as unknown as Parameters<typeof approachVendor>[0];
  expect((await approachVendor(ctx, 2)).serial).toBe(2);
  vendor.position.x = 19;
  await expect(approachVendor(ctx, 2)).rejects.toThrow('Navigation required');
});

test('waypoints permit a necessary detour away from a goal using verified local steps', () => {
  const terrain = fake(new Set(Array.from({ length: 100 }, (_, i) => `30,${i + 1}`)));
  const route = new RouteWaypoints([
    {
      name: 'detour',
      both: true,
      points: [
        [10, 10, 0],
        [10, 110, 0],
        [50, 110, 0],
        [50, 10, 0]
      ]
    }
  ]);
  const result = route.run(
    terrain,
    { start: { x: 10, y: 10, z: 0 }, goal: { x: 50, y: 10 }, range: 0, blocked: ['10,11'], partial: true },
    new RouteSearch(),
    () => false
  );
  expect(result?.path?.at(-1)).toEqual({ x: 10, y: 110, z: 0 });
  expect(result?.path?.some((p) => p.x === 10 && p.y === 11)).toBe(false);
});
