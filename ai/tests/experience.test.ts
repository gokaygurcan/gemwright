import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateConfig } from '../src/config';
import {
  bandageAdvice,
  encounterAdvice,
  reconcileExperience,
  rememberExperience,
  serviceAdvice
} from '../src/experience';
import { type Checkpoint, ResidentStore } from '../src/store';
import example from '../templates/population.example.json';

const now = 1_000_000_000;
const place = { map: 1, x: 1400, y: 1500 };
const combat = {
  kind: 'combat' as const,
  id: 'fight',
  at: now,
  ...place,
  body: 3,
  outcome: 'death' as const,
  largestLossRatio: 0.6,
  lowestHealthRatio: 0,
  damageRatio: 1
};
const checkpoint = (): Checkpoint => ({ goal: null, memories: [], relationships: {} });

test('old checkpoints initialize memory; bounded retention rejects future schemas', () => {
  const state = checkpoint();
  reconcileExperience(state, now);
  for (let i = 0; i < 40; i++) rememberExperience(state, { ...combat, id: `fight-${i}`, at: now - i }, now);
  expect(state.experience?.events).toHaveLength(24);
  rememberExperience(state, { ...combat, id: 'expired', at: now - 8 * 86400000 }, now);
  rememberExperience(state, { ...combat, id: 'future', at: now + 1 }, now);
  expect(state.experience?.events).toHaveLength(24);
  expect(state.experience?.events.some((event) => ['expired', 'future'].includes(event.id))).toBe(false);
  expect(() =>
    reconcileExperience({ ...state, experience: { schemaVersion: 2, events: [] } } as unknown as Checkpoint)
  ).toThrow('schema');
});

test('danger is local, temporary and cannot be inferred from disconnects or refused attacks', () => {
  const state = checkpoint();
  rememberExperience(state, { ...combat, outcome: 'interrupted' }, now);
  expect(encounterAdvice(state, place, 3, now).caution).toBe(0);
  rememberExperience(
    state,
    { ...combat, outcome: 'retreat', largestLossRatio: 0, lowestHealthRatio: 1, damageRatio: 0 },
    now
  );
  expect(encounterAdvice(state, place, 3, now).caution).toBe(0);
  rememberExperience(state, combat, now);
  rememberExperience(state, { ...combat, outcome: 'interrupted' }, now);
  expect(state.experience?.events).toHaveLength(1);
  expect(encounterAdvice(state, place, 3, now).avoidUntil).toBe(now + 600000);
  expect(encounterAdvice(state, { ...place, map: 0 }, 3, now).samples).toBe(0);
  expect(encounterAdvice(state, { ...place, x: 1600 }, 3, now).samples).toBe(0);
  expect(encounterAdvice(state, place, 4, now).samples).toBe(0);
  expect(encounterAdvice(state, place, 3, now + 86400001).caution).toBe(0);
});

test('healing needs repeated confirmed failures at comparable skill', () => {
  const state = checkpoint();
  for (let i = 0; i < 3; i++)
    rememberExperience(state, { kind: 'bandage', id: `b${i}`, at: now, ...place, outcome: 'failure', skill: 20 }, now);
  expect(bandageAdvice(state, 20, now).unreliable).toBe(true);
  expect(bandageAdvice(state, 80, now).unreliable).toBe(false);
  rememberExperience(state, { kind: 'bandage', id: 'success', at: now, ...place, outcome: 'success', skill: 20 }, now);
  expect(bandageAdvice(state, 20, now).unreliable).toBe(false);
  expect(bandageAdvice(state, 20, now + 6 * 3600000).samples).toBe(0);
});

test('vendor stock cooldown applies to the requested goods and confirmed success clears it', () => {
  const state = checkpoint();
  const event = {
    kind: 'service' as const,
    id: 'stock',
    at: now,
    ...place,
    vendor: 123,
    action: 3006103,
    needs: [1, 2],
    outcome: 'no-stock' as const
  };
  rememberExperience(state, event, now);
  expect(serviceAdvice(state, place, 123, 3006103, now, [2, 1]).cooldownUntil).toBeGreaterThan(now);
  expect(serviceAdvice(state, place, 123, 3006103, now, [3]).cooldownUntil).toBe(0);
  rememberExperience(state, { ...event, id: 'bought', at: now + 1, outcome: 'success' }, now + 1);
  expect(serviceAdvice(state, place, 123, 3006103, now + 1, [1, 2])).toEqual({ cooldownUntil: 0, successful: true });
});

test('committed experience survives a resident database reopen and changes advice', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gemwright-experience-'));
  const file = join(directory, 'residents.sqlite');
  const config = validateConfig(structuredClone(example));
  let store = new ResidentStore(file, config.shardId);
  try {
    store.reconcile(config);
    const resident = store.list()[0];
    if (!resident) throw new Error('Missing resident');
    rememberExperience(resident.checkpoint, combat, now);
    store.saveProgress(resident.id, resident.revision, resident.checkpoint, resident.binding);
    store.close();
    store = new ResidentStore(file, config.shardId);
    const restored = store.list().find((row) => row.id === resident.id);
    if (!restored) throw new Error('Missing restored resident');
    expect(encounterAdvice(restored.checkpoint, place, 3, now).avoidUntil).toBe(now + 600000);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('emergency retreats from casters set a cooldown, and repeated losses a longer one', () => {
  const state = checkpoint();
  reconcileExperience(state, now);
  // Live spectre fight: largest hit 26/76 (0.34), driven down to 25/76.
  const retreat = {
    ...combat,
    id: 'spectre',
    body: 26,
    outcome: 'retreat' as const,
    largestLossRatio: 0.34,
    lowestHealthRatio: 0.33,
    damageRatio: 0.7
  };
  rememberExperience(state, retreat, now);
  expect(encounterAdvice(state, place, 26, now + 60_000).avoidUntil).toBe(now + 15 * 60_000);
  rememberExperience(state, { ...retreat, id: 'wraith', at: now + 120_000 }, now + 120_000);
  expect(encounterAdvice(state, place, 26, now + 180_000).avoidUntil).toBe(now + 120_000 + 60 * 60_000);
});
