import { expect, test } from 'bun:test';

import { fish } from '@gemwright/common/game/items';
import { Layer } from '@gemwright/network/layers';

import { fishingFootwear, sellFishingCatch } from '../src/fishing-catch';
import { serviceLocations } from '../src/locations';
import type { ProfessionContext } from '../src/profession';
import { required } from './behavior-fixture';
import { socialFixture } from './social-fixture';

function catchFixture(holdsFish: boolean, refuseFish = false) {
  const f = socialFixture('fisherman');
  f.world.position = { ...required(f.world.position), x: 1436, y: 1760 };
  f.world.entities.delete(11);
  required(f.world.status).gold = 0;
  const add = (serial: number, graphic: number, parent = 10) =>
    f.world.entities.set(serial, { serial, kind: 'item', graphic, parent, amount: 1, properties: [] });
  if (holdsFish) add(40, 0x097a);
  add(41, 0x170b);
  add(42, 0x170f);
  add(43, 0x170d, 1);
  add(44, 0x13fe);
  add(45, 0x1711);
  const sold: number[] = [];
  let banked = 0;
  const ctx: ProfessionContext = {
    ...f.ctx,
    serial: 1,
    backpack: () => 10,
    status: () => required(f.world.status),
    carried: (box = 10) => f.world.childrenOf(box),
    progress: {},
    deadline: Date.now() + 60000,
    practise: async () => 0,
    count: (graphic) => f.world.childrenOf(10).filter((item) => item.graphic === graphic).length,
    navigate: async (point: { x: number; y: number }) => {
      f.world.position = { ...required(f.world.position), ...point };
      f.world.entities.set(20, {
        serial: 20,
        kind: 'mobile',
        graphic: 400,
        notoriety: 7,
        position: { ...required(f.world.position) }
      });
    }
  };
  f.session.context = async () => [
    { cliloc: 3006104, flags: 0, index: 0 },
    { cliloc: 3006105, flags: 0, index: 1 }
  ];
  f.session.selectContext = (vendor) => {
    const atCobbler = serviceLocations('Britain', 'cobbler').some(
      (p) => p.x === ctx.position().x && p.y === ctx.position().y
    );
    f.world.sellOffers.set(
      vendor,
      ctx
        .carried()
        .filter((item) => (atCobbler ? fishingFootwear.has(item.graphic) : !refuseFish && fish.has(item.graphic)))
        .map((item) => ({ serial: item.serial, amount: 1, price: 4, graphic: item.graphic, hue: 0, name: 'catch' }))
    );
  };
  f.session.sell = async (_vendor, items) => {
    for (const item of items) {
      sold.push(item.serial);
      f.world.entities.delete(item.serial);
    }
    required(f.world.status).gold += items.length * 4;
    f.world.entities.set(11, {
      serial: 11,
      kind: 'item',
      graphic: 0xeed,
      parent: 10,
      amount: required(f.world.status).gold
    });
  };
  f.session.refreshStatus = async () => {};
  f.session.say = (text) => {
    if (text === 'bank') {
      f.world.entities.set(30, { serial: 30, kind: 'item', graphic: 0xe7c, parent: 1, layer: Layer.Bank });
      f.world.received.set(0x3c, (f.world.received.get(0x3c) ?? 0) + 1);
    }
    if (text === 'balance')
      f.world.addJournal({ serial: 20, name: 'Banker', cliloc: 1042759, arguments: String(banked) });
  };
  f.session.moveItem = async (serial, parent) => {
    const item = required(f.world.entities.get(serial));
    banked += item.amount ?? 1;
    f.world.entities.set(serial, { ...item, parent });
    required(f.world.status).gold = 0;
  };
  return { ...f, ctx, sold, banked: () => banked };
}

for (const holdsFish of [true, false])
  test(`fishing return sells footwear ${holdsFish ? 'with' : 'without'} fish, then banks every coin`, async () => {
    const f = catchFixture(holdsFish);
    await sellFishingCatch(f.ctx);
    expect(f.sold).toEqual(holdsFish ? [40, 41, 42, 45] : [41, 42, 45]);
    expect(f.banked()).toBe(holdsFish ? 16 : 12);
    expect(f.ctx.status().gold).toBe(0);
    expect(f.world.entities.has(43)).toBe(true);
    expect(f.world.entities.has(44)).toBe(true);
  });

test('a refused fish sale still sells the shoes and banks the proceeds before reporting the setback', async () => {
  const f = catchFixture(true, true);
  await expect(sellFishingCatch(f.ctx)).rejects.toThrow('No fisherman here bought the catch');
  expect(f.sold).toEqual([41, 42, 45]);
  expect(f.banked()).toBe(12);
});
