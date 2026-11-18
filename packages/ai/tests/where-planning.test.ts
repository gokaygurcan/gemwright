import { expect, test } from 'bun:test';

import { journey, type Place } from '../src/atlas';
import { byWay } from '../src/banking';
import { LoopBreaker, planBudget } from '../src/loop-breaker';

const mainland: Place = { map: 1, regions: ['Yew'], kind: 'town', guarded: true, land: 1, island: 'the mainland' };
const level: Place = {
  map: 1,
  regions: ['Shame'],
  kind: 'dungeon',
  guarded: false,
  land: 2,
  dungeon: 'Shame',
  level: 2
};
const atOf = (p: { x: number }) => (p.x >= 5120 ? level : mainland);
const way = {
  stand: (p: { x: number; y: number; z: number }) => p,
  route: () => ({
    legs: [
      { kind: 'walk', x: 512, y: 1559, z: 0 },
      { kind: 'teleport', x: 514, y: 1561, z: 0 },
      { kind: 'walk', x: 5490, y: 19, z: 0 }
    ]
  })
};

test('a plan to another land names where it leads and the teleporters on the way', () => {
  const from = { x: 640, y: 980, z: 0, map: 1 };
  const bound = journey([{ verb: 'seek', x: 5445, y: 56 }], from, mainland, atOf, way);
  expect(bound?.to).toBe('Shame level 2');
  expect(bound?.via).toEqual([{ by: 'teleport', x: 514, y: 1561, to: 'Shame level 2' }]);
  expect(journey([{ verb: 'walk', x: 660, y: 990 }], from, mainland, atOf, way)).toBeUndefined();
});

test('places are nearest by the way there, and those no way reaches are left out', () => {
  const here = { x: 100, y: 100, z: 0 };
  const across = { x: 110, y: 100, name: 'across the water' };
  const along = { x: 160, y: 100, name: 'along the shore' };
  const island = { x: 105, y: 100, name: 'on an island' };
  const steps = (_from: unknown, to: { x: number }) => (to.x === 110 ? 400 : to.x === 160 ? 70 : undefined);
  expect(byWay(steps, here, 1, [across, along, island]).map((p) => p.name)).toEqual([
    'along the shore',
    'across the water'
  ]);
});

test('a long plan has the time it is expected to take, and is no stall while under way', () => {
  expect(planBudget(10, 0.5)).toBe(60_000);
  expect(planBudget(300, 0.5)).toBe(450_000);
  const breaker = new LoopBreaker(0);
  breaker.started(planBudget(300, 0.5), 0);
  expect(breaker.stalled(200_000)).toBe(false);
  expect(breaker.stalled(460_000)).toBe(true);
  breaker.relocated(460_000);
  expect(breaker.stalled(570_000)).toBe(false);
  expect(breaker.stalled(590_000)).toBe(true);
});
