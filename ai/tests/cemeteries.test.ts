import { expect, test } from 'bun:test';

import { cemeteries, nearAnyGround, nextGround, patrolPoints, travelToGround } from '../src/cemeteries';
import type { FighterContext } from '../src/fighter-context';
import { nearestGate } from '../src/moongate';

const fighter = (ground: string | undefined, patrolOffset: number) =>
  ({ trip: { ground }, template: { behavior: { temperament: { patrolOffset } } } }) as unknown as FighterContext;

test('every cemetery has patrol points and a gate near it', () => {
  for (const cemetery of cemeteries) {
    expect(patrolPoints(cemetery).length).toBe(4);
    expect(nearAnyGround(cemetery.center)).toBe(true);
  }
  expect(nearestGate({ x: 722, y: 1119 })).toBe('yew');
  expect(nearAnyGround({ x: 1430, y: 1690 })).toBe(false);
});

test('fighters start at Britain and fan out in different orders', () => {
  const firstMoves = [0, 1, 2, 3].map((offset) => nextGround(fighter(undefined, offset)));
  expect(new Set(firstMoves).size).toBe(4);
  // Each order eventually visits every cemetery and returns to Britain.
  let ground: string | undefined;
  const visited = new Set<string>();
  for (let step = 0; step < cemeteries.length; step++) {
    ground = nextGround(fighter(ground, 2));
    visited.add(ground);
  }
  expect(visited.size).toBe(cemeteries.length);
  expect(ground).toBe('Britain');
});

test('overland travel walks to the selected mainland cemetery without using a moongate', async () => {
  const calls: unknown[] = [];
  const ctx = {
    trip: { ground: 'Yew' },
    position: () => ({ x: 1430, y: 1555, z: 0 }),
    phase: (value: string) => calls.push(value),
    navigate: async (point: unknown, range: number) => {
      calls.push({ point, range });
    }
  } as unknown as FighterContext;
  await travelToGround(ctx, true);
  expect(calls).toEqual(['travelling-to-graveyard', { point: { x: 722, y: 1119 }, range: 3 }]);
});
