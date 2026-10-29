import { expect, spyOn, test } from 'bun:test';

import { validateConnection } from '@gemwright/network/connection';
import { variable } from '@gemwright/network/packets';
import { PlayerSession } from '@gemwright/network/session';
import { WorldView } from '@gemwright/network/world';

import { recentlyHurt } from '../src/action-purpose';
import { beingAttacked, interruptForDanger } from '../src/danger-response';
import { Perception } from '../src/perception';
import { perceptionFor, startPerception } from '../src/perception-session';

function status(world: WorldView, health = 100) {
  const packet = Buffer.alloc(73);
  packet[0] = 0x11;
  packet.writeUInt16BE(73, 1);
  packet.writeUInt32BE(1, 3);
  packet[42] = 5;
  for (const [offset, value] of [
    [37, health],
    [39, 100],
    [44, 50],
    [46, 50],
    [48, 50],
    [50, 80],
    [52, 100],
    [54, 25],
    [56, 50],
    [64, 20],
    [66, 200]
  ])
    packet.writeUInt16BE(value ?? 0, offset);
  world.apply(packet);
}
function mobile(world: WorldView, serial = 2, x = 101, y = 100, graphic = 400, notoriety = 1) {
  const packet = Buffer.alloc(17);
  packet[0] = 0x77;
  packet.writeUInt32BE(serial, 1);
  packet.writeUInt16BE(graphic, 5);
  packet.writeUInt16BE(x, 7);
  packet.writeUInt16BE(y, 9);
  packet[16] = notoriety;
  world.apply(packet);
}
function swing(world: WorldView, attacker = 2, target = 1) {
  const packet = Buffer.alloc(10);
  packet[0] = 0x2f;
  packet.writeUInt32BE(attacker, 2);
  packet.writeUInt32BE(target, 6);
  world.apply(packet);
}
function delta(world: WorldView, opcode: number, current: number, max = 100, serial = 1) {
  const packet = Buffer.alloc(9);
  packet[0] = opcode;
  packet.writeUInt32BE(serial, 1);
  packet.writeUInt16BE(max, 5);
  packet.writeUInt16BE(current, 7);
  world.apply(packet);
}
function facet(world: WorldView, map: number) {
  world.apply(variable(0xbf, Buffer.from([0, 8, map])));
}
function enter(world: WorldView) {
  const packet = Buffer.alloc(37);
  packet[0] = 0x1b;
  packet.writeUInt32BE(1, 1);
  packet.writeUInt16BE(100, 11);
  packet.writeUInt16BE(100, 13);
  world.apply(packet);
  facet(world, 1);
  world.apply(Buffer.from([0x55]));
}
function setup() {
  let now = 1_000_000;
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  const world = new WorldView();
  const model = new Perception(world);
  enter(world);
  status(world);
  return {
    world,
    model,
    advance: (ms: number) => {
      now += ms;
    },
    close: () => {
      model.dispose();
      clock.mockRestore();
    }
  };
}

test('perception updates during an ongoing wait without rebuilding the world or polling the work loop', async () => {
  const f = setup();
  try {
    const before = f.model.stats.reconciliations;
    let finish: (() => void) | undefined;
    const working = new Promise<void>((resolve) => {
      finish = resolve;
    });
    mobile(f.world);
    swing(f.world);
    delta(f.world, 0xa1, 70);
    expect(f.model.underAttack()).toBe(true);
    expect(f.model.self().health).toMatchObject({ kind: 'observed', value: { current: 70 } });
    expect(f.model.self().damagedRecently).toBe(true);
    expect(f.model.stats.reconciliations).toBe(before);
    finish?.();
    await working;
  } finally {
    f.close();
  }
});

test('notoriety is a risk signal; an innocent attacking and a murderer ignoring us have different intent evidence', () => {
  const f = setup();
  try {
    mobile(f.world, 2, 101, 100, 400, 6);
    expect(f.model.entity(2)?.intent.kind).toBe('unknown');
    expect(f.model.entity(2)?.risk.value).toBe('caution');
    mobile(f.world, 3, 102, 100, 400, 1);
    swing(f.world, 3);
    expect(f.model.entity(3)?.intent).toMatchObject({ kind: 'observed', value: 'attacking-self' });
    expect(f.model.entity(3)?.risk).toMatchObject({ kind: 'inferred', value: 'immediate' });
    swing(f.world, 2, 99);
    expect(f.model.entity(2)?.intent).toMatchObject({ value: 'attacking-other' });
    f.advance(3001);
    expect(f.model.underAttack()).toBe(false);
    expect(f.model.entity(3)?.intent.kind).toBe('unknown');
  } finally {
    f.close();
  }
});

test('an unseen attacker remains attack evidence without inventing its location, type, or name', () => {
  const f = setup();
  try {
    swing(f.world, 999);
    expect(f.world.observations.entityAt.has(999)).toBe(false);
    expect(f.model.underAttack()).toBe(true);
    expect(f.model.entity(999)).toBeUndefined();
    expect(f.model.visibleEntities()).toEqual([]);
  } finally {
    f.close();
  }
});

test('view boundaries, negotiated ranges and facet changes do not turn unseen entities into deaths', () => {
  const f = setup();
  try {
    mobile(f.world, 2, 119);
    expect(f.model.viewRange().kind).toBe('reference');
    expect(f.model.entity(2)?.visible).toBe(false);
    f.world.apply(Buffer.from([0xc8, 24]));
    expect(f.model.viewRange()).toMatchObject({ kind: 'observed', value: 24 });
    expect(f.model.entity(2)?.visible).toBe(true);
    facet(f.world, 0);
    expect(f.model.entity(2)?.visible).toBe(false);
    expect(f.model.entity(2)?.presence).toBe('unseen');
    expect(f.world.deaths.has(2)).toBe(false);
    mobile(f.world, 2, 101);
    expect(f.model.entity(2)?.visible).toBe(true);
    f.world.apply(Buffer.from([0x1d, 0, 0, 0, 2]));
    expect(f.model.entity(2)?.presence).toBe('removed');
    expect(f.world.deaths.has(2)).toBe(false);
  } finally {
    f.close();
  }
});

test('stale status fields stay unknown when a different status field is refreshed', () => {
  const f = setup();
  try {
    f.advance(40_000);
    delta(f.world, 0xa1, 90);
    f.advance(20_001);
    expect(f.model.self().health.kind).toBe('observed');
    expect(f.model.self().mana).toMatchObject({ kind: 'unknown', reason: 'stale' });
    expect(f.model.self().weight.kind).toBe('unknown');
    f.model.reconcile();
    expect(f.model.self().mana.kind).toBe('unknown');
    delta(f.world, 0xa2, 31, 50);
    expect(f.model.self().mana).toMatchObject({ kind: 'observed', value: { current: 31, max: 50 } });
    expect(f.model.self().stamina.kind).toBe('unknown');
    status(f.world);
    expect(f.model.self().weight).toMatchObject({ kind: 'observed', value: { current: 20, max: 200 } });
  } finally {
    f.close();
  }
});

test('reference creature traits, observed facts and inferred risk remain distinct for customized appearances', () => {
  const f = setup();
  try {
    mobile(f.world, 2, 101, 100, 3, 3);
    const entity = f.model.entity(2);
    expect(entity?.facts.kind).toBe('observed');
    expect(entity?.reference.kind).toBe('reference');
    expect(entity?.reference.source).toContain('ServUO');
    expect(entity?.reference.value.candidates.some((c) => c.type === 'Zombie')).toBe(true);
    expect(entity?.role.kind).toBe('unknown');
    expect(entity?.risk.kind).toBe('inferred');
    expect(entity?.intent.kind).toBe('unknown');
    mobile(f.world, 3, 102, 100, 0xefff, 3);
    expect(f.model.entity(3)?.role.kind).toBe('unknown');
    expect(f.model.entity(3)?.reference.value.aggressive).toBeNull();
  } finally {
    f.close();
  }
});

test('vendor labels and invulnerable appearance do not establish vendor capabilities', () => {
  const f = setup();
  try {
    mobile(f.world, 2, 101, 100, 400, 7);
    const source = f.world.entities.get(2);
    if (!source) throw new Error('missing observed mobile');
    f.world.entities.set(2, { ...source, name: 'a banker' });
    expect(f.model.entity(2)?.role.kind).toBe('unknown');
    const body = Buffer.alloc(17);
    body.writeUInt16BE(0x14, 0);
    body.writeUInt16BE(2, 2);
    body.writeUInt32BE(2, 4);
    body[8] = 1;
    body.writeUInt32BE(3006105, 9);
    f.world.apply(variable(0xbf, body));
    const at = Date.now();
    expect(f.model.entity(2)?.capabilities).toMatchObject({ kind: 'observed', value: ['bank'], at });
    expect(f.model.entity(2)?.role).toMatchObject({ kind: 'inferred', value: 'vendor' });
    f.advance(1000);
    mobile(f.world, 2, 102, 100, 400, 7);
    expect(f.model.entity(2)?.capabilities).toMatchObject({ at });
    f.advance(15 * 60_000);
    expect(f.model.entity(2)?.capabilities).toMatchObject({ kind: 'unknown', reason: 'stale' });
  } finally {
    f.close();
  }
});

test('entity movement does not refresh stale health and prior returned facts remain stable', () => {
  const f = setup();
  try {
    mobile(f.world);
    delta(f.world, 0xa1, 20, 40, 2);
    const before = f.model.entity(2);
    expect(before?.health.kind).toBe('observed');
    f.advance(5001);
    mobile(f.world, 2, 103);
    expect(f.model.entity(2)?.health).toMatchObject({ kind: 'unknown', reason: 'stale' });
    expect(before?.facts.value.position?.x).toBe(101);
    expect(f.model.entity(2)?.facts.value.position?.x).toBe(103);
  } finally {
    f.close();
  }
});

test('periodic reconciliation repairs missed entity changes without refreshing unobserved self status', () => {
  const f = setup();
  try {
    mobile(f.world);
    const raw = f.world.entities.get(2);
    if (!raw?.position || !f.world.status) throw new Error('missing fixture state');
    raw.position.x = 120;
    f.world.status.mana = 2;
    expect(f.model.entity(2)?.facts.value.position?.x).toBe(101);
    expect(f.model.self().mana).toMatchObject({ value: { current: 25 } });
    f.model.reconcile();
    expect(f.model.entity(2)?.visible).toBe(false);
    expect(f.model.self().mana).toMatchObject({ kind: 'unknown', reason: 'not-observed' });
    f.model.reconcile();
    expect(f.model.self().mana.kind).toBe('unknown');
    expect(f.model.self().health.kind).toBe('observed');
  } finally {
    f.close();
  }
});

test('inventory changes update the projection while bank contents remain separate', () => {
  const f = setup();
  try {
    f.world.entities.set(10, { serial: 10, kind: 'item', graphic: 0xe75, parent: 1, layer: 21 });
    f.world.entities.set(20, { serial: 20, kind: 'item', graphic: 0xe7c, parent: 1, layer: 29 });
    f.world.entities.set(30, { serial: 30, kind: 'item', graphic: 0xeed, parent: 10, amount: 3 });
    expect(f.model.inventory().some((e) => e.serial === 30)).toBe(true);
    f.world.entities.set(30, { serial: 30, kind: 'item', graphic: 0xeed, parent: 20, amount: 3 });
    expect(f.model.inventory().some((e) => e.serial === 30)).toBe(false);
    expect(f.model.entity(30)?.reference.value.candidates).toEqual([]);
  } finally {
    f.close();
  }
});

test('safety helpers use ongoing aggression and damage packets while retaining an unknown attacker identity', () => {
  const f = setup();
  const session = { world: f.world, phase: 'ready' } as unknown as PlayerSession;
  try {
    perceptionFor(session);
    swing(f.world, 999);
    expect(beingAttacked(session)).toBe(true);
    expect(() => interruptForDanger(session, false)).toThrow('Taking damage');
    f.advance(3001);
    const damage = Buffer.alloc(7);
    damage[0] = 0x0b;
    damage.writeUInt32BE(1, 1);
    damage.writeUInt16BE(10, 5);
    f.world.apply(damage);
    expect(recentlyHurt(session)).toBe(true);
  } finally {
    perceptionFor(session).dispose();
    f.close();
  }
});

test('disconnection clears current visibility and status knowledge and lifecycle disposal stops reconciliation', async () => {
  const config = validateConnection({
    schemaVersion: 1,
    shardId: 'test',
    emulator: 'servuo',
    profile: 'classic-7.0.45.1',
    host: '127.0.0.1',
    port: 2593,
    serverIndex: 0,
    timeoutMs: 1000
  });
  const session = new PlayerSession(config);
  const model = startPerception(session);
  expect(model.self().available).toBe(false);
  session.world.connected = true;
  enter(session.world);
  status(session.world);
  mobile(session.world);
  expect(model.visibleEntities()).toHaveLength(1);
  session.close();
  const count = model.stats.reconciliations;
  await Bun.sleep(20);
  expect(model.stats.reconciliations).toBe(count);
  expect(model.self().available).toBe(false);
  expect(model.self().health).toMatchObject({ kind: 'unknown', reason: 'disconnected' });
  expect(model.visibleEntities()).toHaveLength(0);
});

test('skill deltas update only the observed skill and irrelevant packets do not rebuild entities', () => {
  const f = setup();
  const skill = (id: number, value: number) => {
    const body = Buffer.alloc(10);
    body[0] = 0xdf;
    body.writeUInt16BE(id, 1);
    body.writeUInt16BE(value * 10, 3);
    body.writeUInt16BE(value * 10, 5);
    body.writeUInt16BE(1000, 8);
    f.world.apply(variable(0x3a, body));
  };
  try {
    skill(45, 50);
    skill(27, 25);
    const original = f.model.skill(27);
    mobile(f.world);
    const count = f.model.stats.entitiesUpdated;
    f.advance(1000);
    skill(45, 50.1);
    expect(f.model.skill(45)).toMatchObject({ kind: 'observed', value: 50.1 });
    expect(f.model.skill(27)).toEqual(original);
    for (let i = 0; i < 100; i++) f.world.apply(Buffer.from([0x73, 0]));
    expect(f.model.stats.entitiesUpdated).toBe(count);
    expect(f.model.stats.reconciliations).toBe(1);
  } finally {
    f.close();
  }
});

test('a running reconciliation timer detects missed changes and stops when disposed', async () => {
  const world = new WorldView();
  const model = new Perception(world);
  enter(world);
  mobile(world);
  model.start(5);
  const raw = world.entities.get(2);
  if (!raw?.position) throw new Error('missing mobile');
  raw.position.x = 140;
  try {
    await Bun.sleep(25);
    expect(model.stats.reconciliations).toBeGreaterThan(1);
    expect(model.entity(2)?.visible).toBe(false);
  } finally {
    model.dispose();
  }
  const count = model.stats.reconciliations;
  await Bun.sleep(15);
  expect(model.stats.reconciliations).toBe(count);
});

test('reconciliation refreshes stale self status once without overlapping requests', async () => {
  const world = new WorldView();
  enter(world);
  const controller = new AbortController();
  let calls = 0;
  let confirm: (() => void) | undefined;
  const session = {
    world,
    phase: 'ready',
    signal: controller.signal,
    refreshStatus: async () => {
      calls++;
      await new Promise<void>((resolve) => {
        confirm = resolve;
      });
      status(world);
    }
  } as unknown as PlayerSession;
  const model = startPerception(session, 5);
  try {
    await Bun.sleep(25);
    expect(calls).toBe(1);
    expect(model.self().health.kind).toBe('unknown');
    confirm?.();
    await Bun.sleep(15);
    expect(model.self().health.kind).toBe('observed');
    expect(calls).toBe(1);
  } finally {
    confirm?.();
    controller.abort();
  }
});

test('confirmed death is perceived without requiring a work turn and recovery needs live status', () => {
  const f = setup();
  try {
    expect(f.model.self().life).toMatchObject({ kind: 'observed', value: 'alive' });
    f.world.apply(Buffer.from([0x2c, 0]));
    expect(f.model.self().life).toMatchObject({ kind: 'observed', value: 'dead' });
    mobile(f.world, 1, 100, 100, 0x192, 1);
    status(f.world);
    expect(f.model.self().life).toMatchObject({ value: 'dead' });
    mobile(f.world, 1, 100, 100, 400, 1);
    delta(f.world, 0xa1, 25);
    expect(f.model.self().life).toMatchObject({ value: 'alive' });
  } finally {
    f.close();
  }
});

test('removed-entity history is bounded without claiming those entities died', () => {
  const f = setup();
  try {
    for (let serial = 100; serial < 1201; serial++) {
      f.world.entities.set(serial, {
        serial,
        kind: 'item',
        graphic: 0xeed,
        position: { x: 101, y: 100, z: 0, direction: 0 }
      });
      f.world.entities.delete(serial);
    }
    expect(f.model.entity(100)).toBeUndefined();
    expect(f.model.entity(1200)?.presence).toBe('removed');
    expect(f.world.deaths.size).toBe(0);
  } finally {
    f.close();
  }
});

test('an unchanged poison state remains known while stale health still requires reconciliation', () => {
  let now = 1000000;
  const world = new WorldView();
  world.connected = true;
  world.poisonLevel = 0;
  world.status = { hits: 100, maxHits: 100 } as NonNullable<WorldView['status']>;
  world.observations.fieldAt.set('poison', now);
  world.observations.fieldAt.set('health', now);
  const model = new Perception(world, { now: () => now });
  try {
    now += 61000;
    expect(model.self().poison).toMatchObject({ kind: 'observed', value: 0 });
    expect(model.self().health).toMatchObject({ kind: 'unknown', reason: 'stale' });
  } finally {
    model.dispose();
  }
});
