import { expect, test } from 'bun:test';

import type { PlayerSession } from '@gemwright/network/session';

import type { Terrain } from '../src/terrain';
import type { HistoryEvent } from '../src/v2/history';
import { Mind } from '../src/v2/mind';
import { options } from '../src/v2/options';
import { traitsOf } from '../src/v2/traits';
import { syncMind } from './fixtures/v2/mind-sync';

const event = (at: number, kind: string, data: object): HistoryEvent => ({ resident: 'r', at, kind, data });
const ROCK = 220;
// The pickaxe it carries, and the two seams the land holds: one a few steps off, one across the
// region. Same ground, same tool, same yield.
const NEAR = { x: 130, y: 100, z: 0, land: ROCK };
const FAR = { x: 200, y: 100, z: 0, land: ROCK };

const mindWithPickaxe = () => {
  const mind = new Mind('r', () => {}, traitsOf([], () => 0.5).traits);
  mind.observe(event(0, 'awake', { serial: 1, self: {}, skills: { Mining: 75 } }));
  mind.observe(
    event(0, 'revealed', {
      serial: 10,
      kind: 'item',
      graphic: 3718,
      parent: 2,
      amount: 1,
      is: ['SturdyPickaxe', 'Pickaxe', 'Hoe']
    })
  );
  return mind;
};

// The land answers as the shard's own work index does: the best-scoring of its spots, by the score
// handed to it (options.ts keeps that search to the ring it is looking in).
const terrainWith = () =>
  ({
    bestTiles: (
      tiles: { land: number[] },
      _at: unknown,
      score: (spot: { x: number; y: number; z: number; land: number }) => number
    ) => (tiles.land.length ? [NEAR, FAR].filter((spot) => score(spot) > Number.NEGATIVE_INFINITY) : []),
    findTiles: () => [],
    tile: () => ({ flags: 0, height: 0, layer: 0 }),
    sight: () => true,
    cell: (x: number, y: number) => ({ land: { x, y, z: 0, id: ROCK }, statics: [] })
  }) as unknown as Terrain;

const session = {
  world: {
    serial: 1,
    position: { x: 100, y: 100, z: 0, direction: 0 },
    entities: new Map<number, object>([
      [2, { serial: 2, kind: 'item', graphic: 3701, parent: 1, layer: 21 }],
      [10, { serial: 10, kind: 'item', graphic: 3718, parent: 2 }]
    ])
  }
} as unknown as PlayerSession;

const synced = (mind: Mind) => {
  syncMind(mind, (session as unknown as { world: Parameters<typeof syncMind>[1] }).world);
  return mind;
};

const harvests = (spent: ReadonlySet<string>) =>
  options(synced(mindWithPickaxe()), terrainWith(), spent)
    .filter((option) => String(option.id ?? '').startsWith('harvest '))
    .map((option) => String(option.id));

test('the nearest ground is worked first, and the far ground only once the near ground gives nothing', () => {
  // The near seam promises something: it is the only ground on offer, however far the other one is.
  expect(harvests(new Set())).toEqual(['harvest 10 130,100,0']);

  // That seam spent — worked out for the while — the search widens a ring at a time and the far one
  // is reached, rather than the resident standing idle beside a worked-out seam.
  expect(harvests(new Set(['130,100']))).toEqual(['harvest 10 200,100,0']);
});

// Kept to its cities, it looks for ground among the tiles listed inside them at start, never across
// the map's own index; the nearest ground worth working still comes first.
test('kept to its cities, ground is looked up in their list, never searched for across the map', async () => {
  const { prepareAreaWork } = await import('../src/v2/area-work');
  const { harvestKinds } = await import('../src/v2/knowledge');
  const OUTSIDE = { x: 900, y: 100, z: 0, land: ROCK };
  const terrain = {
    ...terrainWith(),
    findTiles: () => [NEAR, FAR, OUTSIDE],
    bestTiles: () => {
      throw new Error('searched the whole map');
    }
  } as unknown as Terrain;
  const allowed = (p: { x: number }) => p.x < 500;
  const bounds = { minX: 0, minY: 0, maxX: 499, maxY: 499 };
  prepareAreaWork(terrain, allowed, bounds, harvestKinds());
  const mind = synced(mindWithPickaxe());
  mind.allowed = allowed;
  mind.bounds = bounds;
  const picked = (spent: ReadonlySet<string>) =>
    options(mind, terrain, spent)
      .filter((option) => String(option.id ?? '').startsWith('harvest '))
      .map((option) => String(option.id));
  expect(picked(new Set())).toEqual(['harvest 10 130,100,0']);
  expect(picked(new Set(['130,100']))).toEqual(['harvest 10 200,100,0']);
});
