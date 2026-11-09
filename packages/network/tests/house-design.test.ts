import { expect, test } from 'bun:test';
import { deflateSync } from 'node:zlib';

import { PlayerSession } from '../src/session';
import { WorldView } from '../src/world';
import { mockShard } from './mock-shard';

export function designPacket(serial = 50, revision = 1, plane = 9, bytes = Buffer.from([0x07, 0x38, 0xff, 2, 20])) {
  const compressed = deflateSync(bytes);
  const packet = Buffer.alloc(22 + compressed.length);
  packet[0] = 0xd8;
  packet.writeUInt16BE(packet.length, 1);
  packet[3] = 3;
  packet.writeUInt32BE(serial, 5);
  packet.writeUInt32BE(revision, 9);
  packet.writeUInt16BE(bytes.length / 5, 13);
  packet.writeUInt16BE(packet.length - 17, 15);
  packet[17] = 1;
  packet[18] = plane;
  packet[19] = bytes.length & 255;
  packet[20] = compressed.length & 255;
  packet[21] = ((bytes.length >> 4) & 0xf0) | ((compressed.length >> 8) & 15);
  compressed.copy(packet, 22);
  return packet;
}

test('world item retains the server multi identity instead of treating a house as loose art', () => {
  const world = new WorldView();
  const packet = Buffer.alloc(26);
  packet[0] = 0xf3;
  packet[3] = 2;
  packet.writeUInt32BE(50, 4);
  packet.writeUInt16BE(0x13ec, 8);
  world.apply(packet);
  expect(world.entities.get(50)).toMatchObject({ multi: true, graphic: 0x13ec });
});

test('custom design packets preserve revision and bounded decompressed planes', () => {
  const world = new WorldView();
  world.apply(designPacket());
  expect(world.houseDesigns.get(50)?.revision).toBe(1);
  expect(world.houseDesigns.get(50)?.planes[0]?.data).toEqual(Buffer.from([7, 0x38, 255, 2, 20]));
});

test('a newer house revision invalidates old designs, removal and facet changes drop them', () => {
  const world = new WorldView();
  world.map = 1;
  world.apply(designPacket());
  const revision = Buffer.alloc(13);
  revision[0] = 0xbf;
  revision.writeUInt16BE(13, 1);
  revision.writeUInt16BE(0x1d, 3);
  revision.writeUInt32BE(50, 5);
  revision.writeUInt32BE(2, 9);
  world.apply(revision);
  world.apply(designPacket());
  expect(world.houseRevisions.get(50)).toBe(2);
  expect(world.houseDesigns.get(50)?.revision).toBe(1);
  world.apply(designPacket(50, 2));
  expect(world.houseDesigns.get(50)?.revision).toBe(2);
  const remove = Buffer.from([0x1d, 0, 0, 0, 50]);
  world.apply(remove);
  expect(world.houseDesigns.has(50)).toBe(false);
  expect(world.houseRevisions.has(50)).toBe(false);
  world.apply(designPacket());
  world.apply(Buffer.from([0xbf, 0, 6, 0, 8, 0]));
  expect(world.houseDesigns.size).toBe(0);
});

for (const fault of ['truncated', 'length', 'compression', 'duplicate', 'invalid-plane', 'oversize'] as const)
  test(`custom house rejects ${fault} without replacing the previous design`, () => {
    const world = new WorldView();
    world.apply(designPacket());
    let packet = designPacket(50, 2);
    if (fault === 'truncated') packet = packet.subarray(0, packet.length - 1);
    if (fault === 'length') packet[19] = 100;
    if (fault === 'compression') packet[3] = 0;
    if (fault === 'invalid-plane') packet[18] = 255;
    if (fault === 'oversize') packet = designPacket(50, 2, 9, Buffer.alloc(10000));
    if (fault === 'duplicate') {
      packet = Buffer.concat([packet, packet.subarray(18)]);
      packet.writeUInt16BE(packet.length, 1);
      packet.writeUInt16BE(packet.length - 17, 15);
      packet[17] = 2;
    }
    expect(() => world.apply(packet)).toThrow();
    expect(world.houseDesigns.get(50)?.revision).toBe(1);
  });

test('a connected client requests revised custom designs and clears its movement trail when the house changes', async () => {
  const shard = await mockShard();
  const session = new PlayerSession(shard.config);
  const requested: number[] = [];
  session.tap = (direction, packet) => {
    if (direction === 'out' && packet[0] === 0xbf && packet.readUInt16BE(3) === 0x1e)
      requested.push(packet.readUInt32BE(5));
  };
  const announce = (revision: number) => {
    const packet = Buffer.alloc(13);
    packet[0] = 0xbf;
    packet.writeUInt16BE(13, 1);
    packet.writeUInt16BE(0x1d, 3);
    packet.writeUInt32BE(50, 5);
    packet.writeUInt32BE(revision, 9);
    shard.broadcast(packet);
  };
  try {
    await session.connect({ username: 'house-test', password: 'test-password' }, { slot: 0 });
    await session.walk(2);
    await session.walk(2);
    const at = session.world.position;
    if (!at) throw new Error('Missing position');
    expect(session.movementTrail.reverse(at, session.world.map)).toBeDefined();
    announce(1);
    await session.waitFor(() => requested.length === 1, 'custom design request');
    expect(requested).toEqual([50]);
    expect(session.movementTrail.reverse(at, session.world.map)).toBeUndefined();
    shard.broadcast(designPacket());
    await session.waitFor(() => session.world.houseDesigns.get(50)?.revision === 1, 'custom design');
    announce(2);
    await session.waitFor(() => requested.length === 2, 'revised custom design request');
    expect(session.world.houseRevisions.get(50)).toBe(2);
    shard.broadcast(designPacket(50, 2));
    await session.waitFor(() => session.world.houseDesigns.get(50)?.revision === 2, 'revised custom design');
    expect(shard.errors).toEqual([]);
  } finally {
    session.close();
    await shard.close();
  }
});
