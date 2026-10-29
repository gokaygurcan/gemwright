import { expect, test } from 'bun:test';

import { WorldView } from '@gemwright/network';
import type { WorldChange } from '@gemwright/network/world-observations';

function equippedMobile() {
  const packet = Buffer.alloc(32);
  packet[0] = 0x78;
  packet.writeUInt16BE(32, 1);
  packet.writeUInt32BE(2, 3);
  packet.writeUInt16BE(400, 7);
  packet.writeUInt16BE(100, 9);
  packet.writeUInt16BE(100, 11);
  packet.writeUInt32BE(10, 19);
  packet.writeUInt16BE(0xe75, 23);
  packet[25] = 21;
  return packet;
}

test('a packet publishes one coherent change after all entity and equipment updates', () => {
  const world = new WorldView();
  const changes: WorldChange[] = [];
  const children: number[][] = [];
  const stop = world.observations.subscribe(
    (change) => {
      changes.push(change);
      children.push(world.childrenOf(2).map((e) => e.serial));
    },
    (error) => {
      throw error;
    }
  );
  world.apply(equippedMobile());
  expect(changes).toHaveLength(1);
  expect(children).toEqual([[10]]);
  expect(changes[0]?.entities).toEqual([2, 10]);
  expect(changes[0]?.opcode).toBe(0x78);
  stop();
  world.entities.delete(10);
  expect(changes).toHaveLength(1);
});

test('subscriber failures are reported without failing packet decoding or other consumers', () => {
  const world = new WorldView();
  const error = new Error('consumer failure');
  const failures: unknown[] = [];
  const changes: WorldChange[] = [];
  world.observations.subscribe(
    () => {
      throw error;
    },
    (caught) => failures.push(caught)
  );
  world.observations.subscribe(
    (change) => changes.push(change),
    () => {}
  );
  expect(() => world.apply(equippedMobile())).not.toThrow();
  expect(failures).toEqual([error]);
  expect(world.connected).toBe(true);
  expect(changes).toHaveLength(1);
});

test('a malformed decoded packet never publishes partial entities as a successful observation', () => {
  const world = new WorldView();
  const changes: WorldChange[] = [];
  world.observations.subscribe(
    (change) => changes.push(change),
    () => {}
  );
  // The mobile header is present, but the claimed equipment entry is truncated.
  const packet = equippedMobile().subarray(0, 27);
  expect(() => world.apply(packet)).toThrow();
  expect(changes.filter((c) => c.opcode !== null)).toEqual([]);
  expect(changes.at(-1)?.connected).toBe(false);
});

test('unrelated packets do not invalidate or refresh entity observations', () => {
  const world = new WorldView();
  world.apply(equippedMobile());
  const observedAt = world.observations.entityAt.get(2);
  const changes: WorldChange[] = [];
  world.observations.subscribe(
    (change) => changes.push(change),
    () => {}
  );
  for (let i = 0; i < 100; i++) world.apply(Buffer.from([0x73, 0]));
  expect(changes.every((c) => c.entities.length === 0 && c.fields.length === 0)).toBe(true);
  expect(world.observations.entityAt.get(2)).toBe(observedAt);
});

test('decoded semantic observations expose spatial updates, swings, deaths and rejected movement', () => {
  const world = new WorldView();
  const changes: WorldChange[] = [];
  world.observations.subscribe(
    (change) => changes.push(change),
    () => {}
  );
  world.apply(equippedMobile());
  expect(changes.at(-1)?.spatial).toBe(true);
  const swing = Buffer.alloc(10);
  swing[0] = 0x2f;
  swing.writeUInt32BE(2, 2);
  swing.writeUInt32BE(1, 6);
  world.apply(swing);
  expect(changes.at(-1)?.events).toEqual([{ type: 'swing', attacker: 2, target: 1 }]);
  expect(changes.at(-1)?.spatial).toBe(false);
  const death = Buffer.alloc(13);
  death[0] = 0xaf;
  death.writeUInt32BE(2, 1);
  death.writeUInt32BE(99, 5);
  world.apply(death);
  expect(changes.at(-1)?.events).toEqual([{ type: 'entity-death', serial: 2, corpse: 99 }]);
  world.apply(Buffer.from([0x2c, 0]));
  expect(changes.at(-1)?.events).toEqual([{ type: 'self-death' }]);
  world.apply(Buffer.from([0x21, 0, 0, 100, 0, 100, 0, 0]));
  expect(changes.at(-1)?.events).toEqual([{ type: 'movement-rejected' }]);
  world.disconnect();
  expect(changes.at(-1)).toMatchObject({ decoded: false, spatial: false, events: [] });
});
