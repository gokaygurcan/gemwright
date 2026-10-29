import { expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { CommandRejected, PlayerSession, validateConnection, WorldView } from '@gemwright/network';
import { purchaseItem, requestAnimalPurchase } from '@gemwright/network/commerce';
import { onNetworkTiming, timed } from '@gemwright/network/diagnostics';

const config = validateConnection({
  schemaVersion: 1,
  shardId: 'test',
  emulator: 'servuo',
  profile: 'classic-7.0.45.1',
  host: '127.0.0.1',
  port: 2593,
  serverIndex: 0,
  timeoutMs: 1000
});

test('the network source depends only on its own modules, builtins and common codecs/data', async () => {
  const root = resolve(import.meta.dir, '../src');
  for (const name of await readdir(root)) {
    if (!name.endsWith('.ts')) continue;
    const source = await readFile(resolve(root, name), 'utf8');
    const imports = [...source.matchAll(/(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g)];
    for (const match of imports) {
      const specifier = match[1] ?? '';
      if (specifier.startsWith('.'))
        expect(resolve(dirname(resolve(root, name)), specifier).startsWith(`${root}/`)).toBe(true);
      else
        expect(specifier === 'bun' || specifier.startsWith('node:') || specifier.startsWith('@gemwright/common/')).toBe(
          true
        );
    }
  }
  const manifest = JSON.parse(await readFile(resolve(root, '../package.json'), 'utf8'));
  expect(manifest.dependencies).toEqual({ '@gemwright/common': 'workspace:*' });
});

test('the public package constructs a client and decoded world without an AI runtime', () => {
  const session = new PlayerSession(config);
  expect(session.world).toBeInstanceOf(WorldView);
  const target = Buffer.alloc(19);
  target[0] = 0x6c;
  target.writeUInt32BE(42, 2);
  session.world.apply(target);
  expect(session.world.target?.id).toBe(42);
  session.close();
});

test('timing consumers can unsubscribe and cannot change protocol results or errors', () => {
  const seen: string[] = [];
  const stop = onNetworkTiming(({ label, ms }) => {
    seen.push(label);
    expect(ms).toBeGreaterThanOrEqual(0);
  });
  const broken = onNetworkTiming(() => {
    throw new Error('broken telemetry');
  });
  try {
    expect(timed('package-result', () => 42)).toBe(42);
    const original = new Error('protocol failure');
    expect(() =>
      timed('package-error', () => {
        throw original;
      })
    ).toThrow(original);
    expect(seen).toEqual(['package-result', 'package-error']);
    stop();
    expect(timed('unsubscribed', () => 7)).toBe(7);
    expect(seen).toHaveLength(2);
  } finally {
    stop();
    broken();
  }
});

function vendorFixture() {
  const world = new WorldView();
  world.entities.set(10, { serial: 10, kind: 'item', graphic: 0xe75 });
  world.entities.set(20, { serial: 20, kind: 'item', graphic: 0x2af8, parent: 2 });
  world.entities.set(30, { serial: 30, kind: 'item', graphic: 0xfab, amount: 5, parent: 20 });
  world.buyOffers.set(20, [{ serial: 30, price: 50, description: 'shard-specific animal' }]);
  const session = {
    world,
    waitFor: async (predicate: () => boolean) => {
      world.addJournal({ serial: 2, name: 'vendor', cliloc: 500191 });
      expect(predicate()).toBe(true);
    }
  } as unknown as PlayerSession;
  return { session, world };
}

test('vendor refusal is a network rejection, independent of AI recovery policy', async () => {
  const { session } = vendorFixture();
  let sent = 0;
  let error: unknown;
  try {
    await purchaseItem(
      session,
      () => {
        sent++;
      },
      2,
      30,
      10,
      1,
      50
    );
  } catch (caught) {
    error = caught;
  }
  expect(sent).toBe(1);
  expect(error).toBeInstanceOf(CommandRejected);
  expect((error as CommandRejected).code).toBe('vendor-insufficient-funds');
});

test('animal requests allow shard-specific stock while retaining protocol and follower bounds', () => {
  const { session, world } = vendorFixture();
  world.status = { followers: 0, maxFollowers: 5 } as NonNullable<WorldView['status']>;
  const sent: Buffer[] = [];
  requestAnimalPurchase(session, (packet) => sent.push(packet), 2, 30, 50);
  expect(sent).toHaveLength(1);
  expect(sent[0]?.[0]).toBe(0x3b);
  expect(() => requestAnimalPurchase(session, () => {}, 2, 30, 49)).toThrow();
  world.status.followers = 5;
  expect(() => requestAnimalPurchase(session, () => {}, 2, 30, 50)).toThrow('follower');
});
