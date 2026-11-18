import { expect, test } from 'bun:test';

import { Layer } from '@gemwright/network/layers';
import type { PlayerSession } from '@gemwright/network/session';
import { WorldView } from '@gemwright/network/world';

import { Mind } from '../src/mind';
import { perceive } from '../src/perceive';
import { traitsOf } from '../src/traits';
import { containerContents, loginConfirm, mobileIncoming } from './fixtures/shard-packets';

const login = () => {
  const world = new WorldView();
  world.apply(loginConfirm(1, 10, 10, 0, 2));
  world.apply(
    mobileIncoming(1, 400, 10, 10, 0, 2, [
      { serial: 2, graphic: 3701, layer: Layer.Backpack },
      { serial: 5, graphic: 3701, layer: Layer.Bank }
    ])
  );
  return { world, session: { world, phase: 'ready' } as unknown as PlayerSession };
};

test('a remembered bank item missing from the opened bank box is forgotten', () => {
  const first = login();
  const mind = new Mind('r', () => {}, traitsOf([], () => 0.5).traits);
  let stop = perceive(first.session, 'r', (e) => mind.observe(e));
  first.world.apply(
    containerContents(
      [
        { serial: 10, graphic: 7154, amount: 1 },
        { serial: 11, graphic: 7154, amount: 50 }
      ],
      5
    )
  );
  stop();
  expect(mind.banked(10)).toBe(true);

  const next = login();
  stop = perceive(next.session, 'r', (e) => mind.observe(e));
  expect(mind.banked(10)).toBe(true);
  next.world.apply(containerContents([{ serial: 11, graphic: 7154, amount: 51 }], 5));
  stop();
  expect(mind.banked(11)).toBe(true);
  expect(mind.banked(10)).toBe(false);
  expect(mind.belongings().has(10)).toBe(false);
});
