import { expect, test } from 'bun:test';

import { harvestTiles } from '@gemwright/common/game/rules';
import type { PlayerSession } from '@gemwright/network/session';
import { WorldView } from '@gemwright/network/world';

import { findMiningSite } from '../src/miner-sites';
import type { Terrain } from '../src/terrain';

// Twenty miners share a mountain: after one empty vein the blocks around it are empty too, and a
// miner that keeps trying the next-door block walks in circles (the loop watcher, 200 a day each).
test('around depleted veins the next site is an untouched part of the mountain, not next door', async () => {
  const rock = harvestTiles.rock.land[0] ?? 0;
  const near = (x: number, y: number) => x >= 96 && x <= 120 && y >= 96 && y <= 120;
  const far = (x: number, y: number) => x >= 148 && x <= 152 && y >= 100 && y <= 104;
  const terrain = {
    cell: (x: number, y: number) => ({ land: { id: near(x, y) || far(x, y) ? rock : 3, x, y, z: 0 }, statics: [] }),
    landKind: () => 'rock',
    findStatics: () => [],
    stand: (x: number, y: number, z: number) => ({ x, y, z }),
    pathAsync: async (_from: unknown, goal: { x: number; y: number }) => [{ ...goal, z: 0 }]
  } as unknown as Terrain;
  const world = new WorldView();
  world.map = 1;
  const session = { world, signal: new AbortController().signal } as unknown as PlayerSession;
  // The blocks the miner has found empty around it: everything but the far corner of its patch.
  const depleted = new Set<string>();
  for (let bx = 12; bx <= 14; bx++)
    for (let by = 12; by <= 14; by++) if (bx !== 14 || by !== 14) depleted.add(`${bx},${by}`);
  const found = await findMiningSite({
    session,
    terrain,
    serial: 1,
    position: () => ({ x: 100, y: 100, z: 0 }),
    check: () => {},
    exhausted: { has: (key) => depleted.has(key) },
    blocked: new Set(),
    miningArea: { x: 128, y: 128 },
    anchor: null
  });
  expect(found?.site.x).toBeGreaterThanOrEqual(148);
});
