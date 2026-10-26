import { expect, test } from 'bun:test';

import { combatPosition, positionScore } from '../src/combat-position';
import { ammoFor, weaponsFor } from '../src/fighter-context';
import { residentNeeds } from '../src/needs';
import { equippedRanged, rangedWeapon, shootingWindow } from '../src/ranged-weapons';
import { behaviorFixture, required } from './behavior-fixture';

for (const [ids, ammo, range] of [
  [[0x13b1, 0x13b2], 0xf3f, 10],
  [[0x26c2, 0x26cc], 0xf3f, 10],
  [[0xf4f, 0xf50], 0x1bfb, 8],
  [[0x13fc, 0x13fd], 0x1bfb, 8],
  [[0x26c3, 0x26cd], 0x1bfb, 7]
] as const) {
  test(`both facings of ranged family ${ids[0].toString(16)} equip and request the right ammunition`, () => {
    const { session, world, checkpoint, template } = behaviorFixture('archer');
    required(template.archetype).primarySkills = ['Archery'];
    for (const graphic of ids) {
      world.entities.set(12, { serial: 12, kind: 'item', graphic, parent: 1, layer: 2 });
      expect(weaponsFor(template).has(graphic)).toBe(true);
      expect(equippedRanged(session)?.serial).toBe(12);
      expect(ammoFor(graphic)).toBe(ammo);
      expect(rangedWeapon(graphic)?.range).toBe(range);
      const needs = residentNeeds(session, checkpoint, template);
      expect(needs.some((need) => need.purchase?.graphics.includes(ammo))).toBe(true);
      expect(needs.some((need) => need.what === (ammo === 0xf3f ? 'bolts' : 'arrows'))).toBe(false);
    }
  });
}

test('weapon timing distinguishes a heavy crossbow and repeating crossbow without assuming unknown weapons use bolts', () => {
  expect(shootingWindow(required(rangedWeapon(0x13fd)), 90)).toBeGreaterThan(
    shootingWindow(required(rangedWeapon(0x26c3)), 90)
  );
  expect(ammoFor(0xf51)).toBeUndefined();
  expect(ammoFor(undefined)).toBeUndefined();
});

test('firing positions reject melee proximity, out-of-range shots and nearby additional threats', () => {
  const origin = { x: 0, y: 0 };
  const target = { x: 6, y: 0 };
  expect(positionScore({ x: 5, y: 0 }, target, [], 7, origin)).toBe(Infinity);
  expect(positionScore({ x: -2, y: 0 }, target, [], 7, origin)).toBe(Infinity);
  expect(
    positionScore(
      origin,
      target,
      [{ serial: 2, kind: 'mobile', graphic: 3, position: { x: 1, y: 0, z: 0, direction: 0 } }],
      7,
      origin
    )
  ).toBe(Infinity);
});

test('a firing position must have a real bounded route and a clear public map ray', async () => {
  const { session, world, terrain } = behaviorFixture();
  const target = { serial: 2, kind: 'mobile' as const, graphic: 3, position: { ...required(world.position), x: 101 } };
  world.entities.set(2, target);
  terrain.pathAsync = async () => null;
  expect(
    await combatPosition({
      session,
      terrain,
      origin: required(world.position),
      target,
      threats: [],
      range: 7,
      check: () => {}
    })
  ).toBeUndefined();
  terrain.pathAsync = async (_from, point) => [{ ...point, z: 0 }];
  const point = await combatPosition({
    session,
    terrain,
    origin: required(world.position),
    target,
    threats: [],
    range: 7,
    check: () => {}
  });
  expect(point).toBeDefined();
  expect(
    Math.max(Math.abs(required(point).x - target.position.x), Math.abs(required(point).y - target.position.y))
  ).toBeGreaterThanOrEqual(3);
  terrain.cell = (x, y) => ({ land: { x, y, z: 0, id: 0 }, statics: [{ x, y, z: 0, id: 1 }] });
  terrain.tile = () => ({ flags: 0x2000, height: 30, layer: 0, name: 'wall' });
  expect(
    await combatPosition({
      session,
      terrain,
      origin: required(world.position),
      target,
      threats: [],
      range: 7,
      check: () => {}
    })
  ).toBeUndefined();
});
