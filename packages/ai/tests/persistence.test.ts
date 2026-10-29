import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateConfig } from '../src/config';
import { openPersistence } from '../src/persistence';
import { PersistenceQueue } from '../src/persistence-queue';
import { ResidentStore } from '../src/store';
import example from '../templates/population.example.json';
import { required } from './behavior-fixture';

async function fixture(count?: number) {
  const directory = await mkdtemp(join(tmpdir(), 'gemwright-persistence-'));
  const path = join(directory, 'residents.sqlite');
  const errors: Error[] = [];
  const persistence = await openPersistence(path, example.shardId, (e) => errors.push(e));
  const store = new ResidentStore(path, example.shardId, persistence.database, persistence.flush);
  const input = structuredClone(example);
  if (count) input.targetPopulation = count;
  for (const t of input.templates) {
    t.version = 1;
    if (t.id === 'britain-miner') t.creation.city = 'Britain';
  }
  store.reconcile(validateConfig(input));
  await store.flush();
  return {
    path,
    store,
    persistence,
    errors,
    async close() {
      try {
        await persistence.close();
      } finally {
        store.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
  };
}

test('repeated checkpoints coalesce while revisions, credentials and the final state remain durable', async () => {
  const f = await fixture();
  try {
    let resident = required(f.store.list()[0]);
    const start = resident.revision;
    const commits = f.persistence.statistics().commits;
    for (let i = 0; i < 1000; i++)
      resident = f.store.saveProgress(
        resident.id,
        resident.revision,
        { ...resident.checkpoint, memories: [{ at: 'test', text: `step ${i}` }] },
        resident.binding
      );
    expect(f.persistence.statistics().coalesced).toBe(999);
    f.store.storeCredentials(resident.id, { username: 'test-account', password: 'test-password' });
    await f.store.flush();
    expect(f.persistence.statistics().commits - commits).toBe(1);
    const disk = new ResidentStore(f.path, example.shardId);
    try {
      expect(disk.get(resident.id)?.revision).toBe(start + 1000);
      expect(disk.get(resident.id)?.checkpoint.memories[0]?.text).toBe('step 999');
      expect(disk.credentials(resident.id)?.username).toBe('test-account');
    } finally {
      disk.close();
    }
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

test('a blocked durable writer does not block gameplay timers or memory reads', async () => {
  const f = await fixture();
  const lock = new Database(f.path);
  let ticks = 0;
  let released = false;
  const timer = setInterval(() => {
    ticks++;
  }, 5);
  try {
    lock.exec('BEGIN IMMEDIATE');
    f.store.setMetadata('blocked-write', 'confirmed');
    const flushing = f.store.flush();
    setTimeout(() => {
      lock.exec('COMMIT');
      released = true;
    }, 250);
    await Bun.sleep(100);
    expect(released).toBe(false);
    expect(ticks).toBeGreaterThan(5);
    expect(f.store.metadata('blocked-write')).toBe('confirmed');
    await flushing;
    expect(released).toBe(true);
    expect(f.errors).toEqual([]);
  } finally {
    clearInterval(timer);
    if (!released) lock.exec('ROLLBACK');
    lock.close();
    await f.close();
  }
});

test('rolled back memory transactions never reach disk', async () => {
  const f = await fixture();
  try {
    expect(() =>
      f.persistence.database.transaction(() => {
        f.store.setMetadata('rolled-back', 'no');
        throw new Error('abort');
      })()
    ).toThrow('abort');
    await f.store.flush();
    const disk = new ResidentStore(f.path, example.shardId);
    try {
      expect(disk.metadata('rolled-back')).toBeNull();
    } finally {
      disk.close();
    }
  } finally {
    await f.close();
  }
});

test('an external revision conflict stops persistence instead of overwriting a newer writer', async () => {
  const f = await fixture();
  try {
    const resident = required(f.store.list()[0]);
    const external = new ResidentStore(f.path, example.shardId);
    external.saveProgress(resident.id, resident.revision, resident.checkpoint, resident.binding);
    external.close();
    f.store.saveProgress(resident.id, resident.revision, resident.checkpoint, resident.binding);
    const failure = await f.store.flush().then(
      () => undefined,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('Durable resident write failed');
    expect(f.errors).toHaveLength(1);
    expect(() => f.store.setMetadata('after-failure', 'no')).toThrow();
  } finally {
    await f.close().catch(() => {});
  }
});

test('the pending write queue is bounded even when storage does not acknowledge writes', () => {
  const queue = new PersistenceQueue(200);
  expect(() => queue.push([{ sql: 'INSERT INTO metadata VALUES (?, ?)', args: ['key', 'x'.repeat(100)] }])).toThrow(
    'full'
  );
});

test('a full resident cohort is coalesced into one durable transaction', async () => {
  const f = await fixture(109);
  try {
    const commits = f.persistence.statistics().commits;
    for (const original of f.store.list()) {
      let resident = original;
      for (let i = 0; i < 10; i++)
        resident = f.store.saveProgress(
          resident.id,
          resident.revision,
          { ...resident.checkpoint, memories: [{ at: 'test', text: 'x'.repeat(100000) }] },
          resident.binding
        );
    }
    expect(f.persistence.statistics().coalesced).toBe(109 * 9);
    expect(f.persistence.statistics().pendingBytes).toBeLessThan(64 * 1024 * 1024);
    await f.store.flush();
    expect(f.persistence.statistics().commits - commits).toBe(1);
  } finally {
    await f.close();
  }
});

test('future row-returning mutations cannot bypass durable replay', async () => {
  const f = await fixture();
  try {
    expect(() =>
      f.persistence.database.query("INSERT INTO metadata VALUES ('bypass', 'no') RETURNING key").get()
    ).toThrow('Durable mutations');
    expect(f.store.metadata('bypass')).toBeNull();
  } finally {
    await f.close();
  }
});
