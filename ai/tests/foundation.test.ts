import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { allocatePopulation, validateConfig } from '../src/config';
import { ResidentStore } from '../src/store';
import example from '../templates/population.example.json';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing test fixture');
  return value;
}

function config() {
  const input = structuredClone(example);
  for (const template of input.templates) {
    template.version = 1;
    if (template.id === 'britain-miner') template.creation.city = 'Britain';
  }
  return validateConfig(input);
}

describe('configuration and allocation', () => {
  test('rejects configuration mistakes before persistence', () => {
    const mutations = [
      (c: typeof example) => {
        Object.assign(required(c.templates[0]), { behaviour: {} });
      },
      (c: typeof example) => {
        required(c.templates[0]).behavior.riskTolerance = 1.1;
      },
      (c: typeof example) => {
        required(c.templates[0]).creation.skills.Mining = -1;
      },
      (c: typeof example) => {
        required(c.templates[0]).behavior.supplies.pickaxe = 0.5;
      },
      (c: typeof example) => {
        required(c.templates[1]).id = required(c.templates[0]).id;
      },
      (c: typeof example) => {
        required(c.allocation.entries[0]).templateId = 'missing';
      },
      (c: typeof example) => {
        required(c.allocation.entries[0]).weight = 0;
      },
      (c: typeof example) => {
        c.targetPopulation = 1.5;
      },
      (c: typeof example) => {
        c.schemaVersion = 2;
      },
      (c: typeof example) => {
        c.shardId = '../escape';
      }
    ];
    for (const mutate of mutations) {
      const input = structuredClone(example);
      mutate(input);
      expect(() => validateConfig(input)).toThrow();
    }
  });

  test('weighted allocation sums exactly and breaks ties by template ID', () => {
    for (let target = 0; target < 50; target++) {
      const c = config();
      c.targetPopulation = target;
      const allocated = allocatePopulation(c);
      expect(Object.values(allocated).reduce((a, b) => a + b, 0)).toBe(target);
      c.allocation.entries.reverse();
      expect(allocatePopulation(c)).toEqual(allocated);
    }
    const c = config();
    c.targetPopulation = 1;
    expect(allocatePopulation(c)).toEqual({ 'britain-lumberjack': 0, 'britain-miner': 1, 'britain-swordsman': 0 });
  });

  test('fixed counts must agree with the total', () => {
    const c = config();
    c.allocation = { mode: 'fixed', entries: [{ templateId: 'britain-miner', count: 4 }] };
    expect(allocatePopulation(validateConfig(c))).toEqual({
      'britain-lumberjack': 0,
      'britain-miner': 4,
      'britain-swordsman': 0
    });
    c.targetPopulation = 3;
    expect(() => validateConfig(c)).toThrow('must sum');
  });
});

describe('resident persistence', () => {
  test('reconciliation is idempotent; shrinking parks and growing reuses residents', () => {
    const c = config();
    const store = new ResidentStore(':memory:', c.shardId);
    try {
      expect(store.reconcile(c)).toEqual({ created: 4, active: 4, parked: 0 });
      const original = store.list();
      expect(store.reconcile(c)).toEqual({ created: 0, active: 4, parked: 0 });
      expect(store.list()).toEqual(original);
      c.targetPopulation = 0;
      expect(store.reconcile(c)).toEqual({ created: 0, active: 0, parked: 4 });
      c.targetPopulation = 4;
      expect(store.reconcile(c)).toEqual({ created: 0, active: 4, parked: 0 });
      expect(store.list().map((r) => r.id)).toEqual(original.map((r) => r.id));
    } finally {
      store.close();
    }
  });

  test('template upgrades preserve creation, identity, binding and memories', () => {
    const c = config();
    const store = new ResidentStore(':memory:', c.shardId);
    try {
      store.reconcile(c);
      const resident = required(store.list()[0]);
      const checkpoint = {
        goal: { kind: 'mine', phase: 'return-to-bank' },
        memories: [{ at: '2026-10-19T00:00:00Z', text: 'The eastern mine was dangerous.' }],
        relationships: { companion: { affinity: 0.8, note: 'Helped me.' } }
      };
      const binding = { accountRef: 'secret-store/resident-1', characterSerial: '0x123' };
      store.saveProgress(resident.id, resident.revision, checkpoint, binding);
      const miner = required(c.templates.find((t) => t.id === 'britain-miner'));
      miner.version = 2;
      miner.creation.city = 'Minoc';
      miner.behavior.riskTolerance = 0.1;
      store.reconcile(c);
      const updated = required(store.list().find((r) => r.id === resident.id));
      expect(updated.creationVersion).toBe(1);
      expect(updated.policyVersion).toBe(2);
      // Loading upgrades the checkpoint shape but preserves its content.
      expect(updated.checkpoint).toEqual({ ...checkpoint, schemaVersion: 2 });
      expect(updated.binding).toEqual(binding);
      expect(store.template('britain-miner', 1)?.creation.city).toBe('Britain');
      expect(store.template('britain-miner', 2)?.creation.city).toBe('Minoc');
      expect(() => store.saveProgress(resident.id, resident.revision, checkpoint, binding)).toThrow(
        'revision conflict'
      );
    } finally {
      store.close();
    }
  });

  test('a conflicting template rolls back earlier revisions in the same reconciliation', () => {
    const c = config();
    const store = new ResidentStore(':memory:', c.shardId);
    try {
      store.reconcile(c);
      const before = store.list();
      required(c.templates[0]).version = 2;
      required(c.templates[1]).label = 'Changed without version bump';
      expect(() => store.reconcile(c)).toThrow('increment its version');
      expect(store.template('britain-miner', 2)).toBeNull();
      expect(store.list()).toEqual(before);
    } finally {
      store.close();
    }
  });

  test('removing a template parks its residents and retains historical snapshots', () => {
    const c = config();
    const store = new ResidentStore(':memory:', c.shardId);
    try {
      store.reconcile(c);
      const miners = store.list().filter((r) => r.templateId === 'britain-miner');
      c.templates = c.templates.filter((t) => t.id !== 'britain-miner');
      if (c.allocation.mode !== 'weighted') throw new Error('Expected weighted fixture');
      c.allocation.entries = c.allocation.entries.filter((e) => e.templateId !== 'britain-miner');
      store.reconcile(c);
      expect(
        store
          .list()
          .filter((r) => r.templateId === 'britain-miner')
          .map((r) => r.id)
      ).toEqual(miners.map((r) => r.id));
      expect(
        store
          .list()
          .filter((r) => r.templateId === 'britain-miner')
          .every((r) => !r.desiredActive)
      ).toBe(true);
      expect(store.template('britain-miner', 1)).not.toBeNull();
    } finally {
      store.close();
    }
  });

  test('committed progress survives reopening and uncommitted crash writes do not', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gemwright-ai-'));
    const path = join(directory, 'residents.sqlite');
    const c = config();
    let store = new ResidentStore(path, c.shardId);
    try {
      store.reconcile(c);
      const resident = required(store.list()[0]);
      const saved = store.saveProgress(
        resident.id,
        resident.revision,
        { goal: { kind: 'hunt', phase: 'recover-corpse' }, memories: [], relationships: {} },
        null
      );
      store.close();
      const script = `import { Database } from 'bun:sqlite'; const db = new Database(process.argv[1]); db.exec('BEGIN IMMEDIATE; UPDATE residents SET desired_active = 0'); process.kill(process.pid, 'SIGKILL');`;
      const child = Bun.spawnSync([process.execPath, '-e', script, path]);
      expect(child.exitCode).not.toBe(0);
      store = new ResidentStore(path, c.shardId);
      expect(store.list().find((r) => r.id === resident.id)).toEqual(saved);
      expect(store.reconcile(c).created).toBe(0);
      expect(() => new ResidentStore(path, 'another-shard')).toThrow('different shard');
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('rejects unknown database versions and template downgrades', () => {
    const c = config();
    const store = new ResidentStore(':memory:', c.shardId);
    try {
      required(c.templates[0]).version = 2;
      store.reconcile(c);
      expect(() => store.reconcile(config())).toThrow('cannot downgrade');
    } finally {
      store.close();
    }
    const directory = mkdtempSync(join(tmpdir(), 'gemwright-ai-version-'));
    const path = join(directory, 'residents.sqlite');
    try {
      const db = new Database(path);
      db.exec('PRAGMA user_version = 99');
      db.close();
      expect(() => new ResidentStore(path, c.shardId)).toThrow('Unsupported resident database version');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
