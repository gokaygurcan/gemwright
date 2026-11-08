import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { packageClientFiles } from '../src/client-files';
import { createArchive } from '../src/process';

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

// macOS tar hides AppleDouble entries when listing or extracting, so the archive's own bytes are read.
test('game-file archives carry no macOS AppleDouble entries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gemwright-archive-'));
  folders.push(directory);
  await mkdir(join(directory, '.gemwright'));
  await mkdir(join(directory, 'files'));
  await writeFile(join(directory, 'files/tiledata.mul'), 'tile data');
  const { archive } = await packageClientFiles(directory, join(directory, 'files'), /\.mul$/, () => {});
  const bytes = Buffer.from(Bun.gunzipSync(await readFile(archive)));
  expect(bytes.includes('tiledata.mul')).toBe(true);
  expect(bytes.includes('._tiledata.mul')).toBe(false);
});

test('archives skip Finder and AppleDouble files already on disk', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gemwright-archive-'));
  folders.push(directory);
  await mkdir(join(directory, 'Saves'));
  for (const file of ['.DS_Store', '._Items.bin', 'Items.bin']) await writeFile(join(directory, 'Saves', file), 'x');
  const archive = join(directory, 'saves.tar.gz');
  await createArchive(archive, directory, ['Saves'], directory);
  const bytes = Buffer.from(Bun.gunzipSync(await readFile(archive)));
  expect(bytes.includes('Saves/Items.bin')).toBe(true);
  expect(bytes.includes('.DS_Store')).toBe(false);
  expect(bytes.includes('._Items.bin')).toBe(false);
});
