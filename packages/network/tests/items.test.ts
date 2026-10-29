import { expect, test } from 'bun:test';

import { validateConnection } from '../src/connection';
import { CommandRejected } from '../src/errors';
import { dropAtFeet, equipItem, moveItem } from '../src/items';
import { PlayerSession } from '../src/session';

function fixture() {
  const session = new PlayerSession(
    validateConnection({
      schemaVersion: 1,
      shardId: 'test',
      emulator: 'servuo',
      profile: 'classic-7.0.45.1',
      host: '127.0.0.1',
      port: 2593,
      serverIndex: 0,
      timeoutMs: 1000
    })
  );
  session.phase = 'ready';
  const { world } = session;
  world.serial = 1;
  world.ready = true;
  world.position = { x: 100, y: 100, z: 0, direction: 0 };
  world.entities.set(10, { serial: 10, kind: 'item', graphic: 0xe75, parent: 1, layer: 21 });
  world.entities.set(20, { serial: 20, kind: 'item', graphic: 0xe76, parent: 1 });
  world.entities.set(42, { serial: 42, kind: 'item', graphic: 0xf43, parent: 10, amount: 1 });
  const send = (packet: Buffer) => {
    if (packet[0] === 7) {
      const removed = Buffer.alloc(5);
      removed[0] = 0x1d;
      removed.writeUInt32BE(42, 1);
      world.apply(removed);
    } else {
      // ServUO Item.Bounce restores the item without requiring a lift-rejection packet.
      const bounced = Buffer.alloc(21);
      bounced[0] = 0x25;
      bounced.writeUInt32BE(42, 1);
      bounced.writeUInt16BE(0xf43, 5);
      bounced.writeUInt16BE(1, 8);
      bounced.writeUInt32BE(10, 15);
      world.apply(bounced);
    }
  };
  return { session, send };
}
for (const operation of ['drop', 'equip', 'transfer'] as const)
  test(`an observed ${operation} bounce is a refusal that keeps the session connected`, async () => {
    const { session, send } = fixture();
    try {
      const promise =
        operation === 'drop'
          ? dropAtFeet(session, send, 42)
          : operation === 'equip'
            ? equipItem(session, send, 42, 1)
            : moveItem(session, send, 42, 20);
      await expect(promise).rejects.toBeInstanceOf(CommandRejected);
      expect(session.phase).toBe('ready');
      expect(session.reconnectable).toBe(false);
      expect(session.world.entities.get(42)?.parent).toBe(10);
    } finally {
      session.close();
    }
  });
test('a drop the shard accepts without a ground observation resolves by re-observation and keeps the session', async () => {
  const { session } = fixture();
  const wait = session.waitFor.bind(session);
  session.waitFor = (predicate, label, _timeout, options) => wait(predicate, label, 10, options);
  try {
    await dropAtFeet(
      session,
      (packet) => {
        if (packet[0] === 7) session.world.entities.delete(42);
      },
      42
    );
    expect(session.world.entities.has(42)).toBe(false);
    expect(session.phase).toBe('ready');
    expect(session.reconnectable).toBe(false);
  } finally {
    session.close();
  }
});
