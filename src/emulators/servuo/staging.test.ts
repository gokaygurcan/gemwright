import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test('client packaging excludes unrelated files and duplicate x variants', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { packageClientFiles } = await import('./staging');
  const { command } = await import('../../process');
  const directory = await mkdtemp(join(tmpdir(), 'gemwright-client-package-'));
  folders.push(directory);
  const source = join(directory, 'files');
  await mkdir(source);
  await mkdir(join(directory, '.gemwright'));
  for (const name of ['tiledata.mul', 'map0LegacyMUL.uop', 'map0xLegacyMUL.uop', 'artLegacyMUL.uop']) {
    await writeFile(join(source, name), 'test');
  }
  const packaged = await packageClientFiles(directory, source);
  expect(packaged.bytes).toBe(8);
  const names = await command(['tar', '-tzf', packaged.archive], directory);
  expect(names).toContain('tiledata.mul');
  expect(names).toContain('map0LegacyMUL.uop');
  expect(names).not.toContain('map0x');
  expect(names).not.toContain('artLegacy');
});
