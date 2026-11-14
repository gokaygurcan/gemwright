import { expect, spyOn, test } from 'bun:test';

import { Mind } from '../src/v2/mind';
import * as affordances from '../src/v2/options';
import { choices } from '../src/v2/planning';
import { traitsOf } from '../src/v2/traits';

// One of a kind in view that it cannot fight where it is (out of reach, not admitted) leaves going
// after that kind elsewhere as it was: what it may do does not blink with what passes the screen.
const deliberating = (attackable: boolean) => {
  const mind = new Mind('r', () => {}, traitsOf([], () => 0.5).traits);
  const where = { x: 100, y: 100, z: 0, map: 1 };
  mind.observe({ resident: 'r', at: 1, kind: 'awake', data: { serial: 1, self: {}, skills: {} }, where });
  const offered = spyOn(affordances, 'options').mockImplementation(() =>
    attackable ? [{ key: 'attack Mongbat', id: 'attack 9', steps: [{ verb: 'fight', serial: 9 }] }] : []
  );
  const journeys = spyOn(mind, 'journeys').mockImplementation(function* () {
    yield {
      key: 'attack Mongbat',
      where: { x: 140, y: 100, z: 0, map: 1 },
      walk: 20,
      chance: 1,
      expected: {}
    } as never;
  });
  const sights = spyOn(mind, 'sights').mockImplementation(() => [{ serial: 9, kind: 'mobile' }] as never);
  const call = spyOn(mind, 'call').mockImplementation(() => 'Mongbat');
  try {
    return [...choices(mind, undefined, new Set(), { bankers: [], vendors: [] })].map((option) => option.key);
  } finally {
    for (const spy of [offered, journeys, sights, call]) spy.mockRestore();
  }
};

test('a creature in view it cannot fight leaves seeking its kind elsewhere as it was', () => {
  expect(deliberating(false)).toContain('go 140,100: attack Mongbat');
  expect(deliberating(true)).not.toContain('go 140,100: attack Mongbat');
});
