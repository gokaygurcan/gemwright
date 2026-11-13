import { expect, test } from 'bun:test';

import { hueOf } from '@gemwright/common/game/rules';
import type { PlayerSession } from '@gemwright/network/session';

import { shed } from '../src/v2/dress';
import { mindFor, perceived, seeing } from './fixtures/v2/mind-sync';

for (const parent of [1, 2, 5, 6]) {
  test(`death robe in container ${parent} goes to the floor, whatever it has to wear instead`, async () => {
    const entities = new Map([
      [2, { serial: 2, graphic: 3701, parent: 1, layer: 21 }],
      [5, { serial: 5, graphic: 3701, parent: 1, layer: 29 }],
      [6, { serial: 6, graphic: 3701, parent: 2 }],
      [10, { serial: 10, graphic: 7939, hue: hueOf('DeathRobe'), parent, ...(parent === 1 ? { layer: 22 } : {}) }]
    ]);
    const dropped: number[] = [];
    const session = {
      world: { serial: 1, entities, position: { x: 10, y: 10, z: 0 } },
      resyncPosition: async () => true,
      moveItem: async (serial: number, to: number) =>
        Object.assign(entities.get(serial) ?? {}, { parent: to, layer: undefined }),
      dropAtFeet: async (serial: number) => {
        dropped.push(serial);
        entities.delete(serial);
      }
    } as unknown as PlayerSession;
    const world = (session as unknown as { world: { journal?: unknown[] } }).world;
    world.journal = [];
    await shed(
      perceived(session, mindFor(session)),
      mindFor(session),
      () => false,
      () => {},
      () => {}
    );
    expect(dropped).toEqual([10]);
  });
}

test('perception distinguishes death robes from ordinary robes using the server hue', async () => {
  const { identify } = await import('../src/v2/knowledge');
  expect(identify({ kind: 'item', graphic: 7939, hue: hueOf('DeathRobe') } as Parameters<typeof identify>[0])).toEqual([
    'DeathRobe'
  ]);
  expect(identify({ kind: 'item', graphic: 7939, hue: 1105 } as Parameters<typeof identify>[0])).not.toContain(
    'DeathRobe'
  );
});

test('death robes cannot be equipped, banked or sold even through explicit execution requests', async () => {
  const { Hands } = await import('../src/v2/hands');
  const { Actions } = await import('@gemwright/network/replies');
  const offers = new Map();
  const entities = new Map([
    [2, { serial: 2, graphic: 3701, parent: 1, layer: 21 }],
    [5, { serial: 5, graphic: 3701, parent: 1, layer: 29 }],
    [10, { serial: 10, graphic: 7939, hue: hueOf('DeathRobe'), parent: 2 }]
  ]);
  let forbidden = 0;
  const session = {
    world: { serial: 1, entities, sellOffers: offers },
    moveItem: async () => {
      forbidden++;
    },
    equipItem: async () => {
      forbidden++;
    },
    sell: async () => {
      forbidden++;
    },
    context: async () => [{ cliloc: Actions.sell, index: 1, flags: 0 }],
    selectContext: () => offers.set(20, [{ serial: 10, amount: 1, price: 1000 }])
  } as unknown as PlayerSession;
  const hands = new Hands(session, undefined);
  expect(await hands.do({ verb: 'equip', serial: 10, layer: 22 }, () => true)).toBe(false);
  expect(await hands.do({ verb: 'stow', serial: 10 }, () => true)).toBe(false);
  expect(await hands.do({ verb: 'deposit', items: [10] }, () => true)).toBe(false);
  expect(await hands.do({ verb: 'sell', vendor: 20, items: [10] }, () => true)).toBe(false);
  expect(forbidden).toBe(0);
});

test('replaying older robe descriptions still recognizes a death robe by its graphic and hue', async () => {
  const { Mind } = await import('../src/v2/mind');
  const { traitsOf } = await import('../src/v2/traits');
  const mind = new Mind('r', () => {}, traitsOf([], () => 0.5).traits);
  mind.observe({ resident: 'r', at: 0, kind: 'awake', data: { serial: 1, self: {} } });
  mind.observe({
    resident: 'r',
    at: 1,
    kind: 'revealed',
    data: { serial: 10, parent: 2, graphic: 7939, hue: hueOf('DeathRobe'), is: ['Robe', 'RewardRobe'] }
  });
  expect(mind.belongings().get(10)?.name).toBe('DeathRobe');
});

test('overload recovery never proposes banking a death robe instead of dropping it', async () => {
  const { overload } = await import('../src/v2/banking');
  const { Mind } = await import('../src/v2/mind');
  const { traitsOf } = await import('../src/v2/traits');
  const mind = new Mind('r', () => {}, traitsOf([], () => 0.5).traits);
  const entities = new Map([
    [2, { serial: 2, graphic: 3701, parent: 1, layer: 21 }],
    [5, { serial: 5, graphic: 3701, parent: 1, layer: 29 }],
    [10, { serial: 10, graphic: 7939, hue: hueOf('DeathRobe'), parent: 2 }]
  ]);
  mind.observe({ resident: 'r', at: 0, kind: 'awake', data: { serial: 1, self: {} } });
  mind.observe({ resident: 'r', at: 0, kind: 'self', data: { weight: { current: 153, max: 150 } } });
  for (const item of entities.values())
    mind.observe({
      resident: 'r',
      at: 1,
      kind: 'revealed',
      data: {
        ...item,
        is: [item.serial === 10 ? 'DeathRobe' : 'Backpack'],
        properties: [{ cliloc: 1072789, arguments: '3' }]
      }
    });
  const session = {
    world: { serial: 1, entities, status: { weight: 153, maxWeight: 150 }, position: { x: 10, y: 10, z: 0 } }
  } as unknown as PlayerSession;
  const plans = overload(seeing(mind, session), [{ x: 10, y: 10 }]);
  expect(plans).toHaveLength(1);
  expect(plans?.[0]?.steps).toEqual([{ verb: 'drop', serial: 10 }]);
});
