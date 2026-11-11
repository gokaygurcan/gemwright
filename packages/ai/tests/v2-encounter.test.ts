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
  expect(options(f.mind, f.session, undefined, new Set()).some((o) => o.id === 'attack 50')).toBe(false);
  let attacked = false;
  f.session.attack = async () => {
    attacked = true;
  };
  const hands = new Hands(f.session, undefined, undefined, undefined, undefined, undefined, undefined, awareness);
  expect(await hands.do({ verb: 'fight', serial: 50 }, () => true)).toBe(false);
  expect(attacked).toBe(false);
});
