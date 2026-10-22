import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';

import { validateConnection } from '../src/connection';
import { variable } from '../src/protocol/packets';
import { PlayerSession } from '../src/protocol/session';

// Reverse the existing BSD decoder's tree for a test-only server encoder.
const codec = await readFile(new URL('../../client/huffman.ts', import.meta.url), 'utf8');
const encodedTree = codec
  .split('Object.freeze([')[1]
  ?.split(']);')[0]
  ?.replace(/\/\*[\s\S]*?\*\//g, '');
if (!encodedTree) throw new Error('Missing shared Huffman tree');
const tree = encodedTree
  .split(',')
  .map((value) => Number(value.trim()))
  .filter(Number.isFinite);
const codes = new Map<number, string>();
function visit(node: number, bits: string): void {
  for (const [branch, bit] of [
    [0, '1'],
    [1, '0']
  ] as const) {
    const child = tree[node * 2 + branch];
    if (child === undefined) throw new Error('Invalid test codec');
    if (child <= 0) codes.set(-child, bits + bit);
    else visit(child, bits + bit);
  }
}
visit(0, '');
function compress(packet: Buffer): Buffer {
  let bits = [...packet].map((value) => codes.get(value)).join('') + codes.get(256);
  bits = bits.padEnd(Math.ceil(bits.length / 8) * 8, '0');
  return Buffer.from(
    Array.from({ length: bits.length / 8 }, (_, index) => Number.parseInt(bits.slice(index * 8, index * 8 + 8), 2))
  );
}

async function mockShard(
  options: { empty?: boolean; rejectWalk?: boolean; dropWalk?: boolean; selfUpdateAfterMove?: boolean } = {}
) {
  const sockets = new Set<Socket>();
  const errors: Error[] = [];
  let created = 0;
  let moves = 0;
  let rejected = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let pending = Buffer.alloc(0);
    let stage: 'seed' | 'select' | 'game' = 'seed';
    // Mirrors ServUO NetState.Sequence: zero after login, rejection or a full self update.
    let sequence = 0;
    const send = (bytes: Buffer) => socket.write(compress(bytes));
    socket.on('data', (bytes) => {
      if (typeof bytes === 'string') throw new Error('Expected binary mock traffic');
      pending = Buffer.concat([pending, bytes]);
      try {
        while (pending.length) {
          let length: number;
          if (stage === 'seed') length = pending[0] === 0xef ? 83 : 69;
          else if (stage === 'select') length = 3;
          else {
            const opcode = pending[0];
            length =
              opcode === 0x00
                ? 104
                : opcode === 0x5d
                  ? 73
                  : opcode === 0x02
                    ? 7
                    : opcode === 0x06
                      ? 5
                      : opcode === 0x6c
                        ? 19
                        : opcode === 0x73
                          ? 2
                          : 0;
            if (opcode === 0xad || opcode === 0xbd) {
              if (pending.length < 3) break;
              length = pending.readUInt16BE(1);
            }
            if (!length) throw new Error(`Unexpected client opcode ${opcode}`);
          }
          if (pending.length < length) break;
          const packet = pending.subarray(0, length);
          pending = Buffer.from(pending.subarray(length));
          if (stage === 'seed' && packet[0] === 0xef) {
            if (packet[21] !== 0x80) throw new Error('Missing account login');
            const body = Buffer.alloc(43);
            body[0] = 0x5d;
            body.writeUInt16BE(1, 1);
            body.write('Mock shard', 5);
            const list = variable(0xa8, body);
            socket.write(list.subarray(0, 2));
            setTimeout(() => socket.write(list.subarray(2)), 5);
            stage = 'select';
          } else if (stage === 'select') {
            if (packet[0] !== 0xa0) throw new Error('Missing shard selection');
            const relay = Buffer.alloc(11);
            relay[0] = 0x8c;
            relay.writeUInt32BE(0x11223344, 7);
            socket.write(relay);
          } else if (stage === 'seed') {
            if (packet.readUInt32BE(0) !== 0x11223344 || packet[4] !== 0x91 || packet.readUInt32BE(5) !== 0x11223344)
              throw new Error('Invalid game seed/authentication');
            const body = Buffer.alloc(1 + 5 * 60 + 1 + 89 + 6);
            body[0] = 5;
            if (!options.empty) body.write('Miner A', 1);
            body[301] = 1;
            body.write('Britain', 303);
            const output = compress(Buffer.concat([Buffer.from([0xb9, 0, 0, 0, 0]), variable(0xa9, body)]));
            socket.write(output.subarray(0, 3));
            setTimeout(() => socket.write(output.subarray(3)), 5);
            stage = 'game';
          } else if (packet[0] === 0x5d || packet[0] === 0x00) {
            if (packet[0] === 0x00) created++;
            const confirm = Buffer.alloc(37);
            confirm[0] = 0x1b;
            confirm.writeUInt32BE(123, 1);
            confirm.writeUInt16BE(100, 11);
            confirm.writeUInt16BE(200, 13);
            const incoming = Buffer.alloc(32);
            incoming[0] = 0x78;
            incoming.writeUInt16BE(32, 1);
            incoming.writeUInt32BE(123, 3);
            incoming.writeUInt16BE(400, 7);
            incoming.writeUInt16BE(100, 9);
            incoming.writeUInt16BE(200, 11);
            incoming.writeUInt32BE(0x40000001, 19);
            incoming.writeUInt16BE(0xe75, 23);
            incoming[25] = 21;
            send(Buffer.concat([confirm, incoming, Buffer.from([0x55])]));
          } else if (packet[0] === 0x02) {
            moves++;
            if (options.dropWalk) {
              socket.destroy();
              return;
            }
            const seq = packet.readUInt8(2);
            if (options.rejectWalk || (sequence === 0 && seq !== 0)) {
              rejected++;
              sequence = 0;
              send(Buffer.from([0x21, seq, 0, 101, 0, 201, 4, 0]));
            } else {
              sequence = seq === 255 ? 1 : seq + 1;
              send(Buffer.from([0x22, seq, 1]));
              if (options.selfUpdateAfterMove && moves === 1) {
                const update = Buffer.alloc(19);
                update[0] = 0x20;
                update.writeUInt32BE(123, 1);
                update.writeUInt16BE(400, 5);
                update.writeUInt16BE(150, 11);
                update.writeUInt16BE(250, 13);
                update[17] = 2;
                sequence = 0;
                send(update);
              }
            }
          } else if (packet[0] === 0x06) {
            if (packet.readUInt32BE(1) === 0x40000001) {
              const content = Buffer.alloc(25);
              content[0] = 0x3c;
              content.writeUInt16BE(25, 1);
              content.writeUInt16BE(1, 3);
              content.writeUInt32BE(0x40000002, 5);
              content.writeUInt16BE(0xe86, 9);
              content.writeUInt16BE(1, 12);
              content.writeUInt32BE(0x40000001, 19);
              send(content);
            } else {
              const cursor = Buffer.alloc(19);
              cursor[0] = 0x6c;
              cursor[1] = 1;
              cursor.writeUInt32BE(42, 2);
              send(cursor);
            }
          } else if (packet[0] === 0x6c) {
            if (packet.readUInt32BE(2) !== 42) throw new Error('Stale target cursor');
            const feedback = Buffer.alloc(47);
            feedback.writeUInt32BE(123, 0);
            feedback.writeUInt32BE(500487, 11);
            send(variable(0xc1, feedback));
          } else if (packet[0] === 0xad) {
            const body = Buffer.alloc(45 + packet.length - 12);
            body.writeUInt32BE(123, 0);
            body.write('Miner A', 15);
            packet.subarray(12).copy(body, 45);
            send(variable(0xae, body));
          } else if (packet[0] === 0x73) send(packet);
        }
      } catch (error) {
        errors.push(error as Error);
        socket.destroy();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Mock did not listen');
  const config = validateConnection({
    schemaVersion: 1,
    shardId: 'test',
    emulator: 'servuo',
    profile: 'classic-7.0.45.1',
    host: '127.0.0.1',
    port: address.port,
    serverIndex: 0,
    timeoutMs: 1000
  });
  return {
    config,
    errors,
    created: () => created,
    moves: () => moves,
    rejected: () => rejected,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

const credentials = { username: 'test-player', password: 'test-password' };

test('real sockets negotiate both connections, observe actions and reconnect the same character', async () => {
  const shard = await mockShard();
  let session = new PlayerSession(shard.config);
  try {
    await session.connect(credentials, { slot: 0 });
    expect(session.world.serial).toBe(123);
    expect(await session.walk(2)).toBe(true);
    expect(session.world.position?.x).toBe(100);
    expect(await session.walk(2)).toBe(true);
    expect(session.world.position?.x).toBe(101);
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
