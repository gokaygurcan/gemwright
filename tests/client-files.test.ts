import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createManifest } from '../src/client-files';

test('reads an external game directory without modifying it and excludes unrelated files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gemwright-manifest-'));
  try {
    await expect(createManifest(directory)).rejects.toThrow('No game files');
    await mkdir(join(directory, 'music'));
    await writeFile(join(directory, 'music/Stones.mp3'), 'abc');
    await writeFile(join(directory, '.env'), 'private');
    await writeFile(join(directory, 'client.exe'), 'executable');
    await writeFile(join(directory, 'cliloc.enu'), 'abc');
    const original = await readdir(directory);
    const files = await createManifest(directory);
    expect(files).toEqual([
      { path: 'cliloc.enu', bytes: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' },
      { path: 'music/Stones.mp3', bytes: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' }
    ]);
    expect(await readdir(directory)).toEqual(original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('manifest generation rejects symlinks and paths the browser cannot load', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gemwright-manifest-paths-'));
  try {
    await writeFile(join(directory, 'invalid#name.mul'), 'data');
    await expect(createManifest(directory)).rejects.toThrow('invalid');
    await rm(join(directory, 'invalid#name.mul'));
    await writeFile(join(directory, 'art.mul'), 'data');
    await symlink(join(directory, 'art.mul'), join(directory, 'linked.mul'));
    await expect(createManifest(directory)).rejects.toThrow('symlinks');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
