import { expect, test } from 'bun:test';

import { cemeteries, nearAnyGround, nextGround, patrolPoints, travelToGround } from '../src/cemeteries';
import type { FighterContext } from '../src/fighter-context';
import { nearestGate } from '../src/moongate';

test('every cemetery has patrol points and a gate near it', () => {
  for (const cemetery of cemeteries) {
    expect(patrolPoints(cemetery).length).toBe(4);
    expect(nearAnyGround(cemetery.center)).toBe(true);
  }
  expect(nearestGate({ x: 722, y: 1119 })).toBe('yew');
  expect(nearAnyGround({ x: 1430, y: 1690 })).toBe(false);
});

test('a fighter moves on to grounds its skills meet: graveyards early, ogres and trolls later', async () => {
  const { grounds } = await import('../src/cemeteries');
  const { skillId } = await import('@gemwright/common/skills');
  const fighter = (swords: number) =>
    ({
      trip: { ground: 'Britain' },
      serial: 1,
      position: () => ({ x: 1369, y: 1475, z: 0 }),
      status: () => ({ maxHits: 100, armor: 30, hits: 100 }),
      template: { archetype: { primarySkills: ['Swordsmanship'], supportingSkills: [] }, behavior: {} },
      session: {
        world: {
          childrenOf: () => [{ layer: 1, graphic: 0x13ff }],
          skills: new Map([
            [skillId('Swordsmanship'), { value: swords, base: swords }],
            [skillId('Tactics'), { value: swords, base: swords }]
          ])
        }
      }
    }) as unknown as FighterContext;
  const hardest = (name: string) => Object.keys(grounds.find((g) => g.name === name)?.creatures ?? {});
  const novice = nextGround(fighter(30));
  expect(hardest(novice).every((type) => !['Troll', 'Ettin', 'Ogre'].includes(type)) || !hardest(novice).length).toBe(
    true
  );
  const veteran = nextGround(fighter(95));
  expect(grounds.find((g) => g.name === veteran)?.creatures).toBeDefined();
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
