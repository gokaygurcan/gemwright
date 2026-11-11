import { expect, spyOn, test } from 'bun:test';

import type { PlayerSession } from '@gemwright/network/session';

import { empty } from '../src/v2/beliefs';
import { burden } from '../src/v2/burden';
import { Mind } from '../src/v2/mind';
import * as affordances from '../src/v2/options';
import { choices } from '../src/v2/planning';
import { traitsOf } from '../src/v2/traits';

function alternatives(resources: number, routes: number, needed: number, deficit = 22) {
  const mind = new Mind('r', () => {}, traitsOf([], () => 0.5).traits);
  mind.appraise = () => ({ n: 0, seconds: 1, value: 1, outcome: { ...empty(), gained: { Cargo: needed } } });
  mind.unitWeight = () => 1;
  const session = {
    world: {
      serial: 1,
      position: { x: 0, y: 0, z: 0 },
      status: { weight: 471 + deficit, maxWeight: 471, stamina: 100 },
      entities: new Map()
    }
  } as unknown as PlayerSession;
  let examined = 0;
  const candidates: affordances.Option[] = [{ key: 'work', steps: [], value: undefined }];
  for (let item = 0; item < resources; item++)
    for (let route = 0; route < routes; route++)
      candidates.push({
        key: 'process',
        id: `process ${item} at ${route}`,
        steps: [],
        value: 0,
        seconds: 1,
        frees: 1,
        get consumes() {
          examined++;
          if (examined > candidates.length ** 2 * 2 ** resources)
            throw new Error('Search expanded equivalent disposal routes');
          return [item];
        }
      });
  const options = spyOn(affordances, 'options').mockReturnValue(candidates);
  try {
    const plans = choices(mind, session, undefined, new Set(), { bankers: [], vendors: [] });
    return { plans, examined };
  } finally {
    options.mockRestore();
  }
}

test('disposal routes cannot multiply the relief available from the same carried items', () => {
  const { plans, examined } = alternatives(6, 12, 1);
  expect(plans.some((p) => p.key.endsWith('work'))).toBe(false);
  expect(examined).toBeLessThan(73 ** 2);
});

test('many feasible preparation routes remain independent choices', () => {
  const { plans } = alternatives(7, 4, 7, 0);
  expect(plans).toHaveLength(28);
  expect(plans.every((p) => p.key === 'process')).toBe(true);
});

function loaded() {
  const mind = new Mind('r', () => {}, traitsOf([], () => 0.5).traits);
  const observe = (kind: string, data: object) => mind.observe({ resident: 'r', at: 0, kind, data });
  observe('awake', { serial: 1, self: {} });
  observe('revealed', { serial: 2, kind: 'item', parent: 1, layer: 21, is: ['Backpack'] });
  observe('revealed', { serial: 10, kind: 'item', parent: 2, graphic: 0x19b8, amount: 40, is: ['IronOre'] });
  observe('changed', { serial: 10, properties: [{ cliloc: 1072789, arguments: '160' }] });
  const session = {
    world: {
      serial: 1,
      status: { weight: 493, maxWeight: 471 },
      entities: new Map([
        [2, { serial: 2, kind: 'item', parent: 1, layer: 21 }],
        [10, { serial: 10, kind: 'item', parent: 2, graphic: 0x19b8 }]
      ])
    }
  } as unknown as PlayerSession;
  return { mind, session };
}

test('overload recovery may put down carried raw materials even when work produces the same material', () => {
  const { mind, session } = loaded();
  expect(burden(mind, session, { gained: { IronOre: 1 } })?.drops).toEqual([10]);
});

test('making room cannot discard the item required by the proposed action', () => {
  const { mind, session } = loaded();
  expect(burden(mind, session, { lost: { IronOre: 1 } }, [10])).toBeUndefined();
});

test('live deliberation yields to other residents and can stop before returning a plan', async () => {
  const mind = new Mind('r', () => {}, traitsOf([], () => 0.5).traits);
  const session = { world: { entities: new Map(), serial: 1 } } as unknown as PlayerSession;
  let stopped = false;
  let tick = 0;
  const clock = spyOn(performance, 'now').mockImplementation(() => (tick += 10));
  mind.appraise = () => ({ n: 0, seconds: 1, value: 1, outcome: empty() });
  const options = spyOn(affordances, 'options').mockImplementation(() => {
    queueMicrotask(() => {
      stopped = true;
    });
    return [{ key: 'work', steps: [], value: 1 }];
  });
  try {
    const { liveChoices } = await import('../src/v2/planning');
    expect(
      await liveChoices(mind, session, undefined, new Set(), { bankers: [], vendors: [] }, () => stopped)
    ).toBeUndefined();
    expect(stopped).toBe(true);
  } finally {
    clock.mockRestore();
    options.mockRestore();
  }
});

test('an overweight resident chooses one useful preparation and reassesses', () => {
  const { plans } = alternatives(3, 1, 1, 1);
  expect(plans.map((plan) => plan.key)).toEqual(['process', 'process', 'process']);
});
