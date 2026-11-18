import { expect, test } from 'bun:test';

import { Mind } from '../src/mind';
import { options } from '../src/options';
import { choices } from '../src/planning';
import { traitsOf } from '../src/traits';

const where = { x: 10, y: 10, z: 0, map: 1 };
function resident() {
  const mind = new Mind('ports', () => {}, traitsOf([], () => 0.5).traits, [], ['Mining'], ['ArmsLore']);
  const see = (kind: string, data: object, at = Date.now()) =>
    mind.observe({ resident: 'ports', at, where, kind, data });
  see('awake', {
    serial: 1,
    self: { health: { current: 100, max: 100 }, weight: { current: 20, max: 150 } },
    skills: { Mining: 60, ArmsLore: 20 }
  });
  see('revealed', { serial: 2, kind: 'item', graphic: 3701, parent: 1, layer: 21, is: ['Backpack'] });
  see('revealed', {
    serial: 3,
    kind: 'item',
    graphic: 3718,
    parent: 2,
    is: ['Pickaxe'],
    properties: [{ cliloc: 1072789, arguments: '5' }]
  });
  return { mind, see };
}
const places = { bankers: [{ x: 10, y: 10 }], vendors: [] };
const offered = (mind: Mind) => options(mind, undefined, new Set(), places.bankers);

test('raised residents recover their own corpse before work, including worthless belongings', () => {
  const { mind, see } = resident();
  see('died', {});
  see('seen', { serial: 40, kind: 'item', graphic: 8198, x: 10, y: 10, z: 0, is: ['Corpse'] });
  see('self', { health: { current: 100, max: 100 } });
  expect(choices(mind, undefined, new Set(), places)[0]?.key).toBe('recover my corpse');
});

test('after resurrection a resident without healing supplies rests before working', () => {
  const { mind, see } = resident();
  see('died', {});
  see('self', { health: { current: 10, max: 100 } });
  expect(choices(mind, undefined, new Set(), places)[0]).toMatchObject({
    key: 'mend after death',
    urgent: true,
    steps: [{ verb: 'rest' }]
  });
});

test('repeated deaths offer physically stuck help instead of another death loop', () => {
  const { mind, see } = resident();
  for (let i = 0; i < 3; i++) see('died', {}, Date.now() - i * 1000);
  expect(offered(mind).some((o) => o.key === 'ask for stuck help')).toBe(true);
});

test('a full bank counts nested things and offers clearing room before deposits', () => {
  const { mind, see } = resident();
  see('revealed', { serial: 5, kind: 'item', graphic: 2475, parent: 1, layer: 29, is: ['BankBox'] });
  see('revealed', { serial: 6, kind: 'item', graphic: 3701, parent: 5, is: ['Bag'] });
  for (let i = 0; i < 124; i++)
    see('revealed', {
      serial: 100 + i,
      kind: 'item',
      graphic: 3934,
      parent: 6,
      is: ['Broadsword'],
      properties: [{ cliloc: 1072789, arguments: '5' }]
    });
  see('revealed', { serial: 9, kind: 'item', graphic: 3821, amount: 100, parent: 2, is: ['Gold'] });
  const found = offered(mind);
  expect(found.some((o) => o.key === 'clear bank room')).toBe(true);
  expect(found.some((o) => o.key === 'deposit')).toBe(false);
});

test('loose gold within reach offers a carryable pickup', () => {
  const { mind, see } = resident();
  see('seen', {
    serial: 10,
    kind: 'item',
    graphic: 3821,
    amount: 100,
    x: 11,
    y: 10,
    z: 0,
    flags: 32,
    is: ['Gold'],
    properties: [{ cliloc: 1072789, arguments: '2' }]
  });
  expect(offered(mind).some((o) => o.steps.some((s) => s.verb === 'pickup'))).toBe(true);
});

test('guarded residents call guards for a nearby criminal', () => {
  const { mind, see } = resident();
  mind.guarded = true;
  see('seen', { serial: 20, kind: 'mobile', graphic: 400, x: 11, y: 10, z: 0, notoriety: 4, is: ['Person'] });
  expect(offered(mind).some((o) => o.key === 'call guards')).toBe(true);
});

test('a previously ridden missing mount is claimed at a trainer', () => {
  const { mind, see } = resident();
  see('revealed', { serial: 30, kind: 'item', graphic: 16034, parent: 1, layer: 25, is: ['Mount'] });
  see('lost', { serial: 30 });
  see('self', { followers: { current: 0, max: 5 } });
  see('seen', { serial: 20, kind: 'mobile', graphic: 400, x: 11, y: 10, z: 0, is: ['AnimalTrainer'] });
  expect(offered(mind).some((o) => o.key === 'claim missing mount')).toBe(true);
});

test('a miner can practise supporting Arms Lore on a pickaxe', () => {
  const { mind } = resident();
  expect(offered(mind).some((o) => o.key === 'practise ArmsLore')).toBe(true);
});

test('a spare trade tool goes into the bank as insurance', () => {
  const { mind, see } = resident();
  see('revealed', { serial: 4, kind: 'item', graphic: 3718, parent: 2, is: ['Pickaxe'] });
  expect(offered(mind).some((o) => o.key === 'store spare tool')).toBe(true);
});

test('a failed destination is shared between minds and distinguishes facets', () => {
  const { see } = resident();
  see('route-failed', { from: where, goal: { x: 50, y: 50, z: 0 }, until: Date.now() + 60_000 });
  const other = resident().mind;
  expect(other.reachable({ x: 50, y: 50, z: 0 })).toBe(false);
  expect(other.reachable({ x: 50, y: 50, z: 5 })).toBe(false);
  other.observe({ resident: 'ports', at: Date.now(), where: { ...where, map: 0 }, kind: 'self', data: {} });
  expect(other.reachable({ x: 50, y: 50, z: 0 })).toBe(true);
});

test('banked insurance is fetched when the carried trade tool is lost', () => {
  const { mind, see } = resident();
  see('revealed', { serial: 5, kind: 'item', graphic: 2475, parent: 1, layer: 29, is: ['BankBox'] });
  see('revealed', {
    serial: 4,
    kind: 'item',
    graphic: 3718,
    parent: 5,
    is: ['Pickaxe'],
    properties: [{ cliloc: 1072789, arguments: '5' }]
  });
  see('lost', { serial: 3 });
  expect(offered(mind).find((o) => o.key === 'retrieve spare tool')?.steps).toContainEqual({
    verb: 'withdraw',
    items: [4]
  });
});

test('supporting practice stops at its skill cap or when the skill is locked', () => {
  const { mind, see } = resident();
  see('skill', { skill: 'ArmsLore', value: 20, base: 20, cap: 20, lock: 0 });
  expect(offered(mind).some((o) => o.key === 'practise ArmsLore')).toBe(false);
  see('skill', { skill: 'ArmsLore', value: 20, base: 20, cap: 100, lock: 2 });
  expect(offered(mind).some((o) => o.key === 'practise ArmsLore')).toBe(false);
});
