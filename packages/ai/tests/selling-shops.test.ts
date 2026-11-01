import { expect, test } from 'bun:test';

import { TileFlag } from '@gemwright/common/assets/tiledata';
import type { PlayerSession } from '@gemwright/network/session';

// selling.ts sits in an import cycle through craft-training and skill-training; loading
// skill-training first initializes it in the order the service does.
import '../src/skill-training';
import { notePrices, noteVendorKind } from '../src/price-book';
import { shopsFor } from '../src/selling';

const tiles = new Map([
  [0x1f03, { name: 'robe', layer: 22 }],
  [0x1415, { name: 'plate chest', layer: 13 }],
  [0x144f, { name: 'bone armor', layer: 13 }]
]);
const ctx = {
  terrain: { tile: (graphic: number) => ({ ...tiles.get(graphic), flags: TileFlag.Wearable }) }
} as unknown as Parameters<typeof shopsFor>[0];
const item = (graphic: number) => ({ serial: graphic, kind: 'item' as const, graphic });

test('an unfit piece goes to the shops seen paying for it, else to the shop its kind belongs to', () => {
  expect(shopsFor(ctx, item(0x1f03))).toEqual(['tailor']);
  expect(shopsFor(ctx, item(0x1415))).toEqual(['blacksmith']);
  expect(shopsFor(ctx, item(0x144f))).toEqual(['blacksmith']);
  const session = {
    world: { entities: new Map([[7, { position: { x: 1, y: 1, z: 0 } }]]) }
  } as unknown as PlayerSession;
  notePrices(session, 7, 'pays', [{ graphic: 0x1415, price: 40 }]);
  noteVendorKind(7, 'weaponsmith');
  expect(shopsFor(ctx, item(0x1415))).toEqual(['weaponsmith']);
});
