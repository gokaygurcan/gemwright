import { describe, expect, test } from 'bun:test';

import { validateConnection } from '../src/connection';
import { characterList } from '../src/protocol/characters';
import { PacketFramer } from '../src/protocol/framing';
import * as packets from '../src/protocol/packets';
import { WorldView } from '../src/protocol/world';

describe('wire boundaries', () => {
  test('accepts every split of fixed and variable packets and coalesced packets', () => {
    const fixed = Buffer.from([0x22, 7, 1]);
    const dynamic = packets.variable(0xbd, Buffer.from('7.0.45.1\0'));
    const bytes = Buffer.concat([fixed, dynamic, Buffer.from([0x55])]);
    for (let split = 0; split <= bytes.length; split++) {
      const framer = new PacketFramer();
      expect([...framer.push(bytes.subarray(0, split)), ...framer.push(bytes.subarray(split))]).toEqual([
        fixed,
        dynamic,
        Buffer.from([0x55])
      ]);
      framer.finish();
    }
  });

  test('fails closed on unknown, invalid or truncated packets', () => {
    expect(() => new PacketFramer().push(Buffer.from([0xff]))).toThrow('Unsupported');
    expect(() => new PacketFramer().push(Buffer.from([0xbd, 0, 2]))).toThrow('Invalid');
    const framer = new PacketFramer();
    framer.push(Buffer.from([0x22]));
    expect(() => framer.finish()).toThrow('truncated');
    expect(() => new PacketFramer().push(Buffer.alloc(1024 * 1024 + 1))).toThrow('exceeded');
  });

  test('encodes normal credentials, creation choices and target cancellation at server offsets', () => {
    const login = packets.accountLogin('test-player', 'test-password');
    expect(login.length).toBe(62);
    expect(login.subarray(1, 12).toString()).toBe('test-player');
    expect(login.subarray(31, 44).toString()).toBe('test-password');
    expect(() => packets.accountLogin('x'.repeat(30), 'pass')).toThrow('Account name');
    const creation = packets.createCharacter({
      name: 'Miner A',
      city: 2,
      slot: 0,
      skills: [
        { id: 45, value: 50 },
        { id: 7, value: 50 }
      ]
    });
    expect(creation.length).toBe(104);
    expect([...creation.subarray(74, 78)]).toEqual([45, 50, 7, 50]);
    expect(creation.readUInt8(91)).toBe(2);
    expect(() =>
      packets.createCharacter({ name: 'Miner A', city: 0, slot: 0, skills: [{ id: 45, value: 100 }] })
    ).toThrow('skill');
    const cancel = packets.targetResponse({ id: 123, ground: true, flags: 0 }, null);
    expect(cancel.readUInt32BE(2)).toBe(123);
    expect(cancel.readUInt32BE(7)).toBe(0);
    expect(cancel.readUInt16BE(11)).toBe(65535);
    expect(cancel.readUInt16BE(13)).toBe(65535);
  });
});

describe('player observations', () => {
  test('validates offered city records and rejects truncated character lists', () => {
    const body = Buffer.alloc(1 + 5 * 60 + 1 + 89 + 6);
    body[0] = 5;
    body.write('Miner A', 1, 'ascii');
    body[301] = 1;
    body[302] = 2;
    body.write('Britain', 303, 'ascii');
    body.write('Sweet Dreams Inn', 335, 'ascii');
    const packet = packets.variable(0xa9, body);
    expect(characterList(packet).characters[0]).toBe('Miner A');
    expect(characterList(packet).cities).toEqual([{ index: 2, name: 'Britain', building: 'Sweet Dreams Inn' }]);
    expect(() => characterList(packet.subarray(0, 320))).toThrow('Truncated');
  });

  test('records only received entities, equipment and contents; discards removed entities', () => {
    const view = new WorldView();
    const mobile = Buffer.alloc(32);
    mobile[0] = 0x78;
    mobile.writeUInt16BE(32, 1);
    mobile.writeUInt32BE(123, 3);
    mobile.writeUInt16BE(400, 7);
    mobile.writeUInt16BE(100, 9);
    mobile.writeUInt16BE(200, 11);
    mobile.writeUInt32BE(456, 19);
    mobile.writeUInt16BE(0xe75, 23);
    mobile[25] = 21;
    view.apply(mobile);
    expect(view.entities.get(456)?.parent).toBe(123);
    expect(view.entities.get(456)?.layer).toBe(21);
    const content = Buffer.alloc(25);
    content[0] = 0x3c;
    content.writeUInt16BE(25, 1);
    content.writeUInt16BE(1, 3);
    content.writeUInt32BE(789, 5);
    content.writeUInt16BE(0xe86, 9);
    content.writeUInt16BE(1, 12);
    content.writeUInt32BE(456, 19);
    view.apply(content);
    expect(view.entities.get(789)?.graphic).toBe(0xe86);
    expect(view.entities.get(789)?.parent).toBe(456);
    view.apply(Buffer.from([0x1d, 0, 0, 3, 21]));
    expect(view.entities.has(789)).toBe(false);
  });

  test('bounds journal retention and clears cancelled targeting cursors', () => {
    const view = new WorldView();
    const body = Buffer.alloc(42);
    for (let i = 0; i < 205; i++) view.apply(packets.variable(0x1c, body));
    expect(view.journal).toHaveLength(200);
    const target = Buffer.alloc(19);
    target[0] = 0x6c;
    target[1] = 1;
    target.writeUInt32BE(42, 2);
    view.apply(target);
    expect(view.target?.id).toBe(42);
    target[6] = 3;
    view.apply(target);
    expect(view.target).toBeNull();
  });
});

test('rejects profiles and endpoint fields that have not been implemented', () => {
  const config = {
    schemaVersion: 1,
    shardId: 'test',
    emulator: 'servuo',
    profile: 'classic-7.0.45.1',
    host: '127.0.0.1',
    port: 2593,
    serverIndex: 0,
    timeoutMs: 1000
  };
  expect(validateConnection(config).host).toBe('127.0.0.1');
  expect(() => validateConnection({ ...config, emulator: 'sphere-x' })).toThrow('Unsupported');
  expect(() => validateConnection({ ...config, host: 'https://server/' })).toThrow('host');
  expect(() => validateConnection({ ...config, port: 0 })).toThrow('port');
  expect(() => validateConnection({ ...config, encryption: 1 })).toThrow('unknown');
});
