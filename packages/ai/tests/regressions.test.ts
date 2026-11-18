import { expect, test } from 'bun:test';

import { harvestTiles } from '@gemwright/common/game/rules';
import type { PlayerSession } from '@gemwright/network/session';

import { Hands } from '../src/hands';
import { Mind } from '../src/mind';
import { options, type Step } from '../src/options';
import { stance } from '../src/planning';
import type { Terrain } from '../src/terrain';
import { traitsOf } from '../src/traits';
import { heard } from './fixtures/journal';
import { seeing } from './fixtures/mind-sync';

function miner() {
  const mind = new Mind('r', () => {}, traitsOf([], () => 0.5).traits, [], ['Mining']);
  mind.observe({ resident: 'r', at: 0, kind: 'awake', data: { serial: 1, self: {}, skills: { Mining: 80 } } });
  for (const [serial, name, graphic] of [
    [10, 'Pickaxe', 3718],
    [11, 'IronOre', 0x19b8]
  ] as const)
    mind.observe({
      resident: 'r',
      at: 0,
      kind: 'revealed',
      data: { serial, kind: 'item', parent: 2, graphic, is: [name], amount: 10 }
    });
  const world = {
    serial: 1,
    position: { x: 10, y: 10, z: 0, direction: 0 },
    entities: new Map<number, object>([
      [10, { serial: 10, kind: 'item', parent: 2, graphic: 3718 }],
      [11, { serial: 11, kind: 'item', parent: 2, graphic: 0x19b8 }],
      [12, { serial: 12, kind: 'item', graphic: 4017, position: { x: 100, y: 10, z: 0 } }]
    ])
  };
  const rock = harvestTiles.rock.land[0] as number;
  const terrain = {
    bestTiles: () => [{ x: 310, y: 10, z: 0, land: rock }],
    findTiles: () => [],
    findStatics: () => [],
    cell: (x: number, y: number) => ({ land: { x, y, z: 0, id: x === 310 && y === 10 ? rock : 3 } })
  } as unknown as Terrain;
  return { mind, session: { world } as unknown as PlayerSession, terrain };
}

test('a harvest destination beyond the old search radius remains a choice', () => {
  const { mind, session, terrain } = miner();
  expect(
    options(seeing(mind, session), terrain, new Set()).some((o) =>
      o.steps.some((s) => s.verb === 'walk' && s.x === 310)
    )
  ).toBe(true);
});

test('an observed forge remains usable beyond eight tiles', () => {
  const { mind, session, terrain } = miner();
  expect(
    options(seeing(mind, session), terrain, new Set()).some((o) =>
      o.steps.some((s) => s.verb === 'use' && s.serial === 11)
    )
  ).toBe(true);
});

test('a chosen running movement reaches the network client', async () => {
  const sent: boolean[] = [];
  const world = { serial: 1, position: { x: 10, y: 10, z: 0, direction: 2 }, entities: new Map() };
  const session = {
    world,
    walk: async (_d: number, _z: number, running: boolean) => {
      sent.push(running);
      world.position.x++;
      return true;
    }
  } as unknown as PlayerSession;
  const terrain = { pathAsync: async () => [{ x: 11, y: 10, z: 0 }] } as unknown as Terrain;
  await new Hands(session, terrain).do({ verb: 'walk', x: 11, y: 10, range: 0, running: true } as Step, () => true);
  expect(sent).toEqual([true]);
});

test('peaceful tool use clears inherited war mode', async () => {
  const world = {
    serial: 1,
    entities: new Map([[10, { kind: 'item' }]]),
    target: null as object | null,
    journal: [],
    warMode: true
  };
  const modes: boolean[] = [];
  const session = {
    world,
    phase: 'ready',
    setWarMode: (on: boolean) => {
      modes.push(on);
      world.warMode = on;
    },
    use: () => {
      world.target = {};
    }
  } as unknown as PlayerSession;
  const hands = new Hands(session, undefined);
  const steps: Step[] = [{ verb: 'use', serial: 10 }];
  await hands.do(stance(steps), () => true);
  expect(await hands.do(steps[0] as Step, () => true)).toBe(true);
  expect(modes).toEqual([false]);
});

test('seeking a creature continues into combat with the observed creature', async () => {
  const attacked: number[] = [];
  const world = {
    serial: 1,
    position: { x: 10, y: 10, z: 0 },
    entities: new Map([[20, { serial: 20, kind: 'mobile', position: { x: 11, y: 10, z: 0 } }]])
  };
  const session = {
    world,
    attack: async (serial: number) => {
      attacked.push(serial);
      world.entities.delete(serial);
    }
  } as unknown as PlayerSession;
  const hands = new Hands(
    session,
    undefined,
    () => undefined,
    () => 'Zombie'
  );
  expect(await hands.do({ verb: 'seek', kind: 'Zombie', x: 100, y: 10, range: 10 } as Step, () => true)).toBe(true);
  expect(attacked).toEqual([20]);
});

test('a harvest does not finish at its initial tool message', async () => {
  const world = heard({ target: {}, journal: [] as { cliloc: number }[] });
  let finished = false;
  const session = {
    world,
    target: () => {
      world.journal.push({ cliloc: 503033 });
      setTimeout(() => {
        finished = true;
        world.journal.push({ cliloc: 503040 });
      }, 120);
    }
  } as unknown as PlayerSession;
  await new Hands(session, undefined).do({ verb: 'target', x: 10, y: 10 }, () => true);
  expect(finished).toBe(true);
});

test('smelting ends before there are ingots to sell', () => {
  const { mind, session, terrain } = miner();
  const found = options(seeing(mind, session), terrain, new Set(), [], [{ x: 400, y: 20, types: ['Blacksmith'] }]);
  expect(found.some((o) => o.id?.startsWith('smelt '))).toBe(true);
  expect(found.some((o) => o.steps.some((s) => s.verb === 'sell-to'))).toBe(false);
});

test('a vendor known by location can be resolved as a person and checked through its sale list', async () => {
  const { Actions } = await import('@gemwright/network/replies');
  const sold: number[] = [];
  const world = {
    serial: 1,
    position: { x: 10, y: 10, z: 0 },
    entities: new Map<number, object>([
      [2, { serial: 2, kind: 'item', graphic: 3701, parent: 1, layer: 21 }],
      [20, { serial: 20, kind: 'mobile', position: { x: 11, y: 10, z: 0 } }],
      [11, { serial: 11, kind: 'item', parent: 2 }]
    ]),
    sellOffers: new Map<number, { serial: number; price: number; amount: number }[]>()
  };
  const session = {
    world,
    context: async () => [{ index: 1, cliloc: Actions.sell, flags: 0 }],
    selectContext: (serial: number) => world.sellOffers.set(serial, [{ serial: 11, price: 4, amount: 10 }]),
    sell: async (_vendor: number, items: { serial: number }[]) => {
      sold.push(...items.map((i) => i.serial));
    }
  } as unknown as PlayerSession;
  const hands = new Hands(
    session,
    undefined,
    () => undefined,
    (serial) => (serial === 20 ? 'Person' : 'my IronIngot')
  );
  expect(
    await hands.do({ verb: 'sell-to', x: 11, y: 10, types: ['Blacksmith'], names: ['IronIngot'] }, () => true)
  ).toBe(true);
  expect(sold).toEqual([11]);
});

test('seeking interrupts travel when a matching creature appears and attacks it', async () => {
  const attacked: number[] = [];
  const world = { serial: 1, position: { x: 0, y: 10, z: 0, direction: 2 }, entities: new Map<number, object>() };
  const session = {
    world,
    walk: async () => {
      world.position.x++;
      if (world.position.x === 4)
        world.entities.set(20, { serial: 20, kind: 'mobile', position: { x: 5, y: 10, z: 0 } });
      return true;
    },
    attack: async (serial: number) => {
      attacked.push(serial);
      world.entities.delete(serial);
    }
  } as unknown as PlayerSession;
  const terrain = {
    pathAsync: async () => Array.from({ length: 20 }, (_, i) => ({ x: i + 1, y: 10, z: 0 }))
  } as unknown as Terrain;
  const hands = new Hands(
    session,
    terrain,
    () => undefined,
    () => 'Zombie'
  );
  expect(await hands.do({ verb: 'seek', kind: 'Zombie', x: 20, y: 10, range: 0 }, () => true)).toBe(true);
  expect(attacked).toEqual([20]);
  expect(world.position.x).toBe(4);
});

test('selling uses only the ingots actually carried', () => {
  const { mind, session, terrain } = miner();
  mind.observe({
    resident: 'r',
    at: 0,
    kind: 'revealed',
    data: { serial: 13, kind: 'item', graphic: 0x1bf2, parent: 2, amount: 2, is: ['IronIngot'] }
  });
  session.world.entities.set(13, { serial: 13, kind: 'item', graphic: 0x1bf2, parent: 2, amount: 2 });
  const trip = options(seeing(mind, session), terrain, new Set(), [], [{ x: 400, y: 20, types: ['Blacksmith'] }]).find(
    (o) => o.steps.some((s) => s.verb === 'sell-to')
  );
  expect(trip?.foresight?.gained).toEqual({ Gold: 8 });
  expect(trip?.foresight?.lost).toEqual({ IronIngot: 2 });
});

test('interrupting a plan releases its cursor before another action can own it', async () => {
  const used: number[] = [];
  const targets: unknown[] = [];
  const world = heard({ target: {}, entities: new Map([[10, { serial: 10, kind: 'item' }]]), journal: [] });
  const session = {
    world,
    phase: 'ready',
    use: (serial: number) => used.push(serial),
    target: (location: unknown) => targets.push(location)
  } as unknown as PlayerSession;
  expect(await new Hands(session, undefined).do({ verb: 'use', serial: 10 }, () => false)).toBe(false);
  expect(used).toEqual([]);
  expect(targets).toEqual([null]);
});

test('a confirmed kill loots its own corpse even when deliberation wants another target', async () => {
  const moved: number[] = [];
  const at = { x: 10, y: 10, z: 0, direction: 0 };
  const entities = new Map<number, object>([
    [2, { serial: 2, parent: 1, layer: 21 }],
    [20, { serial: 20, kind: 'mobile', position: at }],
    [30, { serial: 30, kind: 'item', position: at }],
    [31, { serial: 31, kind: 'item', position: at }]
  ]);
  const deaths = new Map();
  const journal: { cliloc: number }[] = [];
  let opens = 0;
  const session = {
    world: heard({ serial: 1, position: at, entities, deaths, journal }),
    attack: async () => {
      entities.delete(20);
      deaths.set(20, { corpse: 31 });
    },
    use: (serial: number) => {
      if (++opens === 1) journal.push({ cliloc: 500119 });
      else entities.set(40, { serial: 40, kind: 'item', parent: serial });
    },
    moveItem: async (serial: number) => {
      moved.push(serial);
    }
  } as unknown as PlayerSession;
  let checks = 0;
  const hands = new Hands(
    session,
    undefined,
    undefined,
    (serial) => (serial === 40 ? 'Gold' : undefined),
    () => 1
  );
  expect(await hands.do({ verb: 'fight', serial: 20 }, () => ++checks === 1)).toBe(true);
  expect(opens).toBe(2);
  expect(moved).toEqual([40]);
  expect(entities.get(40)).toMatchObject({ parent: 31 });
});

test('a seek that arrives with none of its kind on screen is done: what is there is what it works with', async () => {
  const world = { serial: 1, position: { x: 0, y: 10, z: 0, direction: 2 }, entities: new Map<number, object>() };
  const session = {
    world,
    walk: async () => {
      world.position.x++;
      return true;
    }
  } as unknown as PlayerSession;
  const terrain = {
    pathAsync: async (from: { x: number }, goal: { x: number; y: number }) =>
      Array.from({ length: Math.max(0, goal.x - from.x) }, (_, i) => ({ x: from.x + i + 1, y: 10, z: 0 }))
  } as unknown as Terrain;
  const hands = new Hands(
    session,
    terrain,
    () => undefined,
    () => 'Bull'
  );
  expect(await hands.do({ verb: 'seek', kind: 'Mongbat', x: 20, y: 10, range: 8 }, () => true)).toBe(true);
  expect(world.position.x).toBeGreaterThanOrEqual(12);
});

test('a menu is answered by what it is, not by one time it was opened: whichever of it is open now', async () => {
  const gumps = new Map<string, object>();
  const replies: [number, number, number][] = [];
  const world = { serial: 1, position: { x: 0, y: 0, z: 0 }, entities: new Map(), gumps };
  const session = {
    world,
    replyGump: (serial: number, id: number, button: number) => {
      if (!gumps.has(`${serial}:${id}`)) throw new Error('Gump is not currently open');
      replies.push([serial, id, button]);
      gumps.delete(`${serial}:${id}`);
    }
  } as unknown as PlayerSession;
  // The shard sends this opening of it a moment later, under a serial of its own.
  setTimeout(
    () => gumps.set('4711:269917563', { serial: 4711, id: 269917563, layout: '{ button 1 1 1 1 1 0 7 }' }),
    50
  );
  const hands = new Hands(session, undefined);
  expect(await hands.do({ verb: 'gump-response', gump: 269917563, button: 7 }, () => true)).toBe(true);
  expect(replies).toEqual([[4711, 269917563, 7]]);
});
