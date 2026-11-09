import { expect, test } from 'bun:test';

import { MovementTrail } from '../../network/src/movement-trail';
import { retraceStep } from '../src/retrace-step';
import { behaviorFixture, required } from './behavior-fixture';

test('retrace verifies the authoritative height before and after reversing an accepted step', async () => {
  const f = behaviorFixture();
  const at = { x: 100, y: 100, z: 24, direction: 6 },
    previous = { ...at, x: 99, z: 22 };
  f.world.position = { ...at };
  Object.defineProperty(f.session, 'movementTrail', { value: new MovementTrail() });
  f.session.movementTrail.record(previous, at, 1);
  let resyncs = 0;
  f.session.resyncPosition = async () => {
    resyncs++;
    return true;
  };
  f.session.walk = async () => {
    f.world.position = { ...previous };
    return true;
  };
  const attempted = new Set<string>();
  expect(
    await retraceStep(
      f.session,
      () => {},
      async () => ({ blocked: false, locked: false }),
      attempted,
      () => {}
    )
  ).toBe(true);
  expect(resyncs).toBe(2);
  expect(f.world.position).toEqual(previous);
});

for (const reason of ['correction', 'locked-door', 'rejected', 'unconfirmed-arrival'] as const)
  test(`retrace stops on ${reason} instead of assuming a remembered stair is still usable`, async () => {
    const f = behaviorFixture();
    const at = { x: 100, y: 100, z: 24, direction: 6 },
      previous = { ...at, x: 99, z: 22 };
    f.world.position = { ...at };
    Object.defineProperty(f.session, 'movementTrail', { value: new MovementTrail() });
    f.session.movementTrail.record(previous, at, 1);
    let walks = 0,
      resyncs = 0;
    f.session.resyncPosition = async () => {
      resyncs++;
      if (reason === 'correction' || (reason === 'unconfirmed-arrival' && resyncs === 2))
        required(f.world.position).z = 0;
      return true;
    };
    f.session.walk = async () => {
      walks++;
      if (reason !== 'rejected') f.world.position = { ...previous };
      return reason !== 'rejected';
    };
    expect(
      await retraceStep(
        f.session,
        () => {},
        async () => ({ blocked: reason === 'locked-door', locked: reason === 'locked-door' }),
        new Set(),
        () => {}
      )
    ).toBe(false);
    if (reason === 'correction' || reason === 'locked-door') expect(walks).toBe(0);
  });
