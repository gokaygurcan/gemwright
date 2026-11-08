import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { copyShardFiles } from '../src/emulators/shard-files';

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

test('copying shard files leaves macOS Finder and AppleDouble files behind', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gemwright-shard-files-'));
  folders.push(directory);
  await mkdir(join(directory, 'Saves/Accounts'), { recursive: true });
  for (const file of ['Saves/.DS_Store', 'Saves/._Items.bin', 'Saves/Items.bin', 'Saves/Accounts/accounts.xml'])
    await writeFile(join(directory, file), 'x');
  await copyShardFiles(join(directory, 'Saves'), join(directory, 'seed/Saves'));
  expect((await readdir(join(directory, 'seed/Saves'))).sort()).toEqual(['Accounts', 'Items.bin']);
  expect(await readdir(join(directory, 'seed/Saves/Accounts'))).toEqual(['accounts.xml']);
});
