import { expect, test } from 'bun:test';

import { type Ground, type Spot, spotKey, walkInCell } from '../src/walk-graph-build';

// Flat open ground: every tile stands at height 0.
const flat: Ground = { standingZ: () => 0 } as unknown as Ground;

// The walkable steps from each spot are kept for later walks in the same cell, as packed spot keys:
// a tile's neighbours cost one array of numbers, not an object per neighbour, and walks agree.
test('a walk within a cell keeps each spot’s steps as packed keys and walks the same', () => {
  const known = new Map<number, unknown>();
  const source: Spot = { x: 100, y: 100, z: 0 };
  const first = walkInCell(flat, source, new Set(), known as never);
  expect(known.size).toBeGreaterThan(0);
  for (const around of known.values())
    expect((around as unknown[]).every((step) => typeof step === 'number')).toBe(true);
  expect(walkInCell(flat, source, new Set(), known as never)).toEqual(first);
  expect(first.get(spotKey({ x: 101, y: 101, z: 0 }))).toBe(1);
});
