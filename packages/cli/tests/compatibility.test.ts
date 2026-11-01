import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertCompatible, validateSchema } from '@gemwright/common/config/compatibility';
import { createConfig, loadShard } from '@gemwright/server/config';

import { deploy } from '../src/deploy';
import { updatePackages } from '../src/package-update';

const folders: string[] = [];
afterEach(async () => {
  for (const dir of folders.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture(value: unknown) {
  const dir = await mkdtemp(join(tmpdir(), 'gemwright-compatibility-'));
  folders.push(dir);
  await writeFile(join(dir, 'gemwright.json'), JSON.stringify(value));
  return dir;
}
test('schema 1 adopts old files and accepts newer compatible selections without a CLI bump', async () => {
  const config = createConfig({ client: { version: '7.0.45.1' } });
  const dir = await fixture(config);
  expect((await loadShard(dir)).id).toBe('gemwright');
  const newer = { ...config, schemaVersion: 1, packages: { ai: '0.8.12', client: '0.9.0' } };
  validateSchema(newer);
  assertCompatible(1, 'ai', '0.8.12');
  await writeFile(join(dir, 'gemwright.json'), JSON.stringify(newer));
  expect((await loadShard(dir)).packages?.ai).toBe('0.8.12');
});
test('unknown schema, incompatible versions and malformed fields fail before deployment side effects', async () => {
  for (const input of [
    { schemaVersion: 2 },
    { packages: { ai: '1.0.0' } },
    { packages: { ai: 'latest' } },
    { packages: { unknown: '0.8.0' } },
    { ai: { population: '10' } },
    { connection: { host: 'server', port: 0 } }
  ]) {
    const dir = await fixture({ ...createConfig({ client: { version: '7.0.45.1' } }), ...input });
    await expect(deploy({ ai: true }, dir)).rejects.toThrow();
    expect(await Bun.file(join(dir, '.gemwright/railway.json')).exists()).toBe(false);
  }
});
test('discovery reports an exact compatible update; explicit selection preserves other settings and never deploys', async () => {
  // Versions relative to the CLI's own: a release bump must not turn the fixture's "newer" into the current one.
  const [major, minor, patch] = (
    JSON.parse(await readFile(join(import.meta.dir, '../package.json'), 'utf8')).version as string
  )
    .split('.')
    .map(Number);
  const newer = `${major}.${minor}.${(patch ?? 0) + 1}`;
  const unpublished = `${major}.${minor}.${(patch ?? 0) + 2}`;
  const dir = await fixture({ ...createConfig({ client: { version: '7.0.45.1' } }), packages: { client: '0.7.0' } });
  const messages: string[] = [];
  const discover = async () => ['0.7.0', newer, '1.0.0'];
  await updatePackages({ component: 'ai' }, dir, discover, (s) => messages.push(s));
  expect(messages.join('\n')).toContain(`gemwright update --ai --package-version ${newer}`);
  expect(JSON.parse(await readFile(join(dir, 'gemwright.json'), 'utf8')).packages.ai).toBeUndefined();
  await updatePackages({ component: 'ai', version: newer }, dir, discover, () => {});
  expect((await loadShard(dir)).packages).toEqual({ client: '0.7.0', ai: newer });
  const saved = await readFile(join(dir, 'gemwright.json'), 'utf8');
  await expect(updatePackages({ component: 'ai', version: unpublished }, dir, discover)).rejects.toThrow(
    'not published'
  );
  await expect(updatePackages({ component: 'ai', version: '1.0.0' }, dir, discover)).rejects.toThrow('unsupported');
  await expect(
    updatePackages({ component: 'ai' }, dir, async () => {
      throw new Error('offline');
    })
  ).rejects.toThrow('offline');
  expect(await readFile(join(dir, 'gemwright.json'), 'utf8')).toBe(saved);
  expect(await Bun.file(join(dir, '.gemwright/railway.json')).exists()).toBe(false);
});

test('a gemwright.json from before client.version names the field to add', () => {
  const config = {
    schemaVersion: 1,
    name: 'Gemwright',
    id: 'gemwright',
    timezone: 'UTC',
    expansion: 'ej',
    emulator: 'servuo'
  };
  expect(() => validateSchema(config)).toThrow('"client": { "version": "7.0.45.1" }');
});
