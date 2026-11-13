import { expect, test } from 'bun:test';

import { Hands } from '../src/v2/hands';
import { Mind } from '../src/v2/mind';
import { perceive } from '../src/v2/perceive';
import { traitsOf } from '../src/v2/traits';
import { bankShard } from './fixtures/v2/bank-shard';

test('a thing reached for and not there is no longer believed in, so no plan retries it', async () => {
  const shard = bankShard();
  const mind = new Mind('r', () => {}, traitsOf([], () => 0.5).traits);
  const stop = perceive(shard.session, 'r', (e) => mind.observe(e));
  const where = { x: 10, y: 10, z: 0, map: 1 };
  const event = (kind: string, data: object) => mind.observe({ resident: 'r', at: Date.now(), kind, data, where });
  // Believed from an earlier life: a stack in the bank box and a dagger in the pack, both long gone.
  event('revealed', { serial: 77, graphic: 7154, amount: 40, parent: 5, is: ['IronIngot'] });
  event('revealed', { serial: 78, graphic: 3921, parent: 2, is: ['Dagger'] });
  const hands = new Hands(
    shard.session,
    undefined,
    () => undefined,
    (id) => mind.call(id)
  );
  hands.missing = (serial, from) => event('missing', { serial, where: from });
  try {
    expect(mind.banked(77)).toBe(true);
    expect(await hands.do({ verb: 'withdraw', items: [77] }, () => true)).toBe(false);
    expect(mind.belongings().has(77)).toBe(false);
    expect(await hands.do({ verb: 'equip', serial: 78, layer: 1 }, () => true)).toBe(false);
    expect(mind.belongings().has(78)).toBe(false);
    // What the bank holds stays believed when it is reached for from the pack, out of the box's view.
    event('missing', { serial: 10, where: 'pack' });
    expect(mind.banked(10)).toBe(true);
  } finally {
    stop();
  }
});
