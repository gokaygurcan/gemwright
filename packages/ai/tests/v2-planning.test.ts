import { expect, test } from 'bun:test';

import { harvestTiles } from '@gemwright/common/game/rules';
import type { PlayerSession } from '@gemwright/network/session';

import type { Terrain } from '../src/terrain';
import { WorkIndex } from '../src/terrain-work';
import { Mind } from '../src/v2/mind';
import { choices } from '../src/v2/planning';
import { traitsOf } from '../src/v2/traits';
import { seeing } from './fixtures/v2/mind-sync';

const rock = harvestTiles.rock.land[0] as number;

test('world indexing finds a distant alternative when the nearest tile is exhausted', () => {
  const map = Buffer.alloc(512 * 196);
  for (let block = 0; block < 512; block++)
    for (let cell = 0; cell < 64; cell++) map.writeUInt16LE(3, block * 196 + 4 + cell * 3);
  for (const y of [10, 400]) map.writeUInt16LE(rock, (y >> 3) * 196 + 4 + ((y % 8) * 8 + 1) * 3);
  const index = new WorkIndex(map, Buffer.alloc(0), Buffer.alloc(0));
  const found = index.best(
    { land: [rock], statics: [] },
    { x: 1, y: 10, z: 0 },
    (point) => (point.y === 10 ? -Infinity : -Math.abs(point.y - 10)),
    (_kind, distance) => -distance
  );
  expect(found).toEqual([{ x: 1, y: 400, z: 0, land: rock }]);
});

test('execution failure changes confidence for that destination without banning its terrain type', () => {
  const history: { kind: string; data: object }[] = [];
  const mind = new Mind('r', (e) => history.push(e), traitsOf([], () => 0.5).traits);
  mind.complete('harvest shovel 2493,560,0', false);
  expect(mind.chance('harvest shovel 2493,560,0')).toBe(0.5);
  expect(mind.chance('harvest shovel 2600,500,0')).toBe(1);
  const replay = new Mind('r', () => {}, traitsOf([], () => 0.5).traits);
  for (const e of history) replay.observe({ resident: 'r', at: 0, ...e });
  expect(replay.chance('harvest shovel 2493,560,0')).toBe(0.5);
});

test('a full pack can choose processing that enables further harvesting', () => {
  const mind = new Mind('r', () => {}, traitsOf([], () => 0.5).traits, [], ['Mining']);
  const observe = (kind: string, data: object) => mind.observe({ resident: 'r', at: 0, kind, data });
  observe('awake', { serial: 1, self: {}, skills: { Mining: 80 } });
  observe('revealed', { serial: 2, kind: 'item', parent: 1, layer: 21, is: ['Backpack'] });
  observe('revealed', { serial: 10, kind: 'item', parent: 2, graphic: 3718, is: ['Pickaxe'] });
  observe('revealed', { serial: 11, kind: 'item', parent: 2, graphic: 0x19b8, amount: 10, is: ['IronOre'] });
  observe('changed', { serial: 11, properties: [{ cliloc: 1072789, arguments: '40' }] });
  const session = {
    world: {
      serial: 1,
      position: { x: 10, y: 10, z: 0, direction: 0 },
      status: { weight: 40, maxWeight: 40, stamina: 100 },
      entities: new Map<number, object>([
        [2, { serial: 2, kind: 'item', parent: 1, layer: 21 }],
        [10, { serial: 10, kind: 'item', parent: 2, graphic: 3718 }],
        [11, { serial: 11, kind: 'item', parent: 2, graphic: 0x19b8 }]
      ])
    }
  } as unknown as PlayerSession;
  const terrain = {
    bestTiles: () => [{ x: 12, y: 10, z: 0, land: rock }],
    findTiles: () => []
  } as unknown as Terrain;
  const plans = choices(seeing(mind, session), terrain, new Set(), {
    bankers: [],
    vendors: [],
    forges: [{ x: 11, y: 10, z: 0, id: 4017 }]
  });
  const processing = plans.find((p) => p.id.startsWith('smelt '));
  expect(processing).toBeDefined();
  expect(processing?.steps.filter((s) => s.verb === 'use').map((s) => s.serial)).toEqual([11]);
  expect(processing?.steps.some((s) => s.verb === 'drop')).toBe(false);
});

test('resource depletion follows the shard bank boundary and survives replay', () => {
  const history: { kind: string; data: object }[] = [];
  const mind = new Mind('r', (e) => history.push(e), traitsOf([], () => 0.5).traits);
  mind.exhausted({ x: 2493, y: 560, width: 8, height: 8, respawn: 20 * 60_000 });
  expect(mind.availability(2492, 565)).toBeLessThan(1);
  expect(mind.availability(2493, 559)).toBe(1);
  const replay = new Mind('r', () => {}, traitsOf([], () => 0.5).traits);
  for (const e of history) replay.observe({ resident: 'r', at: 0, ...e });
  expect(replay.availability(2492, 565)).toBeLessThan(1);
  expect(replay.availability(2493, 559)).toBe(1);
});

test('entering sight retains the combat intention and values the observed target', () => {
  const where = { x: 0, y: 10, z: 0, map: 1 };
  const mind = new Mind(
    'r',
    () => {},
    traitsOf([], () => 0.5).traits,
    [
      {
        name: 'undead',
        x: 100,
        y: 10,
        z: 0,
        map: 'Trammel',
        range: 10,
        max: 1,
        kinds: ['zombie'],
        mx: {},
        delay: [5, 10]
      }
    ],
    ['Macing', 'Tactics']
  );
  mind.observe({
    resident: 'r',
    at: 0,
    where,
    kind: 'awake',
    data: { serial: 1, self: { health: { current: 100, max: 100 } }, skills: { Macing: 80, Tactics: 80 } }
  });
  // It passed the undead spawn once (none in sight then), and knows the way back along the road.
  mind.observe({ resident: 'r', at: 0, where: { ...where, x: 95 }, kind: 'acted', data: { verb: 'walk' } });
  mind.observe({ resident: 'r', at: 5000, where, kind: 'acted', data: { verb: 'walk' } });
  mind.steps = (from, to) => Math.abs(to.x - from.x);
  const world = { serial: 1, position: { ...where, direction: 2 }, entities: new Map<number, object>() };
  const session = { world } as unknown as PlayerSession;
  const places = { bankers: [], vendors: [] };
  const trip = choices(seeing(mind, session), undefined, new Set(), places).find((p) => p.key.startsWith('go '));
  expect(trip).toBeDefined();
  world.position.x = 95;
  mind.observe({ resident: 'r', at: 1000, where: { ...where, x: 95 }, kind: 'acted', data: { verb: 'walk' } });
  world.entities.set(20, { serial: 20, kind: 'mobile', name: 'a zombie', position: { x: 96, y: 10, z: 0 } });
  mind.observe({
    resident: 'r',
    at: 1000,
    kind: 'seen',
    data: { serial: 20, kind: 'mobile', is: ['Zombie'], hits: 20, maxHits: 100 }
  });
  const nearby = choices(seeing(mind, session), undefined, new Set(), places, trip?.source);
  const continuation = nearby.find((p) => p.id === trip?.id);
  expect(continuation?.steps.some((s) => s.verb === 'seek')).toBe(true);
  expect(continuation?.rate).toBe(nearby.find((p) => p.id === 'attack 20')?.rate);
});

test('observed movement costs can make walking preferable to running', async () => {
  const { movement } = await import('../src/v2/motion');
  const choose = movement({ mounted: false, flying: false, winged: false, stamina: 10 }, (key) => ({
    steps: 10,
    seconds: key.includes('run') ? 2 : 4,
    stamina: key.includes('run') ? 10 : 0
  }));
  expect(choose(100).running).toBe(false);
});

test('movement experience survives history replay', () => {
  const history: { kind: string; data: object }[] = [];
  const mind = new Mind('r', (e) => history.push(e), traitsOf([], () => 0.5).traits);
  mind.locomotion.observed('foot run', 10, 2, 8);
  const replay = new Mind('r', () => {}, traitsOf([], () => 0.5).traits);
  for (const event of history) replay.observe({ resident: 'r', at: 0, ...event });
  expect(replay.locomotion.experience('foot run')).toEqual({ steps: 10, seconds: 2, stamina: 8 });
});
