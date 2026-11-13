import { expect, test } from 'bun:test';

import { Layer } from '@gemwright/network/layers';
import type { PlayerSession } from '@gemwright/network/session';
import { WorldView } from '@gemwright/network/world';

import type { Place } from '../src/v2/atlas';
import { growth, keepStatLocks, statLocks, statTargets } from '../src/v2/growth';
import { hover } from '../src/v2/hover';
import { Mind } from '../src/v2/mind';
import type { Narrator } from '../src/v2/narrate';
import { perceive } from '../src/v2/perceive';
import { Places } from '../src/v2/places';
import { shower } from '../src/v2/show';
import { traitsOf } from '../src/v2/traits';
import { itemInContainer, loginConfirm, mobileIncoming } from './fixtures/v2/shard-packets';

const traits = traitsOf([], () => 0.5).traits;

test('going from one level of a dungeon to the next, it knows it went down, and back up', () => {
  const world = new WorldView();
  world.apply(loginConfirm(1, 5400, 100, 0, 2));
  const places: Place[] = [];
  const level = (x: number): Place => ({
    map: 1,
    regions: ['Shame'],
    kind: 'dungeon',
    guarded: false,
    land: x < 5500 ? 1 : 2,
    dungeon: 'Shame',
    level: x < 5500 ? 1 : 2
  });
  const stop = perceive(
    { world, phase: 'ready' } as unknown as PlayerSession,
    'r',
    (e) => {
      if (e.kind === 'place') places.push(e.data as Place);
    },
    undefined,
    (p) => level(p.x)
  );
  world.apply(loginConfirm(1, 5600, 100, 0, 2));
  world.apply(loginConfirm(1, 5601, 100, 0, 2));
  world.apply(loginConfirm(1, 5400, 100, 0, 2));
  stop();
  expect(places.map((p) => [p.level, p.came])).toEqual([
    [1, undefined],
    [2, 'down'],
    [1, 'up']
  ]);
});

test('its stats are set toward what its trade trains, within the shard caps', () => {
  const caps = { stats: 225, stat: [125, 125, 125] };
  // Mining and Blacksmithy both train strength first, dexterity second (ServUO SkillInfo).
  expect(statTargets(['Mining', 'Blacksmith'], [100, 100, 25], caps)).toEqual([125, 90, 10]);
  expect(statTargets([], [60, 50, 40], caps)).toEqual([60, 50, 40]);
  expect(statLocks([100, 100, 25], [125, 90, 10])).toEqual([0, 1, 1]);
  const mind = new Mind('r', () => {}, traits, [], ['Mining', 'Blacksmith']);
  mind.self.caps = { skill: 100, total: 700, ...caps };
  mind.observe({
    resident: 'r',
    at: 0,
    kind: 'self',
    data: { attributes: { strength: 100, dexterity: 100, intelligence: 25 }, statLocks: [0, 0, 0] }
  });
  const sent: number[][] = [];
  const session = {
    setLock: (_: string, stat: number, lock: number) => sent.push([stat, lock])
  } as unknown as PlayerSession;
  const already: (number | undefined)[] = [];
  keepStatLocks(mind, session, already, () => {});
  keepStatLocks(mind, session, already, () => {});
  expect(sent).toEqual([
    [1, 1],
    [2, 1]
  ]);
});

test('its growth is its skills against the shard total cap, what rose lately and how each is set', () => {
  const skills = new Map([
    ['Mining', { value: 80, base: 80, cap: 100, lock: 0 }],
    ['Tactics', { value: 40, base: 40, cap: 100, lock: 2 }]
  ]);
  const view = growth(
    skills,
    [
      { skill: 'Mining', at: 1000, delta: 0.1 },
      { skill: 'Mining', at: 2000, delta: 0.2 },
      { skill: 'Tactics', at: -4_000_000, delta: 0.1 }
    ],
    700,
    3000
  );
  expect(view).toEqual({
    total: 120,
    cap: 700,
    room: 580,
    rising: [{ skill: 'Mining', gained: 0.3 }],
    locks: { up: ['Mining'], down: [], locked: ['Tactics'] }
  });
});

test('its own things are looked at closely one at a time, each once, between the steps of its plans', async () => {
  const world = new WorldView();
  world.apply(loginConfirm(1, 10, 10, 0, 2));
  world.apply(mobileIncoming(1, 400, 10, 10, 0, 2, [{ serial: 2, graphic: 3701, layer: Layer.Backpack }]));
  world.apply(itemInContainer(20, 3718, 1, 2));
  world.apply(itemInContainer(21, 7154, 30, 2));
  const mind = new Mind('r', () => {}, traits);
  const asked: number[] = [];
  const session = {
    world,
    phase: 'ready',
    inspectProperties: async (serial: number) => {
      asked.push(serial);
      const item = world.entities.get(serial);
      if (item) world.put({ ...item, properties: [{ cliloc: 1072789, arguments: '3' }] });
    }
  } as unknown as PlayerSession;
  const stop = perceive(session, 'r', (e) => mind.observe(e));
  let turns = 0;
  // While its hands are at a plan, it does not look.
  await hover(
    session,
    mind,
    () => ++turns > 4,
    new Set(),
    () => true,
    1
  );
  expect(asked).toEqual([]);
  turns = 0;
  await hover(
    session,
    mind,
    () => ++turns > 4,
    new Set(),
    () => false,
    1
  );
  stop();
  expect(asked.sort()).toEqual([2, 20, 21]);
});

test('out of sight, a thing on the ground or a corpse is remembered for as long as its kind stays', () => {
  const mind = new Mind('r', () => {}, traits);
  const places = new Places('r', () => {}, {
    lifetimes: [{ Bandage: { watched: 600, endings: 0 }, Corpse: { watched: 600, endings: 0 } }],
    left: []
  });
  mind.places = places;
  const where = { x: 10, y: 10, z: 0, map: 1 };
  const event = (at: number, kind: string, data: object) => {
    const e = { resident: 'r', at, kind, data, where };
    mind.observe(e);
    places.observe(e);
  };
  event(Date.now(), 'awake', { serial: 1, self: {} });
  event(Date.now(), 'seen', { serial: 8, graphic: 3617, x: 12, y: 10, z: 0, flags: 0x20, is: ['Bandage'] });
  event(Date.now(), 'seen', { serial: 9, graphic: 8198, x: 13, y: 10, z: 0, is: ['Corpse'] });
  expect(mind.has().ground.map((g) => g.serial)).toEqual([8]);
  expect(mind.has().corpses.map((c) => [c.serial, c.name])).toEqual([[9, 'Corpse']]);
  // Walked away: both out of sight, believed still there.
  const away = { ...where, x: 60 };
  for (const serial of [8, 9]) {
    const gone = { resident: 'r', at: Date.now(), kind: 'gone', data: { serial }, where: away };
    mind.observe(gone);
    places.observe(gone);
  }
  expect(mind.has().ground).toMatchObject([{ serial: 8, remembered: true }]);
  expect(mind.has().corpses).toMatchObject([{ serial: 9, remembered: true }]);
});

test('what it knows is written down when it changes, and said over its head when it matters', () => {
  const written: { kind: string; data: Record<string, unknown> }[] = [];
  const said: string[] = [];
  const mind = new Mind('r', () => {}, traits);
  mind.observe({ resident: 'r', at: 0, kind: 'awake', data: { serial: 1, self: {}, skills: { AnimalTaming: 20 } } });
  const show = shower(mind, { tell: (text: string) => said.push(text) } as unknown as Narrator, (kind, data) =>
    written.push({ kind, data: data as Record<string, unknown> })
  );
  mind.observe({
    resident: 'r',
    at: 1,
    kind: 'place',
    data: { map: 1, regions: ['New Haven'], kind: 'town', guarded: true } satisfies Place
  });
  show();
  show();
  mind.observe({
    resident: 'r',
    at: 2,
    kind: 'skill',
    data: { skill: 'AnimalTaming', value: 30, before: 20, base: 30, cap: 100, lock: 0 }
  });
  show();
  expect(written.map((w) => w.kind)).toEqual(['abilities', 'holding', 'abilities']);
  expect(said[0]).toBe('New Haven, guarded');
  expect(said.some((text) => text.startsWith('can tame '))).toBe(true);
  expect(written[2]?.data.tames).toContain('Horse');
});
