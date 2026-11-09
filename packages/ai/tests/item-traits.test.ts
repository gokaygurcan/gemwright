import { expect, test } from 'bun:test';

import type { Entity } from '@gemwright/network/world';

import { shopSafe, shopTakes, traits } from '../src/item-quality';
import { newbiedHeard } from '../src/vendor-trade';

const item = (...clilocs: number[]) =>
  ({
    serial: 1,
    kind: 'item',
    graphic: 0x13b9,
    properties: clilocs.map((cliloc) => ({ cliloc, arguments: '' }))
  }) as Entity;

test('loot type, insurance, item power and quality are separate facts of one piece', () => {
  // Cursed, insured, greater artifact (ItemPower 6: 1151488 + 5), exceptional.
  expect(traits(item(1049643, 1061682, 1151493, 1060636))).toEqual({
    lootType: 'cursed',
    insured: true,
    power: 'artifact',
    exceptional: true
  });
  // An insured lesser magic piece (ItemPower 2) is still magic.
  expect(traits(item(1061682, 1151489))?.power).toBe('magic');
  expect(traits(item(1061682, 1151489))?.insured).toBe(true);
  expect(traits({ serial: 2, kind: 'item', graphic: 1 } as Entity)).toBeUndefined();
});

// Magic and artifact loot is sold like any other: nothing else on the shard pays for it, and kept it
// only filled the bank. Blessed, cursed and insured pieces stay.
test('a shop takes any regular, uninsured piece, magic and artifacts included', () => {
  expect(shopSafe(item())).toBe(true);
  expect(shopTakes(item(1060636))).toBe(true);
  expect(shopSafe(item(1060636))).toBe(false);
  for (const power of [item(1151489), item(1151493), item(1061078)]) {
    expect(shopTakes(power)).toBe(true);
    expect(shopSafe(power)).toBe(true);
  }
  for (const marked of [item(1038021), item(1049643), item(1061682)]) expect(shopTakes(marked)).toBe(false);
});

test("a vendor's answer proves which pieces are newbied; a silent one proves nothing", () => {
  const asked = [1, 2].map((serial) => ({ serial, kind: 'item', graphic: 0x13b4 }) as Entity);
  expect(newbiedHeard(asked, { offers: [{ serial: 1 }] })).toEqual({ listed: [1], newbied: [2] });
  expect(newbiedHeard(asked, { why: 'no-list' })).toEqual({ listed: [], newbied: [1, 2] });
  for (const why of ['busy', 'no-reply', 'no-entry'])
    expect(newbiedHeard(asked, { why })).toEqual({ listed: [], newbied: [] });
});

// A magic piece is worth what a shop pays for it: counted at five times that, carried loot looked
// like a fortune at risk and sent residents to the bank.
test('carried magic and artifact loot counts at its shop price', async () => {
  const { selfNow } = await import('../src/self');
  const { behaviorFixture } = await import('./behavior-fixture');
  const value = (...clilocs: number[]) => {
    const f = behaviorFixture();
    f.world.entities.set(70, {
      serial: 70,
      kind: 'item',
      graphic: 0x13b9,
      parent: 10,
      properties: clilocs.map((cliloc) => ({ cliloc, arguments: '' }))
    });
    return selfNow(f.session, f.checkpoint, f.template).carried.securable;
  };
  expect(value(1151489)).toBe(value());
  expect(value(1151493)).toBe(value());
});
