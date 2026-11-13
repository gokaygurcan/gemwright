import { expect, test } from 'bun:test';

import { empty } from '../src/v2/beliefs';
import { Mind } from '../src/v2/mind';
import { Things } from '../src/v2/things';
import { traitsOf } from '../src/v2/traits';

const event = (kind: string, data: object) => ({ resident: 'r', at: 0, kind, data });
function possessions() {
  const things = new Things();
  things.wake(1);
  for (const [serial, parent, layer, name] of [
    [2, 1, 21, 'Backpack'],
    [5, 1, 29, 'BankBox'],
    [10, 5, 0, 'IronIngot']
  ] as const)
    things.observe(
      event('revealed', { serial, parent, layer, is: [name], amount: serial === 10 ? 43 : 1 }),
      undefined,
      undefined
    );
  return things;
}

test('bank to pack to bank transfers retain ownership without manufacturing gains or losses', () => {
  const things = possessions();
  const outcome = empty();
  for (const parent of [2, 5, 2, 5, 2]) {
    things.lift(10, 43);
    things.observe(event('changed', { serial: 10, parent }), outcome, undefined);
    expect(things.owned.get(10)).toEqual({ name: 'IronIngot', amount: 43 });
    expect(things.inBank(10)).toBe(parent === 5);
  }
  expect(outcome.gained).toEqual({});
  expect(outcome.lost).toEqual({});
});

test('partial withdrawal and return conserve both stacks and their locations', () => {
  const things = possessions();
  const outcome = empty();
  things.lift(10, 3);
  things.observe(event('revealed', { serial: 11, parent: 5, is: ['IronIngot'], amount: 40 }), outcome, undefined);
  things.observe(event('changed', { serial: 10, parent: 2, amount: 3 }), outcome, undefined);
  expect(things.owned.get(10)?.amount).toBe(3);
  expect(things.owned.get(11)?.amount).toBe(40);
  expect(things.rest).toBeUndefined();
  expect(outcome.gained).toEqual({});
  expect(outcome.lost).toEqual({});
});

test('stored assets do not increase the cost of dying while earning money', () => {
  const make = (banked: boolean) => {
    const mind = new Mind('r', () => {}, traitsOf([], () => 0.5).traits, [], ['Mining']);
    mind.observe(
      event('awake', {
        serial: 1,
        self: { health: { current: 100, max: 100 } },
        skills: { Wrestling: 75, Tactics: 75 }
      })
    );
    mind.observe(event('revealed', { serial: 5, parent: 1, layer: 29, is: ['BankBox'] }));
    if (banked) mind.observe(event('revealed', { serial: 10, parent: 5, is: ['Gold'], amount: 100000 }));
    return mind.appraise('attack Mongbat', { ...empty(), gained: { Gold: 25 }, died: 0.01, seconds: 5 })?.value;
  };
  expect(make(true)).toBe(make(false));
});

test('confirmed guard protection removes the invented death prior, but leaving protection restores caution', () => {
  const mind = new Mind('r', () => {}, traitsOf([], () => 0.5).traits);
  mind.observe(event('awake', { serial: 1, self: {} }));
  mind.observe(event('gained', { serial: 10, parent: 2, is: ['Gold'], amount: 1000 }));
  const unknown = mind.deposit([10]);
  mind.observe(event('heard', { cliloc: 500112 }));
  expect(mind.deposit([10])).toBe(0);
  mind.observe(event('heard', { cliloc: 500113 }));
  expect(mind.deposit([10])).toBe(unknown);
});

test('guard protection does not erase the modeled risk of the next fight', () => {
  const mind = new Mind('r', () => {}, traitsOf([], () => 0.5).traits);
  mind.observe(event('awake', { serial: 1, self: {} }));
  mind.observe(event('gained', { serial: 10, parent: 2, is: ['Gold'], amount: 1000 }));
  mind.observe(event('heard', { cliloc: 500112 }));
  expect(mind.deposit([10], 0.2)).toBeGreaterThan(0);
  expect(mind.deposit([10], 0.2)).toBeLessThan(mind.deposit([10], 0.8));
});

test('depositing materials does not invalidate an observed gold balance', () => {
  const mind = new Mind('r', () => {}, traitsOf([], () => 0.5).traits);
  mind.observe(event('awake', { serial: 1, self: {} }));
  mind.observe(event('revealed', { serial: 5, parent: 1, layer: 29, is: ['BankBox'] }));
  mind.observe(event('gained', { serial: 10, parent: 2, is: ['IronOre'], amount: 10 }));
  mind.observe(event('heard', { cliloc: 1042759, arguments: '0' }));
  mind.observe(event('acted', { verb: 'pick-up', serial: 10, amount: 10 }));
  mind.observe(event('acted', { verb: 'drop', serial: 10, container: 5 }));
  expect(mind.bankGold).toBe(0);
});
