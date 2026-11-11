import { expect, test } from 'bun:test';

import { harvestTiles } from '@gemwright/common/game/rules';
import type { PlayerSession } from '@gemwright/network/session';

import type { Terrain } from '../src/terrain';
import type { HistoryEvent } from '../src/v2/history';
import { Mind } from '../src/v2/mind';
import { options } from '../src/v2/options';
import { traitsOf } from '../src/v2/traits';

const traits = traitsOf([], () => 0.5).traits;
const event = (at: number, kind: string, data: object): HistoryEvent => ({ resident: 'r', at, kind, data });
const rock = harvestTiles.rock.land[0] as number;

// With a pickaxe in its pack and rock three tiles east, it could walk over, use the pickaxe and
// target the rock: the attempt it would learn as using its pickaxe on that land, foreseen to bring ore.
test('a tool it carries offers working the tiles it works nearby', () => {
  const mind = new Mind('r', () => {}, traits);
  mind.observe(event(0, 'awake', { serial: 1, self: { health: { current: 50, max: 50 } }, skills: { Mining: 60 } }));
  mind.observe(event(0, 'gained', { serial: 10, kind: 'item', graphic: 3718, parent: 2, is: ['Pickaxe'] }));
  const session = {
    world: {
      serial: 1,
      position: { x: 10, y: 10, z: 0, direction: 0 },
      entities: new Map([[10, { serial: 10, kind: 'item', graphic: 3718, parent: 2 }]])
    }
  } as unknown as PlayerSession;
  const terrain = {
    bestTiles: (
      tiles: { land: number[] },
      _at: object,
      score: (p: { x: number; y: number; z: number; land: number }) => number
    ) => (tiles.land.length ? [{ x: 13, y: 10, z: 0, land: rock }].filter((p) => score(p) > -Infinity) : []),
    findTiles: () => [],
    findStatics: () => [],
    cell: (x: number, y: number) => ({ land: { x, y, z: 0, id: x === 13 && y === 10 ? rock : 3 } })
  } as unknown as Terrain;
  const [found] = options(mind, session, terrain, new Set());
  expect(found).toMatchObject({
    key: `double-click my Pickaxe > target land${rock}`,
    steps: [
      { verb: 'walk', x: 13, y: 10, range: 2 },
      { verb: 'dismount' },
      { verb: 'use', serial: 10 },
      { verb: 'target', x: 13, y: 10, z: 0, graphic: 0 }
    ],
    foresight: { gained: { IronOre: 0.6 } }
  });
  expect(options(mind, session, terrain, new Set(['13,10']))).toEqual([]);
});

// Riding, it gets off before it mines (ServUO: no mining while riding).
test('mining from a horse starts by getting off it', () => {
  const mind = new Mind('r', () => {}, traits);
  mind.observe(event(0, 'awake', { serial: 1, self: { health: { current: 50, max: 50 } }, skills: { Mining: 60 } }));
  mind.observe(event(0, 'gained', { serial: 10, kind: 'item', graphic: 3718, parent: 2, is: ['Pickaxe'] }));
  const session = {
    world: {
      serial: 1,
      position: { x: 10, y: 10, z: 0, direction: 0 },
      entities: new Map([
        [10, { serial: 10, kind: 'item', graphic: 3718, parent: 2 }],
        [11, { serial: 11, kind: 'item', graphic: 0x3ea2, parent: 1, layer: 25 }]
      ])
    }
  } as unknown as PlayerSession;
  const terrain = {
    bestTiles: (tiles: { land: number[] }) => (tiles.land.length ? [{ x: 11, y: 10, z: 0, land: rock }] : []),
    findTiles: () => [],
    findStatics: () => [],
    cell: (x: number, y: number) => ({ land: { x, y, z: 0, id: x === 11 && y === 10 ? rock : 3 } })
  } as unknown as Terrain;
  expect(options(mind, session, terrain, new Set())[0]?.steps.map((s) => s.verb)).toEqual([
    'walk',
    'dismount',
    'use',
    'target'
  ]);
});

// A pickaxe in its bank box is out of reach: nothing to mine with.
test('a tool in its bank box offers nothing', () => {
  const mind = new Mind('r', () => {}, traits);
  mind.observe(event(0, 'awake', { serial: 1, self: { health: { current: 50, max: 50 } }, skills: { Mining: 60 } }));
  mind.observe(event(0, 'revealed', { serial: 5, kind: 'item', graphic: 2475, layer: 29, parent: 1, is: ['BankBox'] }));
  mind.observe(event(0, 'revealed', { serial: 10, kind: 'item', graphic: 3718, parent: 5, is: ['Pickaxe'] }));
  const session = {
    world: {
      serial: 1,
      position: { x: 10, y: 10, z: 0, direction: 0 },
      entities: new Map([[10, { serial: 10, kind: 'item', graphic: 3718, parent: 5 }]])
    }
  } as unknown as PlayerSession;
  const terrain = {
    findTiles: () => [],
    findStatics: () => [],
    cell: (x: number, y: number) => ({ land: { x, y, z: 0, id: x === 11 && y === 10 ? rock : 3 } })
  } as unknown as Terrain;
  expect(options(mind, session, terrain, new Set()).filter((o) => o.key.includes('Pickaxe'))).toEqual([]);
});

// A blue diamond dug from a vein sells to no vendor, but it is a crafting material worth keeping: by
// a banker, it goes into the bank with her gold.
test('rare gems from harvesting are banked with the gold', () => {
  const mind = new Mind('r', () => {}, traits);
  mind.observe(event(0, 'awake', { serial: 1, self: {} }));
  mind.observe(
    event(0, 'revealed', { serial: 2, kind: 'item', graphic: 3701, layer: 21, parent: 1, is: ['Backpack'] })
  );
  mind.observe(event(0, 'revealed', { serial: 8, kind: 'item', graphic: 3821, amount: 500, parent: 2, is: ['Gold'] }));
  mind.observe(
    event(0, 'revealed', { serial: 9, kind: 'item', graphic: 12696, amount: 5, parent: 2, is: ['BlueDiamond'] })
  );
  mind.observe(event(0, 'seen', { serial: 40, kind: 'mobile', graphic: 400, x: 12, y: 10, is: ['Banker'] }));
  const session = {
    world: {
      serial: 1,
      position: { x: 10, y: 10, z: 0, direction: 0 },
      entities: new Map<number, object>([
        [2, { serial: 2, kind: 'item', graphic: 3701, parent: 1, layer: 21 }],
        [8, { serial: 8, kind: 'item', graphic: 3821, parent: 2 }],
        [9, { serial: 9, kind: 'item', graphic: 12696, parent: 2 }],
        [40, { serial: 40, kind: 'mobile', graphic: 400, position: { x: 12, y: 10, z: 0 } }]
      ])
    }
  } as unknown as PlayerSession;
  const deposit = options(mind, session, undefined, new Set()).find((o) => o.key === 'deposit');
  expect(deposit?.steps.at(-1)).toEqual({ verb: 'deposit', items: [8, 9] });
});

// A cat and a hell cat share a body: until it has read the name over a creature's head, it does not
// pick a fight with it.
test('a creature is fought only once its name is read', () => {
  const mind = new Mind('r', () => {}, traits);
  mind.observe(event(0, 'awake', { serial: 1, self: { health: { current: 50, max: 50 } }, skills: { Swords: 60 } }));
  mind.observe(
    event(0, 'seen', { serial: 3, kind: 'mobile', graphic: 201, x: 11, y: 10, z: 0, is: ['Cat', 'HellCat'] })
  );
  const world = (name?: string) =>
    ({
      world: {
        serial: 1,
        position: { x: 10, y: 10, z: 0, direction: 0 },
        entities: new Map([[3, { serial: 3, kind: 'mobile', graphic: 201, name, position: { x: 11, y: 10, z: 0 } }]])
      }
    }) as unknown as PlayerSession;
  expect(options(mind, world(), undefined, new Set())).toEqual([]);
  mind.observe(event(1, 'changed', { serial: 3, name: 'a hell cat', is: ['HellCat'] }));
  expect(options(mind, world('a hell cat'), undefined, new Set()).map((o) => o.key)).toEqual(['attack HellCat']);
});

test('a broke miner can withdraw and sell remembered bank ingots to fund a replacement tool', async () => {
  const { choices } = await import('../src/v2/planning');
  const mind = new Mind('r', () => {}, traits, [], ['Mining', 'Blacksmith']);
  const awake = { serial: 1, self: {}, skills: { Mining: 100, Blacksmith: 74.3 } };
  mind.observe(event(0, 'awake', awake));
  mind.observe(event(1, 'revealed', { serial: 5, kind: 'item', layer: 29, parent: 1, is: ['BankBox'] }));
  mind.observe(event(2, 'revealed', { serial: 10, kind: 'item', parent: 5, amount: 43, is: ['IronIngot'] }));
  mind.observe(event(2, 'revealed', { serial: 11, kind: 'item', parent: 5, is: ['Tongs'] }));
  mind.observe(event(3, 'awake', awake));
  mind.observe(event(4, 'heard', { serial: 20, cliloc: 1042759, arguments: '0' }));
  const session = {
    world: { serial: 1, map: 1, position: { x: 10, y: 10, z: 0, direction: 2 }, entities: new Map() }
  } as unknown as PlayerSession;
  const places = { bankers: [{ x: 10, y: 10 }], vendors: [{ x: 12, y: 10, types: ['Blacksmith'] }] };
  const best = choices(mind, session, undefined, new Set(), places)[0];
  expect(best?.key).toBe('sell Blacksmith: 43 IronIngot');
  expect(best?.rate).toBeGreaterThan(-1);
  expect(best?.steps).toEqual([
    { verb: 'walk', x: 10, y: 10, range: 3 },
    { verb: 'say', text: 'bank' },
    { verb: 'withdraw', items: [10] },
    { verb: 'sell-to', x: 12, y: 10, types: ['Blacksmith'], names: ['IronIngot'] }
  ]);
});

test('a miner can buy a replacement tool with a balance reported by the banker', async () => {
  const { choices } = await import('../src/v2/planning');
  const mind = new Mind('r', () => {}, traits, [], ['Mining']);
  mind.observe(event(0, 'awake', { serial: 1, self: {}, skills: { Mining: 100 } }));
  mind.observe(event(1, 'heard', { serial: 20, cliloc: 1042759, arguments: '109' }));
  const session = {
    world: { serial: 1, position: { x: 10, y: 10, z: 0, direction: 2 }, entities: new Map() }
  } as unknown as PlayerSession;
  const found = choices(mind, session, undefined, new Set(), {
    bankers: [],
    vendors: [{ x: 10, y: 10, types: ['Tinker'] }]
  });
  expect(found.some((option) => option.key === 'buy Pickaxe' && option.rate > -1)).toBe(true);
});

test('unknown funds lead to checking the bank before ruling out replacement tools', () => {
  const mind = new Mind('r', () => {}, traits, [], ['Mining']);
  mind.observe(event(0, 'awake', { serial: 1, self: {}, skills: { Mining: 100 } }));
  const session = {
    world: { serial: 1, position: { x: 10, y: 10, z: 0 }, entities: new Map() }
  } as unknown as PlayerSession;
  const places = { bankers: [{ x: 10, y: 10 }], vendors: [{ x: 12, y: 10, types: ['Tinker'] }] };
  expect(
    options(mind, session, undefined, new Set(), places.bankers, places.vendors).find(
      (o) => o.key === 'check bank balance'
    )?.steps
  ).toEqual([{ verb: 'walk', x: 10, y: 10, range: 11 }, { verb: 'balance' }]);
  mind.observe(event(1, 'heard', { serial: 20, cliloc: 1042759, arguments: '0' }));
  expect(
    options(mind, session, undefined, new Set(), places.bankers, places.vendors).some(
      (o) => o.key === 'check bank balance'
    )
  ).toBe(false);
});
