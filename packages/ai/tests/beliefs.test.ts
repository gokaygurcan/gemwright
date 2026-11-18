import { expect, test } from 'bun:test';

import { Beliefs, empty, type Outcome } from '../src/beliefs';

const worth = (o: Outcome) => 10 * o.killed - 100 * o.died;

// Fights at full health ended in kills and fights at a fifth of it in death: its health earns its
// weight by predicting that, and then decides what it expects; how laden it was never did.
test('a part of the situation counts once it has made predictions better', () => {
  const beliefs = new Beliefs();
  for (let i = 0; i < 6; i++) {
    const carried = i % 3;
    beliefs.learn('attack Ogre', { health: 1, carried }, { ...empty(), killed: 1 }, worth);
    beliefs.learn('attack Ogre', { health: 0.2, carried }, { ...empty(), died: 1 }, worth);
  }
  expect(beliefs.weight('health')).toBeGreaterThan(beliefs.weight('carried'));
  const low = beliefs.expect('attack Ogre', { health: 0.25, carried: 1 }).outcome?.died ?? 0;
  const high = beliefs.expect('attack Ogre', { health: 0.95, carried: 1 }).outcome?.died ?? 1;
  expect([low > 0.8, high < 0.2]).toEqual([true, true]);
});
