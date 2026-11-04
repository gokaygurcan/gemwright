import { expect, setSystemTime, spyOn, test } from 'bun:test';

import { speech } from '@gemwright/network/packets';

import { absence } from '../src/absence';
import { SESSION_BREAK } from '../src/action-errors';
import { superviseBehavior } from '../src/behavior-supervisor';
import { corpseRecoveryChoice, resurrectionButton } from '../src/fighter-recovery';
import { lasting } from '../src/lasting';
import { mendAfterDeath } from '../src/mend';
import { deadlyWalk, untried } from '../src/resurrection';
import { behaviorFixture, required } from './behavior-fixture';

test('resurrection accepts the observed free healer Continue control and rejects a paid or missing control', () => {
  const layout =
    '{ xmfhtmlgump 0 20 400 35 1011022 0 0 } { xmfhtmlgump 50 55 300 140 1011025 1 1 } ' +
    '{ button 65 227 4005 4007 1 0 1 } { xmfhtmlgump 100 230 110 35 1011011 0 0 }';
  expect(resurrectionButton(layout)).toBe(1);
  expect(resurrectionButton(layout.replace('1011025', '1060018'))).toBeUndefined();
  expect(resurrectionButton(layout.replace('1 0 1', '1 0 2'))).toBeUndefined();
});

test('corpse recovery preserves a fresh target despite nearby monsters or earlier attempts', () => {
  const safe = { policy: 'recover-if-safe' as const, ageMs: 1000, attempts: 0, healthRatio: 1, threats: 0 };
  expect(corpseRecoveryChoice(safe)).toBe('recover');
  for (const changed of [{ threats: 1 }, { attempts: 2 }, { healthRatio: 0.7 }])
    expect(corpseRecoveryChoice({ ...safe, ...changed })).toBe('recover');
  expect(corpseRecoveryChoice({ ...safe, healthRatio: 0.2 })).toBe('wait');
  for (const changed of [{ ageMs: 16 * 60_000 }, { ageMs: NaN }])
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
  const { WorldView } = await import('@gemwright/network/world');
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
  const { PacketFramer } = await import('@gemwright/network/framing');
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

test('an open-ended behavior keeps the character in the world: a returned run is run again, not reconnected', async () => {
  let now = 0;
  const runs: number[] = [];
  let closes = 0;
  const session = {
    phase: 'ready',
    reconnectable: false,
    failureReason: null,
    close: () => {
      closes++;
    }
  };
  const result = await superviseBehavior({
    session,
    deadline: Number.POSITIVE_INFINITY,
    maxReconnects: 2,
    stopping: () => runs.length >= 3,
    assertOwnership: () => {},
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    latestSession: () => session,
    connect: async () => session,
    run: async () => {
      runs.push(now);
      return 'still stranded';
    }
  });
  expect(runs.length).toBe(3);
  expect(result.runs).toBe(3);
  expect(result.result).toBe('still stranded');
  expect(closes).toBe(0);
  expect(session.phase).toBe('ready');
});

test('a planned session break ends an open-ended run without the supervisor restarting it', async () => {
  const options = supervisorSetup();
  let offlineUntil = 0;
  let calls = 0;
  const result = await superviseBehavior({
    ...options,
    deadline: Number.POSITIVE_INFINITY,
    shouldRepeat: () => offlineUntil <= options.now(),
    run: async () => {
      calls++;
      if (calls > 1) throw new Error('Planned break was restarted');
      offlineUntil = options.now() + 60_000;
      return 'Taking a session break';
    }
  });
  expect(result.runs).toBe(1);
  expect(result.recoveryAttempts).toBe(0);
  expect(result.result).toBe('Taking a session break');
});

test('a deliberate session break ends the run: the supervisor does not start it again', async () => {
  const options = supervisorSetup();
  const result = await superviseBehavior({
    ...options,
    deadline: Number.POSITIVE_INFINITY,
    shouldRepeat: (value: unknown) => value !== SESSION_BREAK,
    run: async () => SESSION_BREAK
  });
  expect(result.runs).toBe(1);
  expect(result.result).toBe(SESSION_BREAK);
});

// An ordinary behavior that returns (not a break) is run again in the same session instead.
test('an ordinary returned behavior is still run again, unlike a break', async () => {
  const options = supervisorSetup();
  let runs = 0;
  const result = await superviseBehavior({
    ...options,
    deadline: Number.POSITIVE_INFINITY,
    stopping: () => runs >= 3,
    shouldRepeat: (value: unknown) => value !== SESSION_BREAK,
    run: async () => {
      runs++;
      return 'still stranded';
    }
  });
  expect(result.runs).toBe(3);
  expect(result.result).toBe('still stranded');
});

test('after a resurrection a resident with nothing to heal with rests to most of its health before working', async () => {
  const f = behaviorFixture('swordsman');
  const status = required(f.world.status);
  status.hits = 10;
  let now = Date.now();
  setSystemTime(now);
  const sleep = spyOn(Bun, 'sleep').mockImplementation(async () => {});
  // Natural regeneration: about six hit points a minute.
  f.session.refreshStatus = async () => {
    now += 60_000;
    setSystemTime(now);
    status.hits = Math.min(status.maxHits, status.hits + 6);
  };
  try {
    await mendAfterDeath({ ...f.ctx, backpack: () => 10 }, () => {});
  } finally {
    sleep.mockRestore();
    setSystemTime();
  }
  expect(status.hits).toBeGreaterThanOrEqual(80);
});

test('a ghost does not pick a far healer whose walk from the moongate crosses where residents keep dying', () => {
  const deaths = lasting('death-log');
  const now = Date.now();
  // Residents killed by the orcs on the road between the Minoc moongate and Cove.
  for (const [i, spot] of ['2470,1105', '2444,1119', '2477,1119'].entries())
    deaths.set(`${900 + i}|${spot}|0x1a|${now}`, now + 3_600_000);
  expect(deadlyWalk({ x: 2250, y: 1230 })).toBe(true);
  expect(deadlyWalk({ x: 2930, y: 854 })).toBe(false);
});

test('an ankh found missing is skipped for a while, like a healer found away', () => {
  const missed = absence(424242);
  const ankh = { kind: 'ankh' as const, x: 3606, y: 2582 };
  const healer = { kind: 'healer' as const, x: 2577, y: 599 };
  missed.note('ankh', ankh);
  expect(untried([ankh, healer], missed)).toEqual([healer]);
});
