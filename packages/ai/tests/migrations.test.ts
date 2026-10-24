import { expect, test } from 'bun:test';

import { CHECKPOINT_VERSION, migrateCheckpoint } from '../src/checkpoint-migrations';

test('version 1 checkpoints are normalized and stamped', () => {
  const migrated = migrateCheckpoint({
    goal: 'mining',
    memories: [{ at: 'x', text: 'kept' }],
    relationships: { Rowan: { affinity: 4, note: 7 }, Broken: 'nope' },
    landmarks: { depleted: [{ key: 'old', until: 0 }] },
    hunting: { killsSinceBank: 0, pending: 'hunt' }
  });
  expect(migrated.schemaVersion).toBe(CHECKPOINT_VERSION);
  expect(migrated.goal).toBeNull();
  expect(migrated.memories).toHaveLength(1);
  expect(migrated.relationships).toEqual({ Rowan: { affinity: 1, note: '' } });
  expect(migrated.landmarks?.forges).toEqual([]);
  expect(migrated.landmarks?.depleted).toEqual([]);
  expect(migrated.hunting?.loot).toEqual([]);
});

test('checkpoints from a newer runtime are refused', () => {
  expect(() => migrateCheckpoint({ schemaVersion: CHECKPOINT_VERSION + 1, goal: null })).toThrow('newer');
});
