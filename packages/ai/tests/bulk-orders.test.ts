import { expect, test } from 'bun:test';

import { skillId } from '@gemwright/common/skills';

import { bulkOrderTurn } from '../src/bulk-orders';
import { residentTurn } from '../src/goal-turn';
import { minerBulkOrder } from '../src/miner-bulk-orders';
import { blacksmithing } from '../src/miner-crafting';
import type { ProfessionContext } from '../src/profession';
import { required } from './behavior-fixture';
import { socialFixture } from './social-fixture';

let serial = 95000;
function orderFixture() {
  const f = socialFixture('craftsman');
  const id = serial++;
  f.world.position = { x: 2560, y: 502, z: 0, direction: 0 };
  f.world.skills.set(skillId('Blacksmith'), { base: 50, value: 50, cap: 100, lock: 0 });
  f.checkpoint.funds = { bank: 10000, at: Date.now() };
  f.checkpoint.stock = { ingots: 100, at: Date.now() };
  f.world.entities.set(12, { serial: 12, kind: 'item', graphic: 0xfbb, parent: 10 });
  f.world.entities.set(20, {
    serial: 20,
    kind: 'item',
    graphic: 0xfaf,
    position: { x: 2560, y: 501, z: 0, direction: 0 }
  });
  f.world.entities.set(21, {
    serial: 21,
    kind: 'item',
    graphic: 0xfb1,
    position: { x: 2561, y: 501, z: 0, direction: 0 }
  });
  const deed = {
    serial: 30,
    kind: 'item' as const,
    graphic: 0x2258,
    parent: 10,
    properties: [
      { cliloc: 1060656, arguments: '2' },
      { cliloc: 1060658, arguments: '#1025051\t0' }
    ]
  };
  f.world.entities.set(30, deed);
  f.terrain.findStatics = () => [];
  f.terrain.pathAsync = async (_from, goal) => [{ ...goal, z: 0 }];
  const messages: string[] = [];
  let attempts = 0;
  let refills = 0;
  let outcome = 1044154;
  const ctx: ProfessionContext = {
    ...f.ctx,
    serial: id,
    city: 'Minoc',
    deadline: Date.now() + 60000,
    backpack: () => 10,
    status: () => required(f.world.status),
    carried: (pack = 10) => f.world.childrenOf(pack),
    count: () => 0,
    practise: async () => 0,
    progress: {},
    log: (line) => messages.push(line),
    navigate: async (point) => {
      f.world.position = { ...required(f.world.position), ...point };
      f.world.entities.set(22, {
        serial: 22,
        kind: 'mobile',
        graphic: 400,
        notoriety: 7,
        position: { ...required(f.world.position) }
      });
    }
  };
  const refill = async () => {
    refills++;
    f.world.position = { x: 2503, y: 552, z: 0, direction: 0 };
    f.world.entities.set(13, { serial: 13, kind: 'item', graphic: 0x1bf2, amount: 10, parent: 10 });
    return true;
  };
  f.world.gumps.set('craft', {
    serial: 1,
    id: 1,
    packed: false,
    layout: '{ xmfhtmlgump 0 0 0 0 1111704 } { button 220 60 0 0 1 0 2 } { xmfhtmlgump 255 63 0 0 1025051 }'
  });
  f.session.use = (item) => {
    if (item === 30)
      f.world.gumps.set('order', { serial: 30, id: 2, packed: false, layout: '{ xmfhtmlgump 0 0 0 0 1045138 }' });
  };
  f.session.replyGump = (item, _id, button) => {
    if (button === 0) return;
    if (item === 30) {
      f.world.target = { id: 1, ground: false, flags: 0 };
      return;
    }
    if (item !== 1) return;
    expect(Math.abs(ctx.position().x - 2560)).toBeLessThanOrEqual(2);
    expect(Math.abs(ctx.position().y - 501)).toBeLessThanOrEqual(2);
    attempts++;
    if ([1044154, 1044155].includes(outcome)) {
      f.world.entities.set(40 + attempts, {
        serial: 40 + attempts,
        kind: 'item',
        graphic: 0x13bb,
        parent: 10,
        properties: []
      });
      f.world.entities.delete(13);
    }
    f.world.addJournal({ serial: 1, name: '', cliloc: outcome });
  };
  f.session.target = (target) => {
    if (!target) {
      f.world.target = null;
      return;
    }
    f.world.entities.delete(target.serial);
    const property = required(deed.properties[1]);
    const have = Number(property.arguments.split('\t')[1]);
    property.arguments = `#1025051\t${have + 1}`;
  };
  f.session.context = async () => [{ cliloc: 3006152, flags: 0, index: 0 }];
  f.session.moveItem = async (item) => {
    if (item === 30) {
      f.world.entities.delete(30);
      f.world.gumps.set('points', { serial: 99, id: 3, packed: false, layout: '{ xmfhtmlgump 0 0 0 0 1157076 }' });
    }
  };
  return {
    ...f,
    ctx,
    refill,
    messages,
    attempts: () => attempts,
    refills: () => refills,
    setOutcome: (code: number) => {
      outcome = code;
    }
  };
}

test('an accepted order is prioritized, returns from the bank before each craft, and stops at the required quantity', async () => {
  const f = orderFixture();
  f.template.id = 'minoc-miner';
  f.template.behavior.activities = ['mine'];
  required(f.template.archetype).primarySkills = ['Mining', 'Blacksmith'];
  required(f.template.archetype).supportingSkills = [];
  f.world.entities.set(14, { serial: 14, kind: 'item', graphic: 0xe85, parent: 10 });
  f.session.refreshStatus = async () => {};
  const actions = { trade: 'miner', keep: () => true, order: () => minerBulkOrder(f.ctx, f.refill) };
  expect(await residentTurn(f.ctx, actions)).toBe(true);
  expect(f.checkpoint.workGoal?.active?.key).toBe('order:30');
  await residentTurn(f.ctx, actions);
  expect(f.checkpoint.workGoal?.last).toMatchObject({ key: 'order:30', result: 'completed' });
  expect(f.attempts()).toBe(2);
  expect(f.refills()).toBe(2);
  expect(f.world.entities.has(30)).toBe(false);
  expect(f.messages.some((m) => m.includes('Turned in a bulk order'))).toBe(true);
}, 10000);

test('exceptional pieces for a plain bulk order stay available for combining', async () => {
  const f = orderFixture();
  f.setOutcome(1044155);
  expect(await minerBulkOrder(f.ctx, f.refill)).toBe(true);
  expect(f.attempts()).toBe(2);
  expect(f.checkpoint.keep ?? []).toEqual([]);
});

for (const [outcome, reason] of [
  [1044038, 'tool'],
  [1044267, 'station']
] as const)
  test(`a ${reason} failure is reported with a short retry instead of an hour`, async () => {
    const f = orderFixture();
    f.setOutcome(outcome);
    expect(await minerBulkOrder(f.ctx, f.refill)).toBe(false);
    expect(f.checkpoint.bulkOrders?.stalledReason).toBe(reason);
    expect((f.checkpoint.bulkOrders?.stalledUntil ?? 0) - Date.now()).toBeLessThanOrEqual(120000);
    expect(f.messages.some((m) => m.includes(`server reply ${outcome}`))).toBe(true);
  });

test('missing materials get a longer delay that is bypassed once banked iron is available', async () => {
  const f = orderFixture();
  f.checkpoint.stock = { ingots: 0, at: Date.now() };
  expect(await bulkOrderTurn({ ...f.ctx, refill: async () => false }, blacksmithing, 50)).toBe(false);
  expect(f.checkpoint.bulkOrders?.stalledReason).toBe('materials');
  expect((f.checkpoint.bulkOrders?.stalledUntil ?? 0) - Date.now()).toBeGreaterThan(3500000);
  f.checkpoint.stock.ingots = 100;
  expect(await minerBulkOrder(f.ctx, f.refill)).toBe(true);
  expect(f.world.entities.has(30)).toBe(false);
});

test('a completed deed is handed in before asking for another order or crafting', async () => {
  const f = orderFixture();
  required(required(f.world.entities.get(30)).properties?.find((p) => p.cliloc === 1060658)).arguments = '#1025051\t2';
  expect(await minerBulkOrder(f.ctx, f.refill)).toBe(true);
  expect(f.attempts()).toBe(0);
  expect(f.refills()).toBe(0);
  expect(f.world.entities.has(30)).toBe(false);
});

test('a refused combine reports the blocker and yields instead of monopolizing every turn', async () => {
  const f = orderFixture();
  f.session.target = (target) => {
    if (!target) f.world.target = null;
  };
  expect(await minerBulkOrder(f.ctx, f.refill)).toBe(false);
  expect(f.checkpoint.bulkOrders?.stalledReason).toBe('combining pieces did not advance the deed');
  expect(await minerBulkOrder(f.ctx, f.refill)).toBe(false);
  expect(f.attempts()).toBe(2);
});

test('the old blanket one-hour delay does not postpone an order after upgrading', async () => {
  const f = orderFixture();
  f.checkpoint.bulkOrders = { nextAt: Date.now() + 3600000, stalledUntil: Date.now() + 3600000 };
  expect(await minerBulkOrder(f.ctx, f.refill)).toBe(true);
  expect(f.world.entities.has(30)).toBe(false);
});
