import { expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { residentCredentials } from '../src/credentials';
import { ResidentStore } from '../src/store';

test('leases exclude a second runtime and expired owners cannot renew or release a replacement', () => {
  const store = new ResidentStore(':memory:', 'test');
  try {
    const first = store.acquireLease(100, 1000);
    expect(() => store.acquireLease(100, 1050)).toThrow('Another');
    store.renewLease(first, 100, 1090);
    expect(() => store.acquireLease(100, 1150)).toThrow('Another');
    const replacement = store.acquireLease(100, 1200);
    expect(() => store.renewLease(first, 100, 1201)).toThrow('lost');
    store.releaseLease(first);
    expect(() => store.acquireLease(100, 1202)).toThrow('Another');
    store.releaseLease(replacement);
    expect(store.acquireLease(100, 1203)).toBeString();
  } finally {
    store.close();
  }
});

test('account credentials live in the resident database and require explicit provisioning', async () => {
  const store = new ResidentStore(':memory:', 'test');
  const id = crypto.randomUUID();
  try {
    await expect(residentCredentials(store, id, false)).rejects.toThrow('explicitly');
    const first = await residentCredentials(store, id, true);
    expect(await residentCredentials(store, id, false)).toEqual(first);
    expect(first.password.length).toBe(24);
  } finally {
    store.close();
  }
});

test('earlier credential files are imported once, and unsafe ones are refused', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gemwright-ai-vault-'));
  const store = new ResidentStore(':memory:', 'test');
  const id = crypto.randomUUID();
  const loose = crypto.randomUUID();
  try {
    await writeFile(join(directory, `${id}.json`), JSON.stringify({ username: 'gwold', password: 'secret' }), {
      mode: 0o600
    });
    expect(await residentCredentials(store, id, false, directory)).toEqual({ username: 'gwold', password: 'secret' });
    expect(store.credentials(id)?.username).toBe('gwold');
    await writeFile(join(directory, `${loose}.json`), JSON.stringify({ username: 'gwloose', password: 'x' }));
    await chmod(join(directory, `${loose}.json`), 0o644);
    await expect(residentCredentials(store, loose, false, directory)).rejects.toThrow('private');
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
