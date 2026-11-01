import { expect, test } from 'bun:test';

import { corpse as corpseGraphic } from '@gemwright/common/game/items';
import { skillId } from '@gemwright/common/game/skills';
import { Layer } from '@gemwright/network/layers';

import { ActionInterrupted } from '../src/action-errors';
import { Blocked } from '../src/blocked';
import { hurtOnTheWay } from '../src/cemeteries';
import { decisionContext } from '../src/decision-context';
import { validateDecisionConfig } from '../src/decision-provider';
import { DecisionCoordinator } from '../src/decisions';
import { Ambushed, type FighterContext, homeOf, newFighterStats } from '../src/fighter-context';
import { engageable } from '../src/fighter-prey';
import { createFighterRecovery } from '../src/fighter-recovery';
import { checkFighter } from '../src/fighter-safety';
import { initializeFighter } from '../src/fighter-startup';
import { createFighterTown } from '../src/fighter-town';
import { planTownTrip, townNeed } from '../src/fighter-trip';
import { LIFE_GOAL } from '../src/life-goal';
import { errand } from '../src/objective-memory';
import { temperamentOf } from '../src/temperament';
import { required } from './behavior-fixture';
import { socialFixture } from './social-fixture';

function fixture() {
  const f = socialFixture('swordsman');
  f.template.behavior.activities = ['hunt'];
  f.template.creation = { ...f.template.creation, city: 'Britain', skills: {} };
  required(f.template.archetype).primarySkills = ['Swordsmanship'];
  required(f.world.entities.get(1)).name = 'Dunstan Miller';
  for (const skill of ['Swordsmanship', 'Tactics', 'Anatomy', 'Healing', 'MagicResist'])
    f.world.skills.set(skillId(skill), { base: 100, value: 100, cap: 100, lock: 0 });
  required(f.world.status).armor = 40;
  required(f.world.status).gold = 0;
  required(f.world.entities.get(11)).amount = 0;
  f.checkpoint.funds = { bank: 1000, at: Date.now() };
  f.session.refreshStatus = async () => {};
  f.session.refreshSkills = async () => {};
  const ctx: FighterContext = {
    ...f.ctx,
    serial: 1,
    home: homeOf('Britain'),
    deadline: Date.now() + 300_000,
    trip: { loot: [], killsSinceBank: 0, pending: 'hunt' },
    backpack: () => 10,
    refreshBackpack: async () => {},
    contents: (container = 10) => f.world.childrenOf(container),
    count: (graphic) =>
      f.world
        .childrenOf(10)
        .filter((item) => item.graphic === graphic)
        .reduce((sum, item) => sum + (item.amount ?? 1), 0),
    status: () => required(f.world.status),
    dead: () => false,
    nearby: () => [...f.world.entities.values()].filter((item) => item.kind === 'mobile' && item.serial !== 1),
    open: async () => {
      throw new Error('Corpse must use self-loot, not a manual container pass');
    },
    escapeNavigate: f.ctx.navigate,
    state: {
      inCombat: false,
      recovering: false,
      recoveringCorpse: false,
      abandonedBandageCursor: false,
      fightingSerial: null
    },
    stats: newFighterStats()
  };
  ctx.check = () => checkFighter(ctx, () => ({ emergency: false, reason: '', largestHit: 0, damagePerSecond: 0 }));
  ctx.navigate = async (point, range) => {
    ctx.check();
    await f.ctx.navigate(point, range);
    ctx.check();
  };
  return { ...f, ctx };
}

function corpseFixture() {
  const f = fixture();
  const site = { ...required(f.world.position), x: 101 };
  f.ctx.trip.recovery = { stage: 'corpse', diedAt: new Date().toISOString(), ownerName: 'Dunstan Miller', attempts: 0 };
  f.ctx.trip.deathSite = site;
  f.world.entities.set(30, {
    serial: 30,
    kind: 'item',
    graphic: corpseGraphic,
    position: site,
    properties: [{ cliloc: 1046414, arguments: 'Dunstan Miller' }]
  });
  f.world.entities.set(31, { serial: 31, kind: 'item', graphic: 0x13b9, parent: 30 });
  f.world.entities.set(32, { serial: 32, kind: 'item', graphic: 0x13db, parent: 30 });
  f.world.entities.set(2, {
    serial: 2,
    kind: 'mobile',
    graphic: 3,
    name: 'a zombie',
    notoriety: 3,
    position: { ...site, x: 102 }
  });
  let clicks = 0,
    shopping = 0,
    rests = 0;
  f.session.use = (serial) => {
    expect(serial).toBe(30);
    clicks++;
    f.world.entities.set(31, { ...required(f.world.entities.get(31)), parent: 1, layer: Layer.OneHanded });
    f.world.entities.set(32, { ...required(f.world.entities.get(32)), parent: 1, layer: Layer.InnerTorso });
  };
  const recovery = createFighterRecovery(f.ctx, {
    equip: async () => {},
    prepareEquipment: async () => {
      shopping++;
    },
    rest: async () => {
      rests++;
    }
  });
  return { ...f, recovery, counts: () => ({ clicks, shopping, rests }) };
}

test('a healthy fighter retrieves gear with one double-click despite a nearby zombie and stays to fight', async () => {
  const f = corpseFixture();
  await f.recovery.recover();
  expect(f.counts()).toEqual({ clicks: 1, shopping: 0, rests: 0 });
  expect(f.ctx.trip.recovery).toMatchObject({ stage: 'ready', attempts: 1 });
  expect(f.ctx.trip.deathSite).toBeUndefined();
  expect(f.ctx.trip.pending).toBe('hunt');
  expect(f.ctx.stats.recoveredItems).toBe(2);
  expect(f.ctx.stats.abandonedCorpses).toBe(0);
  expect(f.world.entities.get(32)?.parent).toBe(1);
});

test('an interrupted approach preserves the corpse target and a later attempt can recover it', async () => {
  const f = corpseFixture();
  const navigate = f.ctx.navigate;
  f.ctx.navigate = async () => {
    throw new Blocked('unreachable', 'Door temporarily closed');
  };
  await f.recovery.recover();
  expect(f.ctx.trip.recovery?.stage).toBe('corpse');
  expect(f.ctx.trip.recovery?.retryAt).toBeGreaterThan(Date.now());
  expect(f.ctx.trip.deathSite).toBeDefined();
  expect(f.ctx.stats.abandonedCorpses).toBe(0);
  f.ctx.navigate = navigate;
  required(f.ctx.trip.recovery).retryAt = 0;
  await f.recovery.recover();
  expect(f.counts().clicks).toBe(1);
  expect(f.ctx.trip.recovery).toMatchObject({ stage: 'ready', attempts: 2 });
});

test('a corpse click without observed belongings is never reported as successful recovery', async () => {
  const f = corpseFixture();
  f.session.use = () => {};
  await f.recovery.recover();
  expect(f.ctx.trip.recovery?.stage).toBe('corpse');
  expect(f.ctx.trip.deathSite).toBeDefined();
  expect(f.ctx.stats.recoveredItems).toBe(0);
});

test('healthy fighters without bandages or potions keep hunting viable low-level monsters', async () => {
  const f = fixture();
  f.world.entities.set(20, { serial: 20, kind: 'item', graphic: 0x13b9, parent: 1, layer: Layer.OneHanded });
  expect(townNeed(f.ctx)).toBeNull();
  for (const [name, graphic] of [
    ['a zombie', 3],
    ['a skeleton', 50],
    ['a mongbat', 39]
  ] as const) {
    f.world.entities.delete(2);
    const target = {
      serial: 2,
      kind: 'mobile' as const,
      graphic,
      name,
      notoriety: 3,
      position: { ...required(f.world.position), x: 101 }
    };
    f.world.entities.set(2, target);
    expect(engageable(f.ctx, target).ok).toBe(true);
  }
  f.world.entities.delete(2);
  f.template.behavior.temperament = { ...temperamentOf('test'), carriedGold: 100 };
  required(f.world.entities.get(11)).amount = 120;
  const decisions = new DecisionCoordinator(validateDecisionConfig({ provider: 'local' }), () => {});
  expect(await planTownTrip(f.ctx, decisions)).toBeNull();
  expect(f.checkpoint.decisions?.history.at(-1)?.selected).toBe('keep-hunting');
  expect(f.checkpoint.decisions?.history.at(-1)?.candidates).toContain('keep-hunting');
});

test('a failed nearby supply opportunity does not become a tour of other shops or an immediate retry', async () => {
  const f = fixture();
  const shop = required(f.ctx.home.shops[0]);
  f.world.position = { ...required(f.world.position), ...shop };
  let visits = 0;
  f.ctx.navigate = async () => {
    visits++;
  };
  const town = createFighterTown(f.ctx, async () => {});
  await town.restock();
  await town.restock();
  expect(visits).toBe(1);
});

test('errands propagate plan cancellation instead of swallowing it as a vendor failure', async () => {
  const f = fixture();
  await expect(
    errand(f.ctx, 'restock:test', 'optional supplies', async () => {
      throw new ActionInterrupted('Plan changed');
    })
  ).rejects.toThrow('Plan changed');
});

test('startup only reconciles observations and every decision context carries the life goal', async () => {
  const f = corpseFixture();
  await initializeFighter(f.ctx);
  expect(f.counts()).toEqual({ clicks: 0, shopping: 0, rests: 0 });
  expect(f.ctx.trip.recovery?.stage).toBe('corpse');
  expect(decisionContext(f.checkpoint).lifeGoal).toBe(LIFE_GOAL);
});

test('hurt by a caster it cannot see swinging, a healthy fighter turns on the caster instead of going home', () => {
  const { world, ctx } = fixture();
  world.entities.set(60, { serial: 60, kind: 'item', graphic: 0x13ff, parent: 1, layer: Layer.OneHanded });
  // A gazer casting from twelve tiles: no swing packet names it, only the damage arrives.
  world.entities.set(70, {
    serial: 70,
    kind: 'mobile',
    graphic: 22,
    name: 'a gazer',
    notoriety: 3,
    position: { x: 112, y: 100, z: 0, direction: 0 }
  });
  world.healthChanges.push({ at: Date.now(), hits: 90, maxHits: 100, damage: 10, healed: 0 });
  expect(() => hurtOnTheWay(ctx)).toThrow(Ambushed);
});
