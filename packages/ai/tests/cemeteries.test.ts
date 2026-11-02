import { expect, test } from 'bun:test';

import { nextGround, travelToGround } from '../src/cemeteries';
import type { FighterContext } from '../src/fighter-context';

test('a fighter moves on to grounds its skills meet: graveyards early, ogres and trolls later', async () => {
  const { grounds } = await import('../src/cemeteries');
  const { skillId } = await import('@gemwright/common/game/skills');
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

test('a novice standing by a cemetery of spellcasting undead does not choose to hunt there', async () => {
  const { skillId } = await import('@gemwright/common/game/skills');
  const novice = {
    trip: { ground: 'Britain' },
    serial: 1,
    position: () => ({ x: 1290, y: 3725, z: 0 }),
    status: () => ({ maxHits: 60, armor: 10, hits: 60 }),
    template: { archetype: { primarySkills: ['Swordsmanship'], supportingSkills: [] }, behavior: {} },
    session: {
      world: {
        childrenOf: () => [{ layer: 1, graphic: 0x13ff }],
        skills: new Map([
          [skillId('Swordsmanship'), { value: 30, base: 30 }],
          [skillId('Tactics'), { value: 30, base: 30 }]
        ])
      }
    }
  } as unknown as FighterContext;
  expect(nextGround(novice)).not.toBe('Jhelom');
});

test("a cemetery's creatures are its own graveyard spawner's, not every spawn nearby", async () => {
  const { grounds } = await import('../src/cemeteries');
  expect(grounds.find((g) => g.name === 'Britain')?.creatures).toEqual({
    Spectre: 2,
    Wraith: 2,
    Skeleton: 3,
    Zombie: 4
  });
});

test('a fighter not ready for a lich does not hunt the Cove graveyard', async () => {
  const { skillId } = await import('@gemwright/common/game/skills');
  const fighter = {
    trip: { ground: 'Britain' },
    serial: 1,
    position: () => ({ x: 2438, y: 1110, z: 0 }),
    status: () => ({ maxHits: 100, armor: 30, hits: 100 }),
    template: { archetype: { primarySkills: ['Macing'], supportingSkills: [] }, behavior: {} },
    session: {
      world: {
        childrenOf: () => [{ layer: 1, graphic: 0x13b4 }],
        skills: new Map([
          [skillId('Macing'), { value: 72, base: 72 }],
          [skillId('Tactics'), { value: 69, base: 69 }]
        ])
      }
    }
  } as unknown as FighterContext;
  for (let i = 0; i < 20; i++) expect(nextGround(fighter)).not.toBe('Cove');
});
