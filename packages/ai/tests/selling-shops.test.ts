import { expect, test } from 'bun:test';

import { TileFlag } from '@gemwright/common/assets/tiledata';
import type { PlayerSession } from '@gemwright/network/session';

// selling.ts sits in an import cycle through craft-training and skill-training; loading
// skill-training first initializes it in the order the service does.
import '../src/skill-training';
import { notePrices, noteVendorKind } from '../src/price-book';
import { sellingTurn, shopsFor } from '../src/selling';
import { behaviorFixture } from './behavior-fixture';

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

test('a piece listed for sale that no shop buys is left behind on the second trip, not carried forever', async () => {
  const f = behaviorFixture('swordsman');
  f.terrain.tile = () => ({ flags: TileFlag.Wearable, height: 0, layer: 1, name: 'longsword' }) as never;
  f.world.entities.set(50, { serial: 50, kind: 'item', graphic: 0xf61, parent: 10, amount: 1, properties: [] });
  f.checkpoint.forSale = [50, 99];
  const dropped: number[] = [];
  Object.assign(f.session, {
    inspectProperties: async () => {},
    dropAtFeet: async (serial: number) => {
      dropped.push(serial);
      f.world.entities.delete(serial);
    }
  });
  const sellCtx = {
    ...f.ctx,
    // Every shop is out of reach or refuses: the piece comes back unsold.
    navigate: async () => {
      throw new Error('No walkable route');
    },
    backpack: () => 10,
    carried: (pack: number) => f.world.childrenOf(pack),
    status: () => f.world.status
  } as unknown as Parameters<typeof sellingTurn>[0];
  await sellingTurn(sellCtx, true);
  expect(dropped).toEqual([]);
  expect(f.checkpoint.forSale).toEqual([50]);
  await sellingTurn(sellCtx, true);
  expect(dropped).toEqual([50]);
  expect(f.checkpoint.forSale).toEqual([]);
});
