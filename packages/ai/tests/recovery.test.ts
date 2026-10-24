import { expect, test } from 'bun:test';

import { superviseBehavior } from '../src/behavior-supervisor';
import { corpseRecoveryChoice, resurrectionButton } from '../src/fighter-recovery';
import { speech } from '../src/protocol/packets';

test('resurrection accepts the observed free healer Continue control and rejects a paid or missing control', () => {
  const layout =
    '{ xmfhtmlgump 0 20 400 35 1011022 0 0 } { xmfhtmlgump 50 55 300 140 1011025 1 1 } ' +
    '{ button 65 227 4005 4007 1 0 1 } { xmfhtmlgump 100 230 110 35 1011011 0 0 }';
  expect(resurrectionButton(layout)).toBe(1);
  expect(resurrectionButton(layout.replace('1011025', '1060018'))).toBeUndefined();
  expect(resurrectionButton(layout.replace('1 0 1', '1 0 2'))).toBeUndefined();
});

test('corpse recovery respects threats, age, repeated attempts, health and the template policy', () => {
  const safe = { policy: 'recover-if-safe' as const, ageMs: 1000, attempts: 0, healthRatio: 1, threats: 0 };
  expect(corpseRecoveryChoice(safe)).toBe('recover');
  for (const changed of [{ threats: 1 }, { ageMs: 16 * 60_000 }, { attempts: 2 }, { healthRatio: 0.7 }, { ageMs: NaN }])
    expect(corpseRecoveryChoice({ ...safe, ...changed })).toBe('replace');
  expect(corpseRecoveryChoice({ ...safe, policy: 'replace-equipment' })).toBe('replace');
  expect(corpseRecoveryChoice({ ...safe, policy: 'seek-help' })).toBe('seek-help');
});

test('banker commands contain the classic speech keyword and preserve the spoken amount', () => {
  const withdraw = speech('withdraw 250');
  expect(withdraw[3]).toBe(0xc0);
  expect([...withdraw.subarray(12, 15)]).toEqual([0, 0x10, 0]);
  expect(withdraw.subarray(15, -1).toString('utf8')).toBe('withdraw 250');
  expect([...speech('balance').subarray(12, 15)]).toEqual([0, 0x10, 1]);
  expect(speech('Hello, Britannia.')[3]).toBe(0);
});

function supervisorSetup() {
  let now = 0;
  let latest = {
    phase: 'ready',
    reconnectable: false,
    close() {
      this.phase = 'offline';
    }
  };
  return {
    session: latest,
    deadline: 5000,
    maxReconnects: 2,
    stopping: () => false,
    assertOwnership: () => {},
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    latestSession: () => latest,
    connect: async () => {
      latest = { ...latest, phase: 'ready', reconnectable: false };
      return latest;
    }
  };
}

test('a behavior reconnects and reruns with the remaining deadline instead of replaying an action', async () => {
  const options = supervisorSetup();
  const seconds: number[] = [];
  const result = await superviseBehavior({
    ...options,
    run: async (session, remaining) => {
      seconds.push(remaining);
      if (seconds.length === 1) {
        session.phase = 'failed';
        session.reconnectable = true;
        return 'uncertain-transfer';
      }
      return 'reconciled';
    }
  });
  expect(result.recoveryAttempts).toBe(1);
  expect(result.runs).toBe(2);
  expect(result.result).toBe('reconciled');
  expect(seconds).toEqual([5, 4.5]);
});

test('legal behavior failure does not reconnect; retryable connection failures have a hard budget', async () => {
  const options = supervisorSetup();
  let connections = 0;
  const legal = await superviseBehavior({
    ...options,
    connect: async () => {
      connections++;
      return options.session;
    },
    run: async () => 'no-affordable-sword'
  });
  expect(legal.runs).toBe(1);
  expect(connections).toBe(0);
  options.session.reconnectable = true;
  await expect(
    superviseBehavior({
      ...options,
      run: async (session) => {
        session.phase = 'failed';
        session.reconnectable = true;
        return 'disconnected';
      }
    })
  ).rejects.toThrow('reconnect budget exhausted');
});

test('poison observations distinguish the current character and cannot confuse flying with poison', async () => {
  const { WorldView } = await import('../src/protocol/world');
  const world = new WorldView();
  world.serial = 123;
  const packet = Buffer.alloc(12);
  packet[0] = 0x17;
  packet.writeUInt16BE(12, 1);
  packet.writeUInt32BE(124, 3);
  packet.writeUInt16BE(1, 7);
  packet.writeUInt16BE(1, 9);
  packet[11] = 3;
  world.apply(packet);
  expect(world.poisonLevel).toBeNull();
  packet.writeUInt32BE(123, 3);
  world.apply(packet);
  expect(world.poisonLevel).toBe(3);
  packet[11] = 0;
  world.apply(packet);
  expect(world.poisonLevel).toBe(0);
});

test('resurrection waypoint packets preserve the boundary of the following living-body update', async () => {
  const { PacketFramer } = await import('../src/protocol/framing');
  const remove = Buffer.from([0xe6, 0, 0, 0, 7]);
  const alive = Buffer.from([0x2c, 2]);
  expect(new PacketFramer().push(Buffer.concat([remove, alive]))).toEqual([remove, alive]);
});

test('merchant interaction tiles reject a wall, diagonal corner and different floor', async () => {
  const { connectedInteractionTile } = await import('../src/mobile-approach');
  let wall = false;
  const terrain = {
    stand: (x: number, y: number, z: number) => ({ x, y, z }),
    cell: () => ({ statics: wall ? [{ id: 1, z: 0 }] : [] }),
    tile: () => ({ flags: 0x10, height: 20 })
  } as unknown as import('../src/terrain').Terrain;
  const customer = { x: 10, y: 10, z: 0 };
  expect(connectedInteractionTile(terrain, customer, { x: 11, y: 10, z: 0 })).toBe(true);
  expect(connectedInteractionTile(terrain, customer, { x: 11, y: 11, z: 0 })).toBe(false);
  expect(connectedInteractionTile(terrain, customer, { x: 11, y: 10, z: 20 })).toBe(false);
  wall = true;
  expect(connectedInteractionTile(terrain, customer, { x: 11, y: 10, z: 0 })).toBe(false);
});

test('bridge stairs use their base for stepping and full height for the next step, matching ServUO', async () => {
  const { Terrain } = await import('../src/terrain');
  let bridge = true;
  const terrain = Object.create(Terrain.prototype) as import('../src/terrain').Terrain;
  terrain.cell = (x, y) => ({
    land: { x, y, z: 20, id: 0 },
    statics: x === 1 ? [{ x, y, z: 22, id: 1 }] : x === 2 ? [{ x, y, z: 27, id: 2 }] : []
  });
  terrain.tile = (id) => ({
    flags: id === 1 ? 0x200 | (bridge ? 0x400 : 0) : id === 2 ? 0x200 : 0,
    height: id === 1 ? 5 : 0,
    layer: 0,
    name: 'fixture'
  });
  const street = { x: 0, y: 0, z: 20 };
  const stair = terrain.stand(1, 0, 20, street);
  expect(stair?.z).toBe(24);
  expect(stair && terrain.stand(2, 0, stair.z, stair)?.z).toBe(27);
  bridge = false;
  expect(terrain.stand(1, 0, 20, street)).toBeNull();
});

test('bank balance understands physical-gold and account platinum/gold replies without using secured gold', async () => {
  const { reportedBankGold } = await import('../src/fighter-equipment');
  expect(reportedBankGold(1042759, '1,095')).toBe(1095);
  expect(reportedBankGold(1155855, '0\t1,095')).toBe(1095);
  expect(reportedBankGold(1155855, '1\t20')).toBe(1_000_000_020);
  expect(reportedBankGold(1155848, '100')).toBeUndefined();
  expect(reportedBankGold(1155855, '0\tno funds')).toBeUndefined();
});

test('an unfinished reconnect cannot extend the behavior deadline', async () => {
  const session = {
    phase: 'ready',
    reconnectable: true,
    close() {
      this.phase = 'offline';
    }
  };
  const result = await superviseBehavior({
    session,
    deadline: Date.now() + 30,
    maxReconnects: 1,
    stopping: () => false,
    assertOwnership: () => {},
    latestSession: () => session,
    sleep: async () => {},
    connect: () => new Promise<typeof session>(() => {}),
    run: async () => {
      session.phase = 'failed';
      return 'interrupted';
    }
  });
  expect(result.recoveryAttempts).toBe(1);
  expect(result.session.phase).toBe('offline');
  expect(result.runs).toBe(1);
});
