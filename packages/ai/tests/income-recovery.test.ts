import { expect, test } from 'bun:test';

import type { PlayerSession } from '@gemwright/network/session';

import { Mind } from '../src/mind';
import { choices } from '../src/planning';
import { traitsOf } from '../src/traits';
import { seeing } from './fixtures/mind-sync';

test('a miner with no money or tools chooses available safe income rather than another bank visit', () => {
  const mind = new Mind('r', () => {}, traitsOf([], () => 0.5).traits, [], ['Mining']);
  const observe = (kind: string, data: object) => mind.observe({ resident: 'r', at: 0, kind, data });
  observe('awake', { serial: 1, self: { health: { current: 100, max: 100 } }, skills: { Wrestling: 75, Tactics: 75 } });
  observe('heard', { cliloc: 1042759, arguments: '0' });
  observe('seen', { serial: 20, kind: 'mobile', graphic: 39, name: 'a mongbat', is: ['Mongbat'], x: 12, y: 10 });
  const session = {
    world: {
      serial: 1,
      map: 1,
      position: { x: 10, y: 10, z: 0, direction: 2 },
      entities: new Map([
        [20, { serial: 20, kind: 'mobile', graphic: 39, name: 'a mongbat', position: { x: 12, y: 10, z: 0 } }]
      ])
    }
  } as unknown as PlayerSession;
  const plans = choices(seeing(mind, session), undefined, new Set(), {
    bankers: [{ x: 10, y: 10 }],
    vendors: [{ x: 11, y: 10, types: ['Tinker'] }]
  });
  expect(plans[0]?.key).toBe('attack Mongbat');
  expect(plans[0]?.rate).toBeGreaterThan(-1);
  expect(plans.some((o) => o.key === 'check bank balance')).toBe(false);
});
