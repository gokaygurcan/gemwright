import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { packageWorldFiles } from '../src/world-files';

test('packages the world files the AI reads, with no town guide', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gemwright-world-test-'));
  const staged = join(directory, 'staged');
  await mkdir(join(staged, 'Spawns'), { recursive: true });
  await mkdir(join(staged, 'Decoration'));
  await mkdir(join(directory, '.gemwright'));
  await writeFile(join(staged, 'Spawns/world.xml'), '<Spawns/>');
  await writeFile(join(staged, 'Decoration/world.cfg'), 'Forge 0xFB1\n1 2 0\n');
  await writeFile(join(staged, 'Regions.xml'), '<ServerRegions/>');
  await writeFile(join(staged, 'teleporters.csv'), '');
  expect((await packageWorldFiles(directory, staged)).files).toBe(4);
});
