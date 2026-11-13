import { expect, test } from 'bun:test';

import { skillId } from '@gemwright/common/game/skills';
import { PlayerSession } from '@gemwright/network/session';

import { mockShard } from '../../network/tests/mock-shard';
import { validateConfig } from '../src/v1/config';
import { creationRequest } from '../src/v1/creation-request';
import { ResidentStore } from '../src/v1/store';
import example from '../templates/population.example.json';

// Continuing the creation experiment: the character a template made enters the world, and asking
// the shard for its skills (the client's skill button, 0x34 type 5) answers with what it has
// (0x3A): the template's two skills, each 50.0 of a 100.0 cap.
test('the created character has its two template skills at 50.0 of 100.0', async () => {
  const shard = await mockShard({ empty: true });
  const config = validateConfig(structuredClone(example));
  const store = new ResidentStore(':memory:', config.shardId);
  const session = new PlayerSession(shard.config);
  try {
    store.reconcile(config);
    const resident = store.list().find((r) => r.templateId === 'britain-swordsman');
    if (!resident) throw new Error('The example population has no swordsman resident');
    await session.connect(
      { username: 'gw-test-player', password: 'test-password' },
      creationRequest(store, resident, true)
    );
    expect(session.phase).toBe('ready');
    expect(shard.created()).toBe(1);

    // Nothing of the character's skills is known until the shard answers.
    expect(session.world.skills.size).toBe(0);
    await session.refreshSkills();

    // In the world it has exactly the two skills its template gave it, at 50.0, capped at 100.0.
    expect(session.world.skills.size).toBe(2);
    expect(session.world.skills.get(skillId('Swordsmanship'))).toEqual({ value: 50, base: 50, cap: 100, lock: 0 });
    expect(session.world.skills.get(skillId('Tactics'))).toEqual({ value: 50, base: 50, cap: 100, lock: 0 });
    expect(shard.errors).toEqual([]);
  } finally {
    session.close();
    store.close();
    await shard.close();
  }
});
