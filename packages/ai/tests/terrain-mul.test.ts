import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Terrain } from '../src/terrain';

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

// Game files from before the UOP maps carry map1.mul; older sets have the 6144-wide Trammel.
test('terrain reads map1.mul when there is no map UOP, including the pre-expansion width', async () => {
  for (const width of [7168, 6144]) {
    const directory = await mkdtemp(join(tmpdir(), 'gemwright-terrain-'));
    folders.push(directory);
    await writeFile(join(directory, 'tiledata.mul'), '');
    await truncate(join(directory, 'tiledata.mul'), 3188736);
    await writeFile(join(directory, 'staidx1.mul'), '');
    await writeFile(join(directory, 'statics1.mul'), '');
    await writeFile(join(directory, 'map1.mul'), '');
    await truncate(join(directory, 'map1.mul'), ((width * 4096) / 64) * 196);
    expect(new Terrain(directory, 1).sharedBuffers().map.byteLength).toBe(((7168 * 4096) / 64) * 196);
  }
});
