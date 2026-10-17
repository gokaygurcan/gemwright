import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createConfig } from './config';
import { ensureNewConfig, gitStatus, saveInstance } from './instance';

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});
async function temporaryFolder() {
  const folder = await mkdtemp(join(tmpdir(), 'gemwright-test-'));
  folders.push(folder);
  return folder;
}

test('writes config into nested directories and refuses to overwrite it', async () => {
  const directory = join(await temporaryFolder(), 'nested', 'shard');
  const config = createConfig({});
  await ensureNewConfig(directory);
  await saveInstance(directory, config, false);
  expect(JSON.parse(await readFile(join(directory, 'gemwright.json'), 'utf8'))).toEqual(config);
  await expect(ensureNewConfig(directory)).rejects.toThrow('Refusing to overwrite');
  await expect(saveInstance(directory, createConfig({ name: 'Other' }), false)).rejects.toThrow();
  expect(JSON.parse(await readFile(join(directory, 'gemwright.json'), 'utf8'))).toEqual(config);
});

test('detects a parent Git repository for a directory that does not exist yet', async () => {
  if (!Bun.which('git')) return;
  const directory = await temporaryFolder();
  expect(await gitStatus(directory)).toEqual({ available: true, insideRepository: false });
  await saveInstance(directory, createConfig({}), true);
  expect((await stat(join(directory, '.git'))).isDirectory()).toBe(true);
  expect(await gitStatus(join(directory, 'future', 'shard'))).toEqual({ available: true, insideRepository: true });
});

test('preserves existing ignore rules and refuses to replace existing ServUO config', async () => {
  const directory = await temporaryFolder();
  await writeFile(join(directory, '.gitignore'), 'custom-rule');
  await saveInstance(directory, createConfig({}), false, { '.gitignore': 'Saves/\nBackups/\n' });
  expect(await readFile(join(directory, '.gitignore'), 'utf8')).toBe('custom-rule\nSaves/\nBackups/\n');
  const other = join(await temporaryFolder(), 'shard');
  await mkdir(join(other, 'Config'), { recursive: true });
  await writeFile(join(other, 'Config/Server.cfg'), 'Name=Existing');
  await expect(saveInstance(other, createConfig({}), false, { 'Config/Server.cfg': 'Name=New' })).rejects.toThrow(
    'Refusing to overwrite'
  );
  expect(await Bun.file(join(other, 'gemwright.json')).exists()).toBe(false);
  expect(await readFile(join(other, 'Config/Server.cfg'), 'utf8')).toBe('Name=Existing');
});

test('refuses to write instance files through a symlinked parent directory', async () => {
  const directory = await temporaryFolder();
  const outside = await temporaryFolder();
  await symlink(outside, join(directory, 'Config'));
  await expect(saveInstance(directory, createConfig({}), false, { 'Config/Server.cfg': 'Name=New' })).rejects.toThrow(
    'non-directory'
  );
  expect(await Bun.file(join(outside, 'Server.cfg')).exists()).toBe(false);
});
