import { expect, test } from 'bun:test';

import type { PlayerSession } from '@gemwright/network/session';

import { Hands } from '../src/hands';

function client() {
  const world = {
    serial: 1,
    status: { weight: 100, maxWeight: 150 },
    entities: new Map([
      [2, { serial: 2, parent: 1, layer: 21, amount: 1, graphic: 3701, properties: [] }],
      [5, { serial: 5, parent: 1, layer: 29, amount: 1, graphic: 3701, properties: [] }],
      [
        10,
        {
          serial: 10,
          parent: 5,
          layer: 0,
          amount: 3000,
          graphic: 7154,
          properties: [{ cliloc: 1072789, arguments: '600' }]
        }
      ]
    ])
  };
  const moves: number[] = [];
  const session = {
    world,
    moveItem: async (serial: number, parent: number) => {
      moves.push(parent);
      Object.assign(world.entities.get(serial) ?? {}, { parent });
    }
  } as unknown as PlayerSession;
  return { world, moves, session, hands: new Hands(session, undefined) };
}

test('an unexpected overload during withdrawal is rolled back before another action', async () => {
  const c = client();
  c.session.refreshStatus = async () => {
    c.world.status.weight = 170;
  };
  expect(await c.hands.do({ verb: 'withdraw', items: [10], amounts: { 10: 250 } }, () => true)).toBe(false);
  expect(c.moves).toEqual([2, 5]);
  expect(c.world.entities.get(10)?.parent).toBe(5);
});

test('cancelling a deposit cannot report successful execution', async () => {
  const c = client();
  Object.assign(c.world.entities.get(10) ?? {}, { parent: 2 });
  let checks = 0;
  expect(await c.hands.do({ verb: 'deposit', items: [10] }, () => ++checks === 1)).toBe(false);
  expect(c.moves).toEqual([]);
});

test('a changed carrying capacity cannot silently turn a reserved recipe batch into a smaller one', async () => {
  const c = client();
  c.world.status.weight = 149;
  expect(await c.hands.do({ verb: 'withdraw', items: [10], amounts: { 10: 250 } }, () => true)).toBe(false);
  expect(c.moves).toEqual([]);
});

test('a sale cannot include the useful weapon excluded from its same-name spare goods', async () => {
  const { Actions } = await import('@gemwright/network/replies');
  const offers = new Map();
  const sold: number[] = [];
  const world = {
    serial: 1,
    position: { x: 10, y: 10, z: 0 },
    entities: new Map<number, object>([
      [2, { serial: 2, kind: 'item', graphic: 3701, parent: 1, layer: 21 }],
      [20, { serial: 20, kind: 'mobile', position: { x: 11, y: 10, z: 0 } }],
      [12, { serial: 12, kind: 'item', graphic: 3937, parent: 2 }],
      [13, { serial: 13, kind: 'item', graphic: 3937, parent: 2 }]
    ]),
    sellOffers: offers
  };
  const session = {
    world,
    context: async () => [{ cliloc: Actions.sell, index: 1, flags: 0 }],
    selectContext: () =>
      offers.set(20, [
        { serial: 12, amount: 1, price: 30 },
        { serial: 13, amount: 1, price: 30 }
      ]),
    sell: async (_vendor: number, items: { serial: number }[]) => sold.push(...items.map((i) => i.serial))
  } as unknown as PlayerSession;
  const hands = new Hands(session, undefined, undefined, (serial) => (serial === 20 ? 'Person' : 'my Longsword'));
  expect(
    await hands.do(
      { verb: 'sell-to', x: 11, y: 10, types: ['Blacksmith'], names: ['Longsword'], except: [12] },
      () => true
    )
  ).toBe(true);
  expect(sold).toEqual([13]);
});
