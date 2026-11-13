import { expect, test } from 'bun:test';

import { skillId } from '@gemwright/common/game/skills';
import { PlayerSession } from '@gemwright/network/session';

import { mockShard } from '../../network/tests/mock-shard';
import { validateConfig } from '../src/v1/config';
import { creationRequest } from '../src/v1/creation-request';
import { ResidentStore } from '../src/v1/store';
import example from '../templates/population.example.json';

// A new resident's first login creates its character from its template (creation-request.ts): the
// store makes the resident, the request carries its name, city, skills and appearance, and the
// shard receives it as a player's Create Character (0x00), answered by entry into the world.
test('a new resident creates its character on an empty account and enters the world', async () => {
  const shard = await mockShard({ empty: true });
  const config = validateConfig(structuredClone(example));
  const store = new ResidentStore(':memory:', config.shardId);
  const session = new PlayerSession(shard.config);
  const sent: Buffer[] = [];
  session.tap = (direction, packet) => {
    if (direction === 'out') sent.push(packet);
  };
  try {
    store.reconcile(config);
    const resident = store.list().find((r) => r.templateId === 'britain-swordsman');
    if (!resident) throw new Error('The example population has no swordsman resident');
    const request = creationRequest(store, resident, true);
    const creation = request.create;
    const look = creation?.appearance;
    if (!creation || !look) throw new Error('A new resident must ask for a creation with an appearance');

    // The resident intends the character its template describes.
    expect(creation.name).toBe(resident.proposedName);
    expect(creation.city).toBe('Britain');
    expect(creation.skills).toEqual([
      { id: skillId('Swordsmanship'), value: 50 },
      { id: skillId('Tactics'), value: 50 }
    ]);

    await session.connect({ username: 'gw-test-player', password: 'test-password' }, request);

    // The shard made the character, and the session entered the world as it.
    expect(shard.created()).toBe(1);
    expect(session.phase).toBe('ready');
    expect(session.world.serial).toBe(123);

    // The creation on the wire is that character, at the offsets ServUO reads.
    const packet = sent.find((candidate) => candidate[0] === 0x00);
    if (!packet) throw new Error('No character creation reached the shard');
    expect(packet.length).toBe(104);
    expect(packet.subarray(10, 10 + creation.name.length).toString('ascii')).toBe(creation.name);
    expect([...packet.subarray(74, 74 + creation.skills.length * 2)]).toEqual(
      creation.skills.flatMap((skill) => [skill.id, skill.value])
    );
    expect(packet[91]).toBe(0); // The index of the Britain the shard offered.
    expect(packet.readUInt32BE(92)).toBe(request.slot);
    expect(packet[70]).toBe(look.genderRace);
    expect(packet.readUInt16BE(80)).toBe(look.skinHue);
    expect(packet.readUInt16BE(82)).toBe(look.hair);
    expect(packet.readUInt16BE(84)).toBe(look.hairHue);
    expect(packet.readUInt16BE(86)).toBe(look.beard);
    expect(packet.readUInt16BE(88)).toBe(look.beardHue);
    expect(packet.readUInt16BE(100)).toBe(look.shirtHue);
    expect(packet.readUInt16BE(102)).toBe(look.pantsHue);
    expect(shard.errors).toEqual([]);
  } finally {
    session.close();
    store.close();
    await shard.close();
  }
});
