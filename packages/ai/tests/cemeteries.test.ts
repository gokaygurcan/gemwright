import { expect, test } from 'bun:test';

import { nextGround, travelToGround } from '../src/cemeteries';
import type { FighterContext } from '../src/fighter-context';
import { useTestWorld } from './world-fixture';

useTestWorld();

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
  const ctx = Object.assign(macer(72, 1430, 1555), {
    phase: (value: string) => calls.push(value),
    navigate: async (point: unknown, range: number) => {
      calls.push({ point, range });
    }
  });
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

const macer = (skill: number, x: number, y: number) =>
  ({
    trip: { ground: 'Yew' },
    serial: 1,
    position: () => ({ x, y, z: 0 }),
    status: () => ({ maxHits: 100, armor: 30, hits: 100 }),
    template: { archetype: { primarySkills: ['Mace Fighting', 'Tactics'], supportingSkills: [] }, behavior: {} },
    session: {
      world: {
        childrenOf: () => [{ layer: 1, graphic: 0x13b4 }],
        skills: new Map([
          [41, { value: skill, base: skill }],
          [27, { value: skill, base: skill }]
        ])
      }
    }
  }) as unknown as FighterContext;

test('a fighter not ready for the ettins there does not hunt among the mongbats beside them', () => {
  for (let i = 0; i < 20; i++) expect(nextGround(macer(72, 3470, 2741))).not.toBe('mongbat and ettin near 3470,2741');
});

test("the shard's own spawners decide what lives in a cemetery", async () => {
  const { cemeteries, grounds, useShardSpawns } = await import('../src/cemeteries');
  const { parseSpawners } = await import('../src/spawns');
  const spawners = parseSpawners(
    '<Points><Name>Graveyards#0</Name><Map>Trammel</Map><CentreX>1369</CentreX><CentreY>1475</CentreY>' +
      '<MaxCount>5</MaxCount><Objects2>Skeleton:MX=5:SB=0</Objects2></Points>'
  );
  const bundled = [...grounds];
  const creatures = cemeteries.map((c) => c.creatures);
  try {
    useShardSpawns({ spawners, regions: [] });
    expect(grounds.find((g) => g.name === 'Britain')?.creatures).toEqual({ Skeleton: 5 });
  } finally {
    grounds.splice(0, grounds.length, ...bundled);
    cemeteries.forEach((c, i) => {
      c.creatures = creatures[i];
    });
  }
});

test('a fighter set on a ground it is not ready for, from before, goes elsewhere instead', async () => {
  const fighter = macer(72, 3480, 2700);
  (fighter as { trip: { ground: string } }).trip.ground = 'mongbat and ettin near 3470,2741';
  const calls: unknown[] = [];
  Object.assign(fighter, {
    phase: (value: string) => calls.push(value),
    navigate: async () => {},
    persist: () => {},
    checkpoint: {}
  });
  await travelToGround(fighter, true).catch(() => {});
  expect(fighter.trip.ground).not.toBe('mongbat and ettin near 3470,2741');
});

test('a ground a fighter found nothing to hunt on is not its next pick for a while', async () => {
  const { absence } = await import('../src/absence');
  const { grounds } = await import('../src/cemeteries');
  const fighter = macer(45, 1430, 1555);
  const first = nextGround(fighter);
  const left = grounds.find((g) => g.name === first);
  if (!left) throw new Error(`no ground ${first}`);
  absence(fighter.serial).note('ground', left.center);
  for (let i = 0; i < 10; i++) expect(nextGround(fighter)).not.toBe(first);
});
