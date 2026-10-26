import { expect, test } from 'bun:test';

import type { FighterContext } from '../src/fighter-context';
import { createCorpseLooter } from '../src/fighter-loot';
import { durability, guildRepairTurn } from '../src/guild-repairs';
import { usefulGift } from '../src/inventory-use';
import { serviceLocations } from '../src/locations';
import { pocketReserve } from '../src/loot-economy';
import { personalMemory } from '../src/resident-memory';
import { required } from './behavior-fixture';
import { socialFixture } from './social-fixture';

function repairFixture() {
  const f = socialFixture('swordsman');
  const shop = required(serviceLocations('Britain', 'blacksmith')[0]);
  f.world.position = { ...required(f.world.position), ...shop };
  f.terrain.tile = () => ({ name: 'long sword', flags: 0x400000, height: 0, layer: 1 });
  f.world.entities.set(20, {
    serial: 20,
    kind: 'item',
    graphic: 0x13fe,
    parent: 1,
    layer: 1,
    properties: [{ cliloc: 1060639, arguments: '10\t100' }]
  });
  f.world.entities.set(21, {
    serial: 21,
    kind: 'item',
    graphic: 0x14f0,
    parent: 10,
    properties: [{ cliloc: 1061133, arguments: '#1061172\t#1023015' }]
  });
  f.session.use = () => {
    f.world.target = { id: 1, ground: false, flags: 0 };
  };
  return f;
}

test('a smith contract is accepted as useful when owned equipment needs repair', async () => {
  const f = repairFixture();
  expect(await usefulGift(f.session, required(f.world.entities.get(21)))).toBe(true);
  required(f.world.entities.get(20)).properties = [{ cliloc: 1060639, arguments: '100\t100' }];
  expect(await usefulGift(f.session, required(f.world.entities.get(21)))).toBe(false);
});

for (const restored of [true, false])
  test(`a repair contract ${restored ? 'restores equipment through' : 'does not invent success without'} observed durability`, async () => {
    const f = repairFixture();
    f.session.target = () => {
      f.world.target = null;
      f.world.entities.delete(21);
      if (restored) required(f.world.entities.get(20)).properties = [{ cliloc: 1060639, arguments: '99\t99' }];
    };
    expect(await guildRepairTurn(f.ctx)).toBe(true);
    expect(durability(required(f.world.entities.get(20)))?.current).toBe(restored ? 99 : 10);
    expect(f.checkpoint.personal?.episodes.some((e) => e.result === 'completed') ?? false).toBe(false);
    // Consumption alone never creates an equipment gain or a completed relationship event.
  });

test('loot collects gold before heavy equipment and only accounts for actual receipts', async () => {
  const f = socialFixture('swordsman');
  f.world.entities.set(30, {
    serial: 30,
    kind: 'item',
    graphic: 0x2006,
    position: { ...required(f.world.position), x: 101 }
  });
  f.world.entities.set(31, { serial: 31, kind: 'item', graphic: 0x13fe, parent: 30 });
  f.world.entities.set(32, { serial: 32, kind: 'item', graphic: 0xeed, parent: 30, amount: 120 });
  f.world.entities.set(33, { serial: 33, kind: 'item', graphic: 0xf16, parent: 30, amount: 2 });
  f.session.use = () => {
    f.world.received.set(0x3c, 1);
  };
  const moved: number[] = [];
  f.session.moveItem = async (serial, container) => {
    moved.push(serial);
    if (serial === 31) throw new Error('refused');
    if (serial === 32) {
      required(f.world.entities.get(11)).amount = 1120;
      f.world.entities.delete(serial);
    } else f.world.entities.set(serial, { ...required(f.world.entities.get(serial)), parent: container });
  };
  f.session.refreshStatus = async () => {};
  const trip = { loot: [] as number[], killsSinceBank: 0, pending: 'hunt' };
  const stats = { looted: 0 };
  const ctx = {
    ...f.ctx,
    serial: 1,
    backpack: () => 10,
    contents: (container = 10) => f.world.childrenOf(container),
    trip,
    stats,
    nearby: () => []
  } as unknown as FighterContext;
  await createCorpseLooter(ctx, async () => {})(30);
  expect(moved).toEqual([32, 33, 31]);
  expect(stats.looted).toBe(2);
  expect(trip.loot).toEqual([33]);
  expect(f.checkpoint.personal?.economy?.lootedGold).toBe(120);
});

test('banking preserves money for player trade and an unsettled companion share', () => {
  const f = socialFixture();
  const memory = personalMemory(f.checkpoint);
  expect(pocketReserve(f.checkpoint)).toBe(200);
  memory.commitment = {
    id: 'test',
    kind: 'hunt',
    partner: 2,
    name: 'Ada',
    map: 1,
    acceptedAt: Date.now(),
    until: Date.now() + 1000,
    lastSeen: Date.now(),
    state: 'completed',
    kills: 1,
    lootDue: 75
  };
  expect(pocketReserve(f.checkpoint)).toBe(275);
  memory.orders.push({
    id: 'order',
    side: 'buy',
    partner: 2,
    name: 'Ada',
    good: 'bandages',
    amount: 100,
    price: 500,
    map: 1,
    meeting: { x: 100, y: 100 },
    until: Date.now() + 1000,
    state: 'accepted'
  });
  expect(pocketReserve(f.checkpoint)).toBe(575);
});

test('a skilled guild smith creates a real contract from a blank scroll and hands it over securely', async () => {
  const { joinGuild } = await import('../src/guild-store');
  const { skillId } = await import('@gemwright/common/skills');
  const f = repairFixture();
  f.world.entities.delete(20);
  f.world.entities.delete(21);
  f.world.entities.set(1, { ...required(f.world.entities.get(1)), name: 'Repair Smith Test' });
  joinGuild('Repair Smith Test', 'Repair Test Guild');
  joinGuild('Repair Recipient Test', 'Repair Test Guild');
  f.world.entities.set(2, {
    serial: 2,
    kind: 'mobile',
    graphic: 400,
    notoriety: 1,
    name: 'Repair Recipient Test',
    position: { ...required(f.world.position), x: required(f.world.position).x + 1 }
  });
  f.world.entities.set(22, {
    serial: 22,
    kind: 'item',
    graphic: 0x13fe,
    parent: 2,
    layer: 1,
    properties: [{ cliloc: 1060639, arguments: '10\t100' }]
  });
  f.world.entities.set(23, { serial: 23, kind: 'item', graphic: 0x13e3, parent: 10 });
  f.world.entities.set(24, { serial: 24, kind: 'item', graphic: 0xe34, parent: 10 });
  f.world.skills.set(skillId('Blacksmith'), { value: 100, base: 100, cap: 100, lock: 0 });
  f.session.use = () => {
    f.world.gumps.set('1:1', {
      serial: 1,
      id: 1,
      layout:
        '{ xmfhtmlgump 10 10 200 20 1044010 0 0 }{ button 270 342 4005 4007 1 0 42 }{ xmfhtmlgump 305 345 150 18 1044260 0 0 }',
      packed: false
    });
  };
  f.session.replyGump = () => {
    f.world.target = { id: 1, ground: false, flags: 0 };
  };
  f.session.target = (aim) => {
    expect(aim?.serial).toBe(24);
    f.world.target = null;
    f.world.entities.delete(24);
    f.world.entities.set(25, {
      serial: 25,
      kind: 'item',
      graphic: 0x14f0,
      parent: 10,
      properties: [{ cliloc: 1061133, arguments: '#1061172\t#1023015' }]
    });
  };
  f.session.giveToMobile = async (serial) => {
    f.world.entities.set(serial, { ...required(f.world.entities.get(serial)), parent: 100 });
    f.world.trade = {
      mine: 100,
      theirs: 101,
      partner: 2,
      name: 'Repair Recipient Test',
      accepted: { me: false, them: true },
      closed: false
    };
  };
  f.session.acceptTrade = () => {
    required(f.world.trade).closed = true;
    f.world.entities.delete(25);
  };
  expect(await guildRepairTurn(f.ctx)).toBe(true);
  expect(f.world.entities.has(24)).toBe(false);
  expect(f.checkpoint.personal?.episodes.at(-1)?.kind).toBe('repair');
  expect(f.checkpoint.personal?.episodes.at(-1)?.result).toBe('completed');
});
