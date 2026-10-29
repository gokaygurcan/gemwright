import { expect, spyOn, test } from 'bun:test';

import { rejectedSteps, rememberRejectedStep } from '../src/route-memory';
import { behaviorFixture, required } from './behavior-fixture';

const at = { x: 101, y: 100, z: 0 };
let serial = 800000;
function fixture() {
  const f = behaviorFixture();
  f.world.serial = serial++;
  return f;
}

test('first refusal expires in two seconds; repeated or refused-door feedback lasts three minutes', () => {
  let now = 1000000;
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const f = fixture();
    expect(rememberRejectedStep(f.session, f.terrain, at)).toBe(now + 2000);
    expect(rejectedSteps(f.session, f.terrain, at).has('101,100')).toBe(true);
    now += 2001;
    expect(rejectedSteps(f.session, f.terrain, at).size).toBe(0);
    expect(rememberRejectedStep(f.session, f.terrain, at)).toBe(now + 180000);
    now += 180001;
    expect(rejectedSteps(f.session, f.terrain, at).size).toBe(0);
    expect(rememberRejectedStep(f.session, f.terrain, at, true)).toBe(now + 180000);
  } finally {
    clock.mockRestore();
  }
});

test('a changed door graphic, height, removal or new door invalidates remembered refusal immediately', () => {
  for (const change of ['graphic', 'height', 'remove', 'new'] as const) {
    const f = fixture();
    f.world.entities.set(900, { serial: 900, kind: 'item', graphic: 0x675, position: { ...at, direction: 0 } });
    rememberRejectedStep(f.session, f.terrain, at, true);
    expect(rejectedSteps(f.session, f.terrain, at).size).toBe(1);
    if (change === 'graphic') required(f.world.entities.get(900)).graphic++;
    if (change === 'height') required(required(f.world.entities.get(900)).position).z += 5;
    if (change === 'remove') f.world.entities.delete(900);
    if (change === 'new')
      f.world.entities.set(901, { serial: 901, kind: 'item', graphic: 0x675, position: { ...at, direction: 0 } });
    expect(rejectedSteps(f.session, f.terrain, at).size).toBe(0);
  }
});

test('route feedback is scoped by resident, facet, height and visible distance; mobiles do not poison a route', () => {
  const f = fixture();
  rememberRejectedStep(f.session, f.terrain, at);
  const other = fixture();
  expect(rejectedSteps(other.session, other.terrain, at).size).toBe(0);
  f.world.map = 0;
  expect(rejectedSteps(f.session, f.terrain, at).size).toBe(0);
  f.world.map = 1;
  expect(rejectedSteps(f.session, f.terrain, { ...at, z: 20 }).size).toBe(0);
  expect(rejectedSteps(f.session, f.terrain, { ...at, x: 150 }).size).toBe(0);
  f.world.entities.set(902, { serial: 902, kind: 'mobile', graphic: 400, position: { ...at, direction: 0 } });
  expect(rejectedSteps(f.session, f.terrain, at).size).toBe(1);
  f.world.entities.delete(902);
  expect(rejectedSteps(f.session, f.terrain, at).size).toBe(1);
});
