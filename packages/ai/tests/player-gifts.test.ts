import { expect, test } from 'bun:test';

import { betterEquipment, useAcquiredItems } from '../src/inventory-use';
import { scavenge } from '../src/scavenge';
import { guardTradeTick } from '../src/trade-guard';
import { required } from './behavior-fixture';
import { socialFixture } from './social-fixture';

function tradeFixture() {
  const f = socialFixture('archer');
  f.world.entities.set(2, {
    serial: 2,
    kind: 'mobile',
    graphic: 400,
    name: 'Ada',
    notoriety: 1,
    position: { ...required(f.world.position), x: 101 }
  });
  f.world.entities.set(100, { serial: 100, kind: 'item', graphic: 0x1e5e });
  f.world.entities.set(101, { serial: 101, kind: 'item', graphic: 0x1e5e });
  f.world.trade = {
    partner: 2,
    name: 'Ada',
    mine: 100,
    theirs: 101,
    accepted: { me: false, them: false },
    closed: false
  };
  return f;
}

test('a newly opened empty trade waits for the player instead of cancelling', async () => {
  const { session, world, spoken } = tradeFixture();
  await guardTradeTick(session, 1000);
  expect(world.trade?.closed).toBe(false);
  await guardTradeTick(session, 3000);
  expect(world.trade?.closed).toBe(false);
  expect(spoken).toEqual(['What would you like to trade?']);
  await guardTradeTick(session, 47_000);
  expect(world.trade?.closed).toBe(true);
});

test('a useful gift is accepted, merged stacks confirm delivery, and the giver is remembered once', async () => {
  const { session, world, checkpoint, spoken } = tradeFixture();
  world.entities.set(30, { serial: 30, kind: 'item', graphic: 0xe21, parent: 10, amount: 3 });
  world.entities.set(31, { serial: 31, kind: 'item', graphic: 0xe21, parent: 101, amount: 10 });
  await guardTradeTick(session, 1000);
  expect(world.trade?.accepted.me).toBe(true);
  expect(checkpoint.personal?.episodes.length ?? 0).toBe(0);
  required(world.trade).closed = true;
  await guardTradeTick(session, 2000); // The close can precede the backpack update.
  expect(checkpoint.personal?.episodes.length ?? 0).toBe(0);
  world.entities.delete(31);
  required(world.entities.get(30)).amount = 13;
  await guardTradeTick(session, 2300);
  expect(checkpoint.personal?.episodes.filter((episode) => episode.kind === 'gift').length).toBe(1);
  expect(checkpoint.personal?.partners[2]?.trust).toBeGreaterThan(0);
  expect(spoken.some((line) => line.includes('Thanks'))).toBe(true);
  await guardTradeTick(session, 2400);
  expect(checkpoint.personal?.episodes.filter((episode) => episode.kind === 'gift').length).toBe(1);
});

test('a cancelled gift window is never recorded as a received gift', async () => {
  const { session, world, checkpoint } = tradeFixture();
  world.entities.set(31, { serial: 31, kind: 'item', graphic: 0xeed, parent: 101, amount: 20 });
  await guardTradeTick(session, 1000);
  required(world.trade).closed = true;
  await guardTradeTick(session, 2000);
  await guardTradeTick(session, 8000);
  expect(checkpoint.personal?.episodes.length ?? 0).toBe(0);
});

function equipmentFixture() {
  const f = socialFixture('swordsman');
  required(f.template.archetype).primarySkills = ['Swordsmanship'];
  f.terrain.tile = () => ({ flags: 0x400000, layer: 1, name: 'katana', height: 0 });
  const properties = (damage: number, strength = 20) => [
    { cliloc: 1061168, arguments: `${damage}\t${damage + 4}` },
    { cliloc: 1061167, arguments: '2.5s' },
    { cliloc: 1061170, arguments: String(strength) }
  ];
  f.world.entities.set(20, {
    serial: 20,
    kind: 'item',
    graphic: 0x13fe,
    parent: 1,
    layer: 1,
    properties: properties(5)
  });
  f.world.entities.set(21, { serial: 21, kind: 'item', graphic: 0x0f5e, parent: 10, properties: properties(15) });
  f.session.moveItem = async (serial, parent) => {
    const item = required(f.world.entities.get(serial));
    f.world.entities.set(serial, { ...item, parent, position: undefined, layer: undefined });
  };
  f.session.equipItem = async (serial, layer) => {
    const item = required(f.world.entities.get(serial));
    f.world.entities.set(serial, { ...item, parent: 1, position: undefined, layer });
  };
  return { ...f, properties };
}

test('acquired equipment replaces a weaker compatible weapon only after the server confirms wearing it', async () => {
  const { session, world } = equipmentFixture();
  expect(await useAcquiredItems(session)).toBe(true);
  expect(world.entities.get(21)?.parent).toBe(1);
  expect(world.entities.get(21)?.layer).toBe(1);
  expect(world.entities.get(20)?.parent).toBe(10);
});

test('an unwearable upgrade restores the prior equipment and is not retried every turn', async () => {
  const { session, world } = equipmentFixture();
  let refused = 0;
  session.equipItem = async (serial, layer) => {
    if (serial === 21) {
      refused++;
      throw new Error('Too weak');
    }
    world.entities.set(serial, { ...required(world.entities.get(serial)), parent: 1, layer });
  };
  expect(await useAcquiredItems(session)).toBe(false);
  expect(world.entities.get(20)?.parent).toBe(1);
  await useAcquiredItems(session);
  expect(refused).toBe(1);
});

test('an inferior or too-heavy-to-wield item is not treated as an equipment upgrade', async () => {
  const { session, world, properties } = equipmentFixture();
  world.entities.set(22, { serial: 22, kind: 'item', graphic: 0x0f5e, parent: 10, properties: properties(1) });
  world.entities.set(23, { serial: 23, kind: 'item', graphic: 0x0f5e, parent: 10, properties: properties(30, 100) });
  expect(await betterEquipment(session, required(world.entities.get(22)))).toBe(false);
  expect(await betterEquipment(session, required(world.entities.get(23)))).toBe(false);
});

test('a useful ground upgrade is picked up and equipped even with a passive animal nearby', async () => {
  const { world, terrain, ctx } = equipmentFixture();
  const item = required(world.entities.get(21));
  world.entities.set(21, {
    ...item,
    parent: undefined,
    flags: 0x20,
    position: { ...required(world.position), x: 101 }
  });
  world.entities.set(3, {
    serial: 3,
    kind: 'mobile',
    graphic: 0xcf,
    notoriety: 3,
    name: 'a sheep',
    position: { ...required(world.position), y: 102 }
  });
  expect(await scavenge({ ...ctx, serial: 1, status: () => required(world.status), backpack: () => 10, terrain })).toBe(
    true
  );
  expect(world.entities.get(21)?.parent).toBe(1);
  expect(world.entities.get(21)?.layer).toBe(1);
});
