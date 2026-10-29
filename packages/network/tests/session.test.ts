import { expect, test } from 'bun:test';

import { PlayerSession } from '@gemwright/network/session';

import { mockShard } from './mock-shard';

const credentials = { username: 'test-player', password: 'test-password' };

test('real sockets negotiate both connections, observe actions and reconnect the same character', async () => {
  const shard = await mockShard();
  let session = new PlayerSession(shard.config);
  const positions: number[] = [];
  const observationErrors: unknown[] = [];
  session.world.observations.subscribe(
    (change) => {
      if (change.opcode === 0x22 && session.world.position) {
        positions.push(session.world.position.x);
        expect(session.world.entities.get(session.world.serial ?? -1)?.position?.x).toBe(session.world.position.x);
      }
    },
    (error) => observationErrors.push(error)
  );
  try {
    await session.connect(credentials, { slot: 0 });
    expect(session.world.serial).toBe(123);
    expect(await session.walk(2)).toBe(true);
    expect(session.world.position?.x).toBe(100);
    expect(await session.walk(2)).toBe(true);
    expect(session.world.position?.x).toBe(101);
    expect(positions).toEqual([100, 101]);
    expect(observationErrors).toEqual([]);
    session.say('Hello');
    await session.waitFor(() => session.world.journal.some((line) => line.text === 'Hello'), 'speech');
    session.use(0x40000001);
    await session.waitFor(() => session.world.entities.has(0x40000002), 'backpack');
    session.use(0x40000002);
    await session.waitFor(() => session.world.target !== null, 'target');
    session.target(null);
    expect(session.world.target).toBeNull();
    await session.waitFor(() => session.world.journal.some((line) => line.cliloc === 500487), 'feedback');
    session.close();
    session = new PlayerSession(shard.config);
    await session.connect(credentials, { slot: 0 });
    expect(session.world.serial).toBe(123);
    expect(session.world.target).toBeNull();
    expect(shard.created()).toBe(0);
    expect(shard.errors).toEqual([]);
  } finally {
    session.close();
    await shard.close();
  }
});

test('creation uses an offered city and is never implicit for an empty slot', async () => {
  const shard = await mockShard({ empty: true });
  let session = new PlayerSession(shard.config);
  try {
    await expect(session.connect(credentials, { slot: 0 })).rejects.toThrow('explicitly');
    expect(shard.created()).toBe(0);
    session = new PlayerSession(shard.config);
    await session.connect(credentials, {
      slot: 0,
      create: {
        name: 'Miner A',
        city: 'Britain',
        skills: [
          { id: 45, value: 50 },
          { id: 7, value: 50 }
        ]
      }
    });
    expect(shard.created()).toBe(1);
    expect(session.phase).toBe('ready');
    expect(shard.errors).toEqual([]);
  } finally {
    session.close();
    await shard.close();
  }
});

test('server movement rejection restores authoritative coordinates and ownership loss blocks actions', async () => {
  const shard = await mockShard({ rejectWalk: true });
  let owned = true;
  const session = new PlayerSession(shard.config, () => {
    if (!owned) throw new Error('Ownership lost');
  });
  try {
    await session.connect(credentials, { slot: 0 });
    expect(await session.walk(0)).toBe(false);
    expect(session.world.position).toEqual({ x: 101, y: 201, z: 0, direction: 4 });
    owned = false;
    expect(() => session.say('No')).toThrow('Ownership');
    expect(shard.moves()).toBe(1);
  } finally {
    session.close();
    await shard.close();
  }
});

test('disconnect during movement fails without replaying an uncertain action', async () => {
  const shard = await mockShard({ dropWalk: true });
  const session = new PlayerSession(shard.config);
  try {
    await session.connect(credentials, { slot: 0 });
    await expect(session.walk(0)).rejects.toThrow('closed');
    expect(session.phase).toBe('failed');
    expect(shard.moves()).toBe(1);
    await expect(session.walk(0)).rejects.toThrow('not ready');
  } finally {
    session.close();
    await shard.close();
  }
});

test('a full self update resets the movement sequence like ServUO', async () => {
  const shard = await mockShard({ selfUpdateAfterMove: true });
  const session = new PlayerSession(shard.config);
  try {
    await session.connect(credentials, { slot: 0 });
    expect(await session.walk(2)).toBe(true);
    await session.waitFor(() => session.world.position?.x === 150, 'self update');
    expect(await session.walk(2)).toBe(true);
    expect(await session.walk(2)).toBe(true);
    expect(session.world.position).toEqual({ x: 152, y: 250, z: 0, direction: 2 });
    expect(shard.rejected()).toBe(0);
    expect(shard.errors).toEqual([]);
  } finally {
    session.close();
    await shard.close();
  }
});
