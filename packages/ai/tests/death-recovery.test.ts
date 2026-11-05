import { expect, spyOn, test } from 'bun:test';

import { ActionInterrupted } from '../src/action-errors';
import { urgentAction } from '../src/action-purpose';
import { createFighterRecovery } from '../src/fighter-recovery';
import { createFighterTown } from '../src/fighter-town';
import { distance } from '../src/navigation';
import { required } from './behavior-fixture';
import { corpseRecoveryFixture } from './fighter-fixture';
import { useTestWorld } from './world-fixture';

useTestWorld();

// Synthetic replay of Bowman's logged timeout/return/death sequence, not a complete packet capture.
const corpseSite = { x: 3371, y: 2678, z: 27, direction: 0 };
const refuge = { x: 3460, y: 2558, z: 35, direction: 0 };

function scenario() {
  const f = corpseRecoveryFixture();
  f.world.entities.delete(2);
  f.world.position = { ...refuge };
  required(f.world.entities.get(1)).position = f.world.position;
  f.ctx.home = { ...f.ctx.home, town: refuge };
  f.ctx.trip.deathSite = { ...corpseSite };
  required(f.world.entities.get(30)).position = { ...corpseSite };
  f.ctx.dead = () => [0x192, 0x193].includes(f.world.entities.get(1)?.graphic ?? 0);
  f.checkpoint.hunting = f.ctx.trip;
  const phases: { phase: string; position: { x: number; y: number } }[] = [];
  const saves: string[] = [];
  f.ctx.phase = (phase) => phases.push({ phase, position: { ...f.ctx.position() } });
  f.ctx.persist = () => saves.push(JSON.stringify(f.ctx.trip));
  const walks: { x: number; y: number }[] = [];
  const escapes: { x: number; y: number }[] = [];
  f.ctx.navigate = async (point) => {
    f.ctx.check();
    walks.push({ ...point });
    f.world.position = { ...f.ctx.position(), ...point };
    required(f.world.entities.get(1)).position = f.world.position;
    f.ctx.check();
  };
  f.ctx.escapeNavigate = async (point) => {
    await urgentAction(f.session, 'escape', async () => {
      f.ctx.check();
      escapes.push({ ...point });
      f.world.position = { ...f.ctx.position(), ...point };
      required(f.world.entities.get(1)).position = f.world.position;
      f.ctx.check();
    });
  };
  let rests = 0;
  const services = {
    equip: async () => {},
    prepareEquipment: async () => {
      f.world.entities.set(40, { serial: 40, kind: 'item', graphic: 0x13b9, parent: 1, layer: 1 });
    },
    rest: async () => {
      rests++;
    }
  };
  const controller = () => createFighterRecovery(f.ctx, services);
  const restart = () => {
    f.ctx.trip = JSON.parse(saves.at(-1) ?? JSON.stringify(f.ctx.trip));
    f.checkpoint.hunting = f.ctx.trip;
    return controller();
  };
  return { ...f, phases, saves, walks, escapes, services, controller, restart, rests: () => rests };
}

function offerResurrection(f: ReturnType<typeof scenario>) {
  f.world.gumps.set('healer', {
    serial: 99,
    id: 1,
    packed: false,
    layout:
      '{ xmfhtmlgump 0 20 400 35 1011022 0 0 } { xmfhtmlgump 50 55 300 140 1011025 1 1 } { button 65 227 4005 4007 1 0 1 } { xmfhtmlgump 100 230 110 35 1011011 0 0 }'
  });
  f.session.replyGump = () => {
    required(f.world.entities.get(1)).graphic = 0x190;
    required(f.world.status).hits = 100;
    f.world.position = { ...refuge };
    required(f.world.entities.get(1)).position = f.world.position;
    f.world.gumps.clear();
  };
}

function damage(f: ReturnType<typeof scenario>, hits: number) {
  const packet = Buffer.alloc(9);
  packet[0] = 0xa1;
  packet.writeUInt32BE(1, 1);
  packet.writeUInt16BE(100, 5);
  packet.writeUInt16BE(hits, 7);
  f.world.apply(packet);
}

function hostile(f: ReturnType<typeof scenario>) {
  f.world.entities.set(2, {
    serial: 2,
    kind: 'mobile',
    graphic: 39,
    notoriety: 6,
    name: 'a mongbat',
    position: { ...corpseSite, x: corpseSite.x + 1 }
  });
}

test('Bowman timeout: failed corpse self-loot returns to refuge before recovery yields', async () => {
  const f = scenario();
  f.session.use = () => {};
  await f.controller().recover();
  expect(f.ctx.stats.recoveredItems).toBe(0);
  expect(f.ctx.trip.recovery).toMatchObject({ stage: 'corpse', attempts: 1 });
  expect(f.ctx.trip.pending).toBe('return');
  expect(f.escapes).toContainEqual(refuge);
  expect(distance(f.ctx.position(), refuge)).toBeLessThanOrEqual(4);
  expect(f.phases.some((p) => p.phase === 'corpse-recovered' || p.phase === 'recovery-ready')).toBe(false);
});

test('two failed corpse attempts survive controller restarts and cannot become a third attempt', async () => {
  const f = scenario();
  let clicks = 0;
  f.session.use = () => {
    clicks++;
  };
  let now = Date.now();
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  try {
    for (let turn = 0; turn < 3; turn++) {
      await f.restart().recover();
      now += 61_000;
    }
    expect(clicks).toBe(2);
    expect(f.ctx.stats.abandonedCorpses).toBe(1);
    expect(f.ctx.trip.deathSite).toBeUndefined();
    expect(f.ctx.position()).toMatchObject(refuge);
  } finally {
    clock.mockRestore();
  }
});

for (const event of ['hostile', 'damage', 'poison'] as const)
  test(`${event} observed during corpse approach aborts retrieval before the corpse click`, async () => {
    const f = scenario();
    const navigate = f.ctx.navigate;
    f.ctx.navigate = async (point, range) => {
      await navigate(point, range);
      if (distance(point, corpseSite) <= 1) {
        if (event === 'hostile') hostile(f);
        else if (event === 'damage') damage(f, 80);
        else f.world.poisonLevel = 1;
        f.ctx.check();
      }
    };
    await f.controller().recover();
    expect(f.counts().clicks).toBe(0);
    expect(f.ctx.stats.abandonedCorpses).toBe(1);
    expect(f.ctx.trip.pending).toBe('return');
    expect(f.ctx.position()).toMatchObject(refuge);
    expect(f.ctx.state.recoveringCorpse).toBe(false);
  });

test('failed escape never reports a refuge reached, health recovery or readiness', async () => {
  const f = scenario();
  f.session.use = () => {};
  f.ctx.escapeNavigate = async () => {};
  await expect(f.controller().recover()).rejects.toThrow();
  expect(f.ctx.trip.recovery?.stage).not.toBe('ready');
  expect(f.phases.some((p) => p.phase === 'recovering-health' || p.phase === 'recovery-ready')).toBe(false);
});

test('low health or poisoning cannot finish replacement recovery even when rest returns', async () => {
  for (const event of ['health', 'poison'] as const) {
    const f = scenario();
    required(f.ctx.trip.recovery).stage = 'equipment';
    if (event === 'health') required(f.world.status).hits = 50;
    else f.world.poisonLevel = 1;
    await f.controller().recover();
    expect(f.rests()).toBe(1);
    expect(f.ctx.trip.recovery?.stage).toBe('equipment');
    expect(f.phases.some((p) => p.phase === 'recovery-ready')).toBe(false);
  }
});

test('missing replacement equipment cannot be reported as recovered and equipped', async () => {
  const f = scenario();
  required(f.ctx.trip.recovery).stage = 'equipment';
  f.services.prepareEquipment = async () => {};
  await f.controller().recover();
  expect(f.ctx.trip.recovery?.stage).toBe('equipment');
  expect(f.phases.some((p) => p.phase === 'recovery-ready')).toBe(false);
});

test('safe self-loot is observed, followed by return to refuge before readiness', async () => {
  const f = scenario();
  await f.controller().recover();
  expect(f.counts().clicks).toBe(1);
  expect(f.ctx.stats.recoveredItems).toBe(2);
  expect(f.ctx.trip.recovery?.stage).toBe('ready');
  expect(f.ctx.trip.pending).toBe('return');
  expect(f.ctx.position()).toMatchObject(refuge);
  expect(f.phases.filter((p) => p.phase === 'recovery-ready').every((p) => distance(p.position, refuge) <= 4)).toBe(
    true
  );
});

test('a cancelled approach preserves recovery state without claiming success', async () => {
  const f = scenario();
  const interrupted = new ActionInterrupted('Player interaction interrupted retrieval');
  f.ctx.navigate = async () => {
    throw interrupted;
  };
  await expect(f.controller().recover()).rejects.toBe(interrupted);
  expect(f.ctx.trip.recovery?.stage).toBe('corpse');
  expect(f.counts().clicks).toBe(0);
  expect(f.ctx.state.recoveringCorpse).toBe(false);
});

test('rest cannot claim to be in town when navigation leaves the resident at the death site', async () => {
  const f = scenario();
  f.world.position = { ...corpseSite };
  required(f.world.status).hits = 70;
  f.ctx.navigate = async () => {};
  f.ctx.escapeNavigate = async () => {};
  const town = createFighterTown(f.ctx, async () => {
    throw new Error('Unsafe rest reached healing');
  });
  await expect(town.rest()).rejects.toThrow();
  expect(f.phases.some((p) => p.phase === 'recovering-health')).toBe(false);
});

test('death during retrieval abandons that corpse after resurrection rather than resetting the attempt budget', async () => {
  const f = scenario();
  const navigate = f.ctx.navigate;
  let diedOnApproach = false;
  f.ctx.navigate = async (point, range) => {
    await navigate(point, range);
    if (!diedOnApproach && distance(point, corpseSite) <= 1 && f.ctx.state.recoveringCorpse) {
      diedOnApproach = true;
      required(f.world.entities.get(1)).graphic = 0x192;
      required(f.world.status).hits = 0;
      f.world.deathSite = { ...corpseSite };
      f.ctx.check();
    }
  };
  offerResurrection(f);
  await f.controller().recover();
  expect(diedOnApproach).toBe(true);
  expect(f.ctx.stats.resurrections).toBe(1);
  expect(f.ctx.stats.abandonedCorpses).toBe(1);
  expect(f.counts().clicks).toBe(0);
  expect(f.walks.filter((p) => distance(p, corpseSite) <= 1)).toHaveLength(1);
  expect(f.ctx.trip.recovery).toMatchObject({ stage: 'ready', abandonCorpse: true });
  expect(f.ctx.trip.deathSite).toBeUndefined();
  expect(f.ctx.position()).toMatchObject(refuge);
  await f.restart().recover();
  expect(f.walks.filter((p) => distance(p, corpseSite) <= 1)).toHaveLength(1);
});

test('reconnect after resurrection keeps the decision to abandon a lethal corpse', async () => {
  const f = scenario();
  Object.assign(required(f.ctx.trip.recovery), { stage: 'healer', abandonCorpse: true });
  await f.restart().recover();
  expect(f.ctx.stats.abandonedCorpses).toBe(1);
  expect(f.ctx.trip.recovery?.stage).toBe('ready');
  expect(f.walks.filter((p) => distance(p, corpseSite) <= 1)).toHaveLength(0);
  expect(f.counts().clicks).toBe(0);
});

test('a decision provider cannot reopen corpse recovery after the local attempt limit', async () => {
  const { DecisionCoordinator } = await import('../src/decisions');
  const { validateDecisionConfig } = await import('../src/decision-provider');
  const f = scenario();
  required(f.ctx.trip.recovery).attempts = 2;
  const decisions = new DecisionCoordinator(validateDecisionConfig({ provider: 'local' }), () => {});
  const choose = spyOn(decisions, 'choose');
  try {
    await createFighterRecovery(f.ctx, { ...f.services, decisions }).recover();
    expect(choose).not.toHaveBeenCalled();
    expect(f.counts().clicks).toBe(0);
    expect(f.ctx.trip.deathSite).toBeUndefined();
  } finally {
    choose.mockRestore();
  }
});

test('an attempt is persisted before travel and readiness only after the observed return', async () => {
  const f = scenario();
  const navigate = f.ctx.navigate;
  let savedBeforeTravel = false;
  f.ctx.navigate = async (point, range) => {
    if (distance(point, corpseSite) <= 1)
      savedBeforeTravel = JSON.parse(f.saves.at(-1) ?? '{}').recovery?.attempts === 1;
    await navigate(point, range);
  };
  await f.controller().recover();
  expect(savedBeforeTravel).toBe(true);
  expect(JSON.parse(required(f.saves.at(-1))).recovery.stage).toBe('ready');
  expect(f.ctx.position()).toMatchObject(refuge);
});

test('a service moving the resident away cannot turn replacement recovery into readiness', async () => {
  const f = scenario();
  required(f.ctx.trip.recovery).stage = 'equipment';
  f.services.rest = async () => {
    f.world.position = { ...corpseSite };
  };
  await f.controller().recover();
  expect(f.ctx.trip.recovery?.stage).toBe('equipment');
  expect(f.phases.some((p) => p.phase === 'recovery-ready')).toBe(false);
});

test('a ghost with no route out of a dungeon cannot be reported as resurrected or ready', async () => {
  const f = scenario();
  f.world.position = { x: 6000, y: 3500, z: 0, direction: 0 };
  required(f.world.entities.get(1)).position = f.world.position;
  required(f.world.entities.get(1)).graphic = 0x192;
  required(f.world.status).hits = 0;
  f.world.deathSite = { ...f.world.position };
  f.terrain.pathAsync = async () => null;
  await expect(f.controller().recover()).rejects.toThrow();
  expect(f.ctx.dead()).toBe(true);
  expect(f.ctx.stats.resurrections).toBe(0);
  expect(f.ctx.trip.recovery?.stage).toBe('healer');
  expect(f.phases.some((p) => p.phase === 'resurrected' || p.phase === 'recovery-ready')).toBe(false);
});

test('a replacement weapon only observed in the backpack cannot be reported as equipped', async () => {
  const f = scenario();
  required(f.ctx.trip.recovery).stage = 'equipment';
  f.services.prepareEquipment = async () => {
    f.world.entities.set(40, { serial: 40, kind: 'item', graphic: 0x13b9, parent: 10 });
  };
  await f.controller().recover();
  expect(f.ctx.trip.recovery?.stage).toBe('equipment');
  expect(f.phases.some((p) => p.phase === 'recovery-ready')).toBe(false);
});

test('death while replacing equipment cannot restart retrieval at the lethal site', async () => {
  const f = scenario();
  required(f.ctx.trip.recovery).stage = 'equipment';
  f.world.position = { ...corpseSite };
  required(f.world.entities.get(1)).position = f.world.position;
  required(f.world.entities.get(1)).graphic = 0x192;
  required(f.world.status).hits = 0;
  f.world.deathSite = { ...corpseSite };
  offerResurrection(f);
  await f.controller().recover();
  expect(f.ctx.stats.resurrections).toBe(1);
  expect(f.counts().clicks).toBe(0);
  expect(f.ctx.trip.recovery).toMatchObject({ stage: 'ready', abandonCorpse: true });
  expect(f.ctx.position()).toMatchObject(refuge);
});
