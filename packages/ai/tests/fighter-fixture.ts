import { expect } from 'bun:test';

import { corpse as corpseGraphic } from '@gemwright/common/game/items';
import { skillId } from '@gemwright/common/game/skills';
import { Layer } from '@gemwright/network/layers';

import { type FighterContext, homeOf, newFighterStats } from '../src/fighter-context';
import { createFighterRecovery } from '../src/fighter-recovery';
import { checkFighter } from '../src/fighter-safety';
import { required } from './behavior-fixture';
import { socialFixture } from './social-fixture';

export function fighterFixture() {
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
  f.session.setWarMode = () => {};
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

export function corpseRecoveryFixture() {
  const f = fighterFixture();
  f.ctx.home = { ...f.ctx.home, town: { ...required(f.world.position) } };
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
