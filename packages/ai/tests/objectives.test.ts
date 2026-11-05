import { expect, test } from 'bun:test';

import { ActionBusy } from '../src/action-errors';
import { allServiceLocations, serviceLocations } from '../src/locations';
import { meetNeeds, needPriority } from '../src/need-planning';
import { residentNeeds } from '../src/needs';
import { completeObjective, errand, failObjective, objectiveBlocked, suppliesCondition } from '../src/objective-memory';
import { atVendor } from '../src/vendor-visit';
import { behaviorFixture, required } from './behavior-fixture';
import { useTestWorld } from './world-fixture';

useTestWorld();

test('a failed objective waits two hours, reopens on changed means, and stays bounded', () => {
  const { checkpoint } = behaviorFixture();
  const until = failObjective(checkpoint, 'tool', 'poor', 'no stock', 1000);
  expect(until - 1000).toBe(2 * 3_600_000);
  expect(objectiveBlocked(checkpoint, 'tool', 'poor', until - 1)).toBe(true);
  expect(objectiveBlocked(checkpoint, 'tool', 'gift', until - 1)).toBe(false);
  expect(objectiveBlocked(checkpoint, 'tool', 'poor', until)).toBe(false);
  const first = until;
  completeObjective(checkpoint, 'tool');
  expect(objectiveBlocked(checkpoint, 'tool', 'poor', first + 1)).toBe(false);
  for (let i = 0; i < 100; i++) failObjective(checkpoint, `tree:${i}`, 'depleted', 'empty', i);
  expect(Object.keys(required(checkpoint.objectives)).length).toBe(64);
});

test('a failed shop is skipped on the next visit, while changed possessions permit a fresh attempt', async () => {
  const { ctx, world, session, checkpoint } = behaviorFixture();
  checkpoint.funds = { bank: 0, at: Date.now() };
  const shop = required(serviceLocations('Britain', 'tailor')[0]);
  world.position = { ...shop, z: 0, direction: 0 };
  world.entities.set(2, { serial: 2, kind: 'mobile', graphic: 400, notoriety: 7, position: { ...world.position } });
  session.context = async () => [{ index: 0, cliloc: 3006103, flags: 0 }];
  for (const point of allServiceLocations('tailor')) {
    if (point.x === shop.x && point.y === shop.y) continue;
    failObjective(
      checkpoint,
      `shop:1:tailor:3006103:${point.x},${point.y}:cloth`,
      suppliesCondition(session, checkpoint),
      'already checked'
    );
  }
  let attempts = 0;
  const craft = {
    ...ctx,
    serial: 1,
    status: () => required(world.status),
    carried: (parent: number) => world.childrenOf(parent)
  };
  await atVendor(
    craft,
    'tailor',
    3006103,
    async () => {
      attempts++;
      return false;
    },
    'cloth'
  );
  await atVendor(
    craft,
    'tailor',
    3006103,
    async () => {
      attempts++;
      return false;
    },
    'cloth'
  );
  expect(attempts).toBe(1);
  world.entities.set(12, { serial: 12, kind: 'item', graphic: 0x1766, parent: 10, amount: 50 });
  expect(
    await atVendor(
      craft,
      'tailor',
      3006103,
      async () => {
        attempts++;
        return true;
      },
      'cloth'
    )
  ).toBe(true);
  expect(attempts).toBe(2);
});

test('a missing work tool causes a real purchase and disappears from the shared needs assessment', async () => {
  const { ctx, world, session, checkpoint, template } = behaviorFixture();
  checkpoint.funds = { bank: 0, at: Date.now() };
  const shop = required(serviceLocations('Britain', 'tailor')[0]);
  world.position = { ...shop, z: 0, direction: 0 };
  world.entities.set(2, { serial: 2, kind: 'mobile', graphic: 400, notoriety: 7, position: { ...world.position } });
  world.entities.set(20, { serial: 20, kind: 'item', graphic: 0xf9d, amount: 2, parent: 99 });
  session.context = async () => [{ index: 0, cliloc: 3006103, flags: 0 }];
  session.selectContext = () => {
    world.received.set(0x74, (world.received.get(0x74) ?? 0) + 1);
    world.buyOffers.set(2, [{ serial: 20, price: 3, description: 'sewing kit' }]);
  };
  session.waitFor = async (predicate) => {
    if (!predicate()) throw new Error('No observation');
  };
  session.purchaseItem = async (_vendor, _offer, backpack, amount) => {
    world.entities.set(21, { serial: 21, kind: 'item', graphic: 0xf9d, parent: backpack, amount });
    const coins = required(world.entities.get(11));
    coins.amount = (coins.amount ?? 0) - amount * 3;
    required(world.status).gold -= amount * 3;
  };
  expect(residentNeeds(session, checkpoint, template).some((need) => need.kind === 'tool')).toBe(true);
  expect(await meetNeeds(ctx)).toBe('handled');
  expect(residentNeeds(session, checkpoint, template).some((need) => need.kind === 'tool')).toBe(false);
});

test('poverty becomes an income priority and stale bank balances cannot hide it', () => {
  const { ctx, world, checkpoint } = behaviorFixture('archer');
  required(world.status).gold = 0;
  checkpoint.funds = { bank: 10000, at: Date.now() - 3600_000 };
  expect(needPriority(ctx).income).toBe(true);
  checkpoint.funds.at = Date.now();
  expect(needPriority(ctx).income).toBe(false);
});

test('supplies left in a bank box do not satisfy a carried work-tool need', () => {
  const { session, world, checkpoint, template } = behaviorFixture();
  const condition = suppliesCondition(session, checkpoint);
  world.entities.set(30, { serial: 30, kind: 'item', graphic: 0xe7c, parent: 1, layer: 29 });
  world.entities.set(31, { serial: 31, kind: 'item', graphic: 0xf9d, parent: 30 });
  expect(residentNeeds(session, checkpoint, template).some((need) => need.kind === 'tool')).toBe(true);
  expect(suppliesCondition(session, checkpoint)).toBe(condition);
  world.entities.set(31, { serial: 31, kind: 'item', graphic: 0xf9d, parent: 10 });
  expect(residentNeeds(session, checkpoint, template).some((need) => need.kind === 'tool')).toBe(false);
  expect(suppliesCondition(session, checkpoint)).not.toBe(condition);
});

test('a vendor menu that fails for our own reasons (resource busy) never writes the shop off as empty', async () => {
  const { ctx, world, session, checkpoint } = behaviorFixture();
  checkpoint.funds = { bank: 0, at: Date.now() };
  const shop = required(serviceLocations('Vesper', 'cobbler')[0]);
  world.position = { ...shop, z: 0, direction: 0 };
  world.entities.set(2, { serial: 2, kind: 'mobile', graphic: 400, notoriety: 7, position: { ...world.position } });
  session.context = async () => {
    throw new ActionBusy('Command resources remained busy');
  };
  const craft = {
    ...ctx,
    serial: 1,
    status: () => required(world.status),
    carried: (p: number) => world.childrenOf(p)
  };
  await atVendor(craft, 'cobbler', 3006104, async () => true);
  expect(checkpoint.objectives?.[`vendor-absent:1:cobbler:${shop.x},${shop.y}`]).toBeUndefined();
});

test("a miner without a pickaxe looks for one where miners' tools are sold, not only at a tinker", () => {
  const { session, checkpoint, template } = behaviorFixture('miner');
  const pickaxe = residentNeeds(session, checkpoint, { ...template, id: 'minoc-miner' }).find(
    (need) => need.kind === 'tool'
  );
  expect(pickaxe?.purchase?.service).toBe('mining-tools');
});

test("a miner buys the cheapest mining tool the town's tinker has on the counter, in one visit, not a far town's", async () => {
  const { ctx, world, session, checkpoint, template } = behaviorFixture('miner');
  const miner = { ...ctx, template: { ...template, id: 'minoc-miner' } };
  checkpoint.funds = { bank: 0, at: Date.now() };
  const shop = required(serviceLocations('Minoc', 'mining-tools')[0]);
  world.position = { ...shop, z: 0, direction: 0 };
  world.entities.set(2, { serial: 2, kind: 'mobile', graphic: 400, notoriety: 7, position: { ...world.position } });
  // ServUO SBTinker: a pickaxe is 0xE86, a shovel 0xF39; nothing sells the other pickaxe graphic.
  world.entities.set(20, { serial: 20, kind: 'item', graphic: 0xe86, amount: 20, parent: 99 });
  world.entities.set(22, { serial: 22, kind: 'item', graphic: 0xf39, amount: 20, parent: 99 });
  let visits = 0;
  const bought: number[] = [];
  session.context = async () => [{ index: 0, cliloc: 3006103, flags: 0 }];
  session.selectContext = () => {
    visits++;
    world.received.set(0x74, (world.received.get(0x74) ?? 0) + 1);
    world.buyOffers.set(2, [
      { serial: 20, price: 25, description: 'pickaxe' },
      { serial: 22, price: 12, description: 'shovel' }
    ]);
  };
  session.waitFor = async (predicate) => {
    if (!predicate()) throw new Error('No observation');
  };
  session.purchaseItem = async (_vendor, offer, backpack, amount) => {
    const graphic = required(world.entities.get(offer)).graphic;
    bought.push(graphic);
    world.entities.set(30 + bought.length, {
      serial: 30 + bought.length,
      kind: 'item',
      graphic,
      parent: backpack,
      amount
    });
  };
  expect(await meetNeeds(miner)).toBe('handled');
  expect(visits).toBe(1);
  expect(bought).toEqual([0xf39]);
});

for (const key of ['bank', 'sell:100,100'])
  test(`${key} retries when new output arrives without doubling the resident's wealth`, async () => {
    const f = behaviorFixture();
    f.checkpoint.funds = { bank: 50_000, at: Date.now() };
    if (key.startsWith('sell:'))
      f.world.entities.set(20, { serial: 20, kind: 'item', graphic: 0x1bf2, amount: 1, parent: 10 });
    let trips = 0;
    const first = suppliesCondition(f.session, f.checkpoint);
    expect(
      await errand(f.ctx, key, 'settlement', async () => {
        trips++;
      })
    ).toBe(false);
    expect(
      await errand(f.ctx, key, 'settlement', async () => {
        trips++;
      })
    ).toBe(false);
    expect(trips).toBe(1);
    if (key === 'bank') {
      required(f.world.entities.get(11)).amount = 1001;
      required(f.world.status).gold = 1001;
    } else required(f.world.entities.get(20)).amount = 2;
    expect(suppliesCondition(f.session, f.checkpoint)).toBe(first);
    expect(
      await errand(f.ctx, key, 'settlement', async () => {
        trips++;
        if (key === 'bank') {
          f.world.entities.delete(11);
          required(f.checkpoint.funds).bank += 1001;
        } else {
          f.world.entities.delete(20);
          required(f.world.entities.get(11)).amount = 1002;
          required(f.world.status).gold = 1002;
        }
      })
    ).toBe(true);
    expect(trips).toBe(2);
  });
