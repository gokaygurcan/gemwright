import { expect, test } from 'bun:test';

import { skillId } from '@gemwright/common/skills';

import { createFighterCombat } from '../src/fighter-combat';
import type { FighterContext } from '../src/fighter-context';
import { allyUnderPressure, visibleAllies } from '../src/group-awareness';
import { castTurn, reagentGraphics } from '../src/mage-combat';
import { requestSpell } from '../src/spell-action';
import { required } from './behavior-fixture';
import { socialFixture } from './social-fixture';

function groupFixture() {
  const f = socialFixture('mage');
  f.world.partyMembers.add(2);
  f.world.entities.set(2, {
    serial: 2,
    kind: 'mobile',
    graphic: 400,
    notoriety: 1,
    name: 'Ada',
    position: { ...required(f.world.position), x: 102 },
    hits: 50,
    maxHits: 100,
    healthAt: Date.now()
  });
  f.world.entities.set(3, {
    serial: 3,
    kind: 'mobile',
    graphic: 3,
    notoriety: 3,
    name: 'a zombie',
    position: { ...required(f.world.position), x: 105 },
    hits: 50,
    maxHits: 100
  });
  required(f.template.archetype).primarySkills = ['Magery'];
  f.world.skills.set(skillId('Magery'), { value: 100, base: 100, cap: 100, lock: 0 });
  f.world.skills.set(skillId('Healing'), { value: 80, base: 80, cap: 100, lock: 0 });
  for (const [i, graphic] of Object.values(reagentGraphics).entries())
    f.world.entities.set(50 + i, { serial: 50 + i, kind: 'item', graphic, parent: 10, amount: 10 });
  f.session.inspect = async () => {};
  f.session.useSkill = () => {
    f.world.target = { id: 1, ground: false, flags: 0 };
  };
  f.session.use = () => {
    f.world.target = { id: 1, ground: false, flags: 0 };
  };
  const ctx = {
    ...f.ctx,
    serial: 1,
    status: () => required(f.world.status),
    contents: () => f.world.childrenOf(10),
    count: (graphic: number) =>
      f.world
        .childrenOf(10)
        .filter((e) => e.graphic === graphic)
        .reduce((n, e) => n + (e.amount ?? 1), 0),
    dead: () => false,
    trip: { loot: [], killsSinceBank: 0, pending: 'hunt' },
    state: { inCombat: false, fightingSerial: null },
    stats: { completedBandages: 0, failedBandages: 0 },
    nearby: () => [...f.world.entities.values()].filter((e) => e.kind === 'mobile'),
    escapeNavigate: f.ctx.navigate,
    deadline: Date.now() + 60_000
  } as unknown as FighterContext;
  return { ...f, ctx };
}

test('party membership comes from the received roster and removal replaces it', () => {
  const { world } = groupFixture();
  const packet = Buffer.alloc(15);
  packet[0] = 0xbf;
  packet.writeUInt16BE(15, 1);
  packet.writeUInt16BE(6, 3);
  packet[5] = 1;
  packet[6] = 2;
  packet.writeUInt32BE(1, 7);
  packet.writeUInt32BE(4, 11);
  world.apply(packet);
  expect([...world.partyMembers]).toEqual([1, 4]);
  const empty = Buffer.alloc(11);
  empty[0] = 0xbf;
  empty.writeUInt16BE(11, 1);
  empty.writeUInt16BE(6, 3);
  empty[5] = 2;
  empty[6] = 0;
  empty.writeUInt32BE(1, 7);
  world.apply(empty);
  expect(world.partyMembers.size).toBe(0);
  expect(() => world.apply(packet.subarray(0, 14))).toThrow('Invalid party member list');
});

test('support favors the member under pressure and rejects stale, hostile or unrelated patients', () => {
  const { world, session } = groupFixture();
  world.partyMembers.add(4);
  world.entities.set(4, { ...required(world.entities.get(2)), serial: 4, hits: 65 });
  world.swings.set(3, { target: 4, at: Date.now() });
  world.swings.set(5, { target: 4, at: Date.now() });
  expect(allyUnderPressure(session)?.serial).toBe(4);
  required(world.entities.get(4)).healthAt = Date.now() - 20_000;
  expect(allyUnderPressure(session)?.serial).toBe(2);
  required(world.entities.get(2)).notoriety = 6;
  expect(allyUnderPressure(session)).toBeUndefined();
  expect(visibleAllies(session)).toHaveLength(1);
});

test('a mage heals the injured companion before casting offensively and records observed recovery', async () => {
  const { session, world, ctx, checkpoint } = groupFixture();
  required(world.status).mana = 100;
  let target: number | undefined;
  session.target = (aim) => {
    target = aim?.serial;
    world.target = null;
    if (target === 2) required(world.entities.get(2)).hits = 90;
  };
  expect(await castTurn(ctx, required(world.entities.get(3)))).toBe(true);
  expect(target).toBe(2);
  expect(required(world.status).hits).toBe(100);
  expect(checkpoint.personal?.episodes[0]?.kind).toBe('support');
});

test('lack of usable healing cannot turn an offensive spell against the companion', async () => {
  const { session, world, ctx } = groupFixture();
  for (const item of world.childrenOf(10)) if (item.graphic !== 0xeed) world.entities.delete(item.serial);
  // Magic Arrow uses Sulfurous Ash; healing also needs Garlic and Ginseng.
  world.entities.set(60, {
    serial: 60,
    kind: 'item',
    graphic: reagentGraphics.SulfurousAsh ?? 0,
    parent: 10,
    amount: 10
  });
  required(world.status).mana = 10;
  let target: number | undefined;
  session.target = (aim) => {
    target = aim?.serial;
    world.target = null;
    if (target === 3) required(world.entities.get(3)).hits = 30;
  };
  await castTurn(ctx, required(world.entities.get(3)));
  expect(target).toBe(3);
  expect(required(world.entities.get(2)).hits).toBe(50);
});

test('healing an ally is not confirmed by the caster regenerating health', async () => {
  const { session, world, ctx } = groupFixture();
  required(world.status).hits = 80;
  session.target = () => {
    world.target = null;
    required(world.status).hits = 90;
  };
  expect(await requestSpell(ctx, { id: 3, name: 'Heal', circle: 1 }, required(world.entities.get(2)), new Set())).toBe(
    'unknown'
  );
});

test('a healthy trained healer bandages a nearby injured companion without abandoning self safety', async () => {
  const { session, world, ctx } = groupFixture();
  world.entities.set(70, { serial: 70, kind: 'item', graphic: 0xe21, parent: 10, amount: 10 });
  let target: number | undefined;
  session.target = (aim) => {
    target = aim?.serial;
    world.target = null;
  };
  await createFighterCombat(ctx).heal();
  expect(target).toBe(2);
  required(world.status).hits = 30;
  const selfTargets: number[] = [];
  session.target = (aim) => {
    if (aim?.serial) selfTargets.push(aim.serial);
    world.target = null;
  };
  await createFighterCombat(ctx).heal();
  expect(selfTargets).toEqual([1]);
});

test('ranged positioning favors the protected side of an observed front-line companion', async () => {
  const { groupPositionCost } = await import('../src/group-awareness');
  const { world, session } = groupFixture();
  const enemy = required(world.entities.get(3));
  world.swings.set(3, { target: 2, at: Date.now() });
  expect(groupPositionCost(session, { x: 100, y: 100 }, enemy)).toBeLessThan(
    groupPositionCost(session, { x: 110, y: 100 }, enemy)
  );
  world.swings.clear();
  expect(groupPositionCost(session, { x: 110, y: 100 }, enemy)).toBe(0);
});
