import { expect, test } from 'bun:test';

import { skillId } from '@gemwright/common/game/skills';

import { Hands } from '../src/v2/hands';
import { Mind } from '../src/v2/mind';
import { options } from '../src/v2/options';
import { traitsOf } from '../src/v2/traits';
import { required } from './behavior-fixture';
import { fighterFixture } from './fighter-fixture';

function encounter() {
  const f = fighterFixture();
  const mind = new Mind('r', () => {}, traitsOf([], () => 0.5).traits);
  required(f.world.status).hits = 100;
  required(f.world.status).maxHits = 100;
  for (const skill of ['Macing', 'Tactics'])
    f.world.skills.set(skillId(skill), { base: 100, value: 100, cap: 100, lock: 0 });
  f.world.put({ serial: 40, kind: 'item', graphic: 5177, parent: 1, layer: 2 });
  f.world.put({
    serial: 50,
    kind: 'mobile',
    graphic: 39,
    name: 'a mongbat',
    notoriety: 3,
    position: { x: 101, y: 100, z: 0, direction: 0 }
  });
  mind.observe({
    resident: 'r',
    at: 0,
    where: { x: 100, y: 100, z: 0, map: 1 },
    kind: 'awake',
    data: { serial: 1, self: { health: { current: 100, max: 100 } }, skills: { Macing: 100, Tactics: 100 } }
  });
  mind.observe({
    resident: 'r',
    at: 1,
    kind: 'seen',
    data: { serial: 50, kind: 'mobile', is: ['Mongbat'], x: 101, y: 100 }
  });
  return { ...f, mind };
}

test('a dangerous group makes an easy target inadmissible to planning and execution', async () => {
  const { Encounter } = await import('../src/v2/encounter');
  const f = encounter();
  const awareness = new Encounter(f.session, f.mind, undefined);
  expect(awareness.allows(50)).toBe(true);
  for (const [serial, graphic, name, x] of [
    [51, 17, 'an orc', 102],
    [52, 28, 'a giant spider', 103],
    [53, 28, 'a giant spider', 104]
  ] as const)
    f.world.put({ serial, kind: 'mobile', graphic, name, notoriety: 3, position: { x, y: 100, z: 0, direction: 0 } });
  f.world.revision++;
  expect(awareness.allows(50)).toBe(false);
  f.mind.encounter = awareness;
  expect(options(f.mind, undefined, new Set()).some((o) => o.id === 'attack 50')).toBe(false);
  let attacked = false;
  f.session.attack = async () => {
    attacked = true;
  };
  const hands = new Hands(f.session, undefined, undefined, undefined, undefined, undefined, undefined, awareness);
  expect(await hands.do({ verb: 'fight', serial: 50 }, () => true)).toBe(false);
  expect(attacked).toBe(false);
});

// Whom it is in danger from is who is fighting it, weighed together against its health and strength.
function crowd(f: ReturnType<typeof encounter>, graphic: number, name: string, is: string, count: number) {
  for (let i = 0; i < count; i++) {
    const serial = 60 + i;
    f.world.put({
      serial,
      kind: 'mobile',
      graphic,
      name,
      notoriety: 3,
      position: { x: 103 + i, y: 103, z: 0, direction: 0 }
    });
    f.mind.observe({
      resident: 'r',
      at: 2,
      kind: 'seen',
      data: { serial, kind: 'mobile', is: [is], x: 103 + i, y: 103 }
    });
  }
  f.world.revision++;
}
function strikes(f: ReturnType<typeof encounter>, serials: number[], amount: number) {
  for (const serial of serials) {
    f.mind.observe({ resident: 'r', at: 3, kind: 'animated', data: { serial, type: 0, action: 0 } });
    f.mind.observe({ resident: 'r', at: 3, kind: 'damage', data: { key: 1, value: { amount } } });
  }
}

test('creatures that only stand about are no danger, however many and however strong', async () => {
  const { Encounter } = await import('../src/v2/encounter');
  const f = encounter();
  crowd(f, 24, 'a lich', 'Lich', 10);
  expect(new Encounter(f.session, f.mind, undefined).needsEscape()).toBe(false);
});

test('a few weak attackers are fought out at good health, and the same strong ones are fled', async () => {
  const { Encounter } = await import('../src/v2/encounter');
  const weak = encounter();
  crowd(weak, 3, 'a zombie', 'Zombie', 3);
  strikes(weak, [60, 61, 62], 3);
  expect(new Encounter(weak.session, weak.mind, undefined).needsEscape()).toBe(false);
  const strong = encounter();
  crowd(strong, 24, 'a lich', 'Lich', 3);
  strikes(strong, [60, 61, 62], 20);
  expect(new Encounter(strong.session, strong.mind, undefined).needsEscape()).toBe(true);
});

test('a ghost walks through ground a living body would keep clear of: nothing can harm the dead', async () => {
  const { Encounter } = await import('../src/v2/encounter');
  const f = encounter();
  for (const [serial, graphic, name, x] of [
    [51, 17, 'an orc', 102],
    [52, 28, 'a giant spider', 103],
    [53, 28, 'a giant spider', 104]
  ] as const)
    f.world.put({ serial, kind: 'mobile', graphic, name, notoriety: 3, position: { x, y: 100, z: 0, direction: 0 } });
  f.world.revision++;
  const awareness = new Encounter(f.session, f.mind, undefined);
  expect(awareness.blocked().size).toBeGreaterThan(0);
  required(f.world.entities.get(1)).graphic = 403;
  f.world.revision++;
  expect(awareness.blocked().size).toBe(0);
});

// On foot nothing is outrun (ServUO: a running player and these creatures both take 0.2 seconds a
// step): it runs only when a guarded town is near enough that the way there costs less than the
// fight, and otherwise turns on the one it puts down soonest.
test('in danger it runs for a near town, and with none near it fights back', async () => {
  const { Encounter } = await import('../src/v2/encounter');
  const far = encounter();
  crowd(far, 24, 'a lich', 'Lich', 3);
  strikes(far, [60, 61, 62], 20);
  const cornered = new Encounter(far.session, far.mind, undefined);
  cornered.havens = [{ x: 900, y: 100 }];
  expect(cornered.needsEscape()).toBe(true);
  expect(cornered.response()?.steps[0]).toMatchObject({ verb: 'fight', back: true });
  const near = encounter();
  crowd(near, 24, 'a lich', 'Lich', 3);
  strikes(near, [60, 61, 62], 20);
  const home = new Encounter(near.session, near.mind, undefined);
  home.havens = [{ x: 98, y: 100 }];
  expect(home.response()?.steps[0]).toEqual({ verb: 'escape', to: { x: 98, y: 100 } });
});
