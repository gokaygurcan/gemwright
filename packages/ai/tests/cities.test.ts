import { afterEach, expect, test } from 'bun:test';

import { Blocked } from '../src/blocked';
import { groundFits, grounds } from '../src/cemeteries';
import type { FighterContext } from '../src/fighter-context';
import { travelByMoongate } from '../src/moongate';
import { tamingSpot } from '../src/tamer-grounds';
import { useCities } from '../src/world';
import { behaviorFixture } from './behavior-fixture';
import { useTestWorld } from './world-fixture';

useTestWorld();
afterEach(() => useCities());

test('only cities the shard names are allowed, and a name it does not know is refused with the choices', () => {
  expect(() => useCities(['Britain', 'Atlantis'])).toThrow(/ai\.cities names unknown cities: Atlantis.*Minoc/);
});

test('a ground by a city the shard keeps residents out of is no ground for them', () => {
  const trinsic = grounds.find((g) => g.center.x === 1830 && g.center.y === 2986);
  const fighter = {
    serial: 1,
    status: () => ({ maxHits: 100, armor: 30, hits: 100 }),
    template: { archetype: { primarySkills: ['Mace Fighting'], supportingSkills: [] }, behavior: {} },
    session: { world: { childrenOf: () => [{ layer: 1, graphic: 0x13b4 }], skills: new Map([[41, { value: 60 }]]) } }
  } as unknown as FighterContext;
  expect(trinsic && groundFits(fighter, trinsic)).toBe(true);
  useCities(['Britain', 'Minoc', 'New Haven']);
  expect(trinsic && groundFits(fighter, trinsic)).toBe(false);
});

test('no moongate trip leads into a city the shard keeps residents out of', async () => {
  useCities(['Britain', 'Minoc', 'New Haven']);
  const f = behaviorFixture();
  const trip = travelByMoongate(
    { session: f.session, position: () => f.ctx.position(), navigate: f.ctx.navigate as never, phase: () => {} },
    'trinsic'
  );
  await expect(trip).rejects.toBeInstanceOf(Blocked);
});

test('a tamer looks for animals only around the cities the shard allows', () => {
  useCities(['Britain', 'Minoc', 'New Haven']);
  for (let me = 100; me < 120; me++) {
    const spot = tamingSpot(me, { x: 1700, y: 2300 }, 30);
    expect(spot && Math.abs(spot.x - 1900) < 100 && Math.abs(spot.y - 2700) < 100).toBeFalsy();
  }
});
