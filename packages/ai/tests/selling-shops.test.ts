import { expect, test } from 'bun:test';

import { TileFlag } from '@gemwright/common/assets/tiledata';

// selling.ts sits in an import cycle through craft-training and skill-training; loading
// skill-training first initializes it in the order the service does.
import '../src/skill-training';
import { registerCheckpoint } from '../src/gm';
import { noteListed } from '../src/item-quality';
import { townAt } from '../src/locations';
import { putDown } from '../src/overload';
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

test('an unfit piece goes only to the trades whose vendor lists buy it, never by its look', () => {
  expect(shopsFor(ctx, item(0x1f03))).toEqual(['tailor']);
  expect(shopsFor(ctx, item(0x1415))).toEqual(['blacksmith']);
  expect(shopsFor(ctx, item(0xf61)).sort()).toEqual(['blacksmith', 'weaponsmith']);
});

function sellingFixture(properties: { cliloc: number; arguments: string }[] = []) {
  const f = behaviorFixture('swordsman');
  f.terrain.tile = () => ({ flags: TileFlag.Wearable, height: 0, layer: 1, name: 'longsword' }) as never;
  f.world.entities.set(50, { serial: 50, kind: 'item', graphic: 0xf61, parent: 10, amount: 1, properties });
  const dropped: number[] = [];
  const walks: { x: number; y: number }[] = [];
  Object.assign(f.session, {
    inspectProperties: async () => {},
    dropAtFeet: async (serial: number) => {
      dropped.push(serial);
      f.world.entities.delete(serial);
    }
  });
  const sellCtx = {
    ...f.ctx,
    // Every shop here refuses or cannot be reached: the piece comes back unsold.
    navigate: async (point: { x: number; y: number }) => {
      walks.push(point);
      throw new Error('No walkable route');
    },
    backpack: () => 10,
    carried: (pack: number) => f.world.childrenOf(pack),
    status: () => f.world.status
  } as unknown as Parameters<typeof sellingTurn>[0];
  return { f, dropped, walks, sellCtx };
}

test('a piece a vendor here listed and did not buy is put down on the same trip, never taken to another town', async () => {
  const { f, dropped, walks, sellCtx } = sellingFixture();
  f.checkpoint.forSale = [50];
  noteListed(f.session, [50]);
  await sellingTurn(sellCtx, true);
  expect(dropped).toEqual([50]);
  expect(f.checkpoint.forSale).toEqual([]);
  expect(new Set(walks.map((point) => townAt(point, 'outside'))).size).toBeLessThanOrEqual(1);
});

test('a piece no vendor proved regular stays in the pack; a newbied one is never put down or sold', async () => {
  const unproven = sellingFixture();
  unproven.f.checkpoint.forSale = [50];
  await sellingTurn(unproven.sellCtx, true);
  expect(unproven.dropped).toEqual([]);
  const newbied = sellingFixture();
  registerCheckpoint(newbied.f.session, newbied.f.checkpoint);
  newbied.f.checkpoint.newbied = [50];
  newbied.f.checkpoint.forSale = [50];
  expect(await sellingTurn(newbied.sellCtx, true)).toBe(false);
  expect(newbied.walks).toEqual([]);
  expect(newbied.dropped).toEqual([]);
  expect(newbied.f.checkpoint.forSale).toEqual([]);
  expect(await putDown(newbied.f.session, 50)).toBe(false);
});

test('a blessed or insured piece never starts a selling trip', async () => {
  for (const cliloc of [1038021, 1061682]) {
    const { f, dropped, walks, sellCtx } = sellingFixture([{ cliloc, arguments: '' }]);
    f.checkpoint.forSale = [50];
    expect(await sellingTurn(sellCtx, true)).toBe(false);
    expect(walks).toEqual([]);
    expect(dropped).toEqual([]);
  }
});
