import { expect, test } from 'bun:test';

import type { PlayerSession } from '@gemwright/network/session';

import { burden } from '../src/burden';
import type { HistoryEvent } from '../src/history';
import { Mind } from '../src/mind';
import { traitsOf } from '../src/traits';
import { seeing } from './fixtures/mind-sync';

const traits = traitsOf([], () => 0.5).traits;
const event = (at: number, kind: string, data: object): HistoryEvent => ({ resident: 'r', at, kind, data });
const pack = (weight: number) => {
  const mind = new Mind('r', () => {}, traits);
  mind.observe(event(0, 'awake', { serial: 1, self: {} }));
  mind.observe(
    event(0, 'revealed', { serial: 2, kind: 'item', graphic: 3701, layer: 21, parent: 1, is: ['Backpack'] })
  );
  // Twelve logs (twelve stones, a coin each); and a hovered pile of iron ore, telling what ore weighs.
  mind.observe(event(0, 'revealed', { serial: 7, kind: 'item', graphic: 7133, amount: 12, parent: 2, is: ['Log'] }));
  mind.observe(event(0, 'changed', { serial: 7, properties: [{ cliloc: 1072789, arguments: '12' }], is: ['Log'] }));
  mind.observe(
    event(0, 'revealed', { serial: 8, kind: 'item', graphic: 6584, amount: 10, parent: 2, is: ['IronOre'] })
  );
  mind.observe(
    event(0, 'changed', { serial: 8, properties: [{ cliloc: 1072789, arguments: '120' }], is: ['IronOre'] })
  );
  const session = {
    world: {
      serial: 1,
      status: { weight, maxWeight: 300 },
      entities: new Map<number, object>([
        [2, { serial: 2, kind: 'item', graphic: 3701, parent: 1, layer: 21 }],
        [7, { serial: 7, kind: 'item', graphic: 7133, parent: 2 }],
        [8, { serial: 8, kind: 'item', graphic: 6584, parent: 2 }]
      ])
    }
  } as unknown as PlayerSession;
  return { mind, session };
};

// Room to spare: picking up ore weighs on nothing.
test('what fits in the pack costs nothing to carry', () => {
  const { mind, session } = pack(100);
  expect(burden(seeing(mind, session), { gained: { IronOre: 1 } })).toEqual({ cost: 0, drops: [] });
});

// 299 of 300 stones and a pile of ore to pick up: over its strength it would tire with every step, so
// it puts down what is worth least for its weight (the firewood) to make room, at what that is worth.
test('a pick-up that would overload it makes room by dropping what is worth least for its weight', () => {
  const { mind, session } = pack(299);
  const carried = burden(seeing(mind, session), { gained: { IronOre: 1 } });
  expect(carried?.drops).toEqual([7]);
  expect(carried?.cost).toBe(mind.cost(12));
});
