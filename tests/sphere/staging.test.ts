import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createConfig } from '../../src/config';
import { prepareSphereFiles } from '../../src/emulators/sphere/config';
import { sphereSources } from '../../src/emulators/sphere/source';
import { packageClientFiles, stageSphere, validateSphereShard } from '../../src/emulators/sphere/staging';
import { saveInstance } from '../../src/instance';
import { command } from '../../src/process';
import { sphereFixture, sphereSettings } from './config-fixture';

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});
const config = createConfig({
  emulator: 'sphere',
  expansion: 'base',
  source: { ...sphereSources.server, revision: 'a'.repeat(40) },
  sphere: sphereSettings
});
async function shard() {
  const directory = await mkdtemp(join(tmpdir(), 'gemwright-sphere-stage-'));
  folders.push(directory);
  await saveInstance(
    directory,
    config,
    false,
    prepareSphereFiles(sphereFixture(), config, sphereSettings, 'Sphere-Password')
  );
  return directory;
}

test('Sphere preflight accepts generated paths without rewriting config and rejects unsupported paths before staging', async () => {
  const directory = await shard();
  const original = await readFile(join(directory, 'sphere.ini'));
  await validateSphereShard(directory, config);
  expect(await readFile(join(directory, 'sphere.ini'))).toEqual(original);
  const changed = original.toString('latin1').replace('WorldSave=save/', 'WorldSave=custom/');
  await writeFile(join(directory, 'sphere.ini'), Buffer.from(changed, 'latin1'));
  await mkdir(join(directory, '.gemwright/deploy'), { recursive: true });
  await writeFile(join(directory, '.gemwright/deploy/keep'), 'previous staging');
  await expect(stageSphere(directory, config)).rejects.toThrow('WorldSave=save/');
  expect(await readFile(join(directory, '.gemwright/deploy/keep'), 'utf8')).toBe('previous staging');
  expect(await readFile(join(directory, 'sphere.ini'), 'latin1')).toBe(changed);
});

test('Sphere packages its native multi and hue files, excluding unsupported UOP multis and client-only data', async () => {
  const directory = await shard();
  const source = join(directory, 'client');
  await mkdir(source);
  await mkdir(join(directory, '.gemwright'));
  for (const file of [
    'map0LegacyMUL.uop',
    'map5LegacyMUL.uop',
    'statics5.mul',
    'staidx5.mul',
    'statics0.mul',
    'staidx0.mul',
    'tiledata.mul',
    'multi.idx',
    'multi.mul',
    'hues.mul',
    'MultiCollection.uop',
    'map0xLegacyMUL.uop',
    'artLegacyMUL.uop'
  ])
    await writeFile(join(source, file), 'test');
  const archive = await packageClientFiles(directory, source);
  expect(archive.bytes).toBe(40);
  const names = await command(['tar', '-tzf', archive.archive], directory);
  expect(names).toContain('hues.mul');
  expect(names).toContain('multi.idx');
  expect(names).not.toContain('MultiCollection');
  expect(names).not.toContain('map0x');
  expect(names).not.toContain('artLegacy');
  await rm(join(source, 'multi.idx'));
  await expect(packageClientFiles(directory, source)).rejects.toThrow('MultiCollection.uop is not a replacement');
  await writeFile(join(source, 'multi.idx'), 'test');
  await rm(join(source, 'hues.mul'));
  await expect(packageClientFiles(directory, source)).rejects.toThrow('hues.mul');
});

test('Sphere refuses an unrecorded or different source before changing existing staging', async () => {
  const directory = await shard();
  await expect(validateSphereShard(directory, { ...config, source: undefined })).rejects.toThrow('source pair');
  await expect(
    validateSphereShard(directory, {
      ...config,
      sphere: {
        ...sphereSettings,
        scriptsSource: { ...sphereSettings.scriptsSource, repository: 'https://example.invalid/scripts.git' }
      }
    })
  ).rejects.toThrow('source pair');
});
