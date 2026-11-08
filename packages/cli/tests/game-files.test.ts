import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { syncGameFiles } from '../src/vps-deploy';
import { gameFilesChanges } from '../src/vps-remote';

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test('one game-file folder holds the selected set, copying only what changed and removing what left', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gemwright-game-files-'));
  folders.push(directory);
  const source = join(directory, 'files');
  const root = join(directory, 'root');
  await mkdir(source);
  for (const [name, text] of [
    ['map0.mul', 'map'],
    ['tiledata.mul', 'tiles'],
    ['art.mul', 'art'],
    ['client.exe', 'program']
  ] as const)
    await writeFile(join(source, name), text);
  const server = /^(?:map0\.mul|tiledata\.mul)$/i;
  expect((await syncGameFiles(root, source, server)).copied).toEqual(['map0.mul', 'tiledata.mul']);
  expect((await readdir(join(root, 'gamefiles'))).sort()).toEqual(['manifest.json', 'map0.mul', 'tiledata.mul']);
  await writeFile(join(source, 'tiledata.mul'), 'new tiles');
  expect((await syncGameFiles(root, source, server)).copied).toEqual(['tiledata.mul']);
  expect((await syncGameFiles(root, source)).copied).toEqual(['art.mul']);
  expect((await readdir(join(root, 'gamefiles'))).sort()).toEqual([
    'art.mul',
    'manifest.json',
    'map0.mul',
    'tiledata.mul'
  ]);
  const narrowed = await syncGameFiles(root, source, /^map0\.mul$/i);
  expect(narrowed.removed.sort()).toEqual(['art.mul', 'tiledata.mul']);
  expect((await readdir(join(root, 'gamefiles'))).sort()).toEqual(['manifest.json', 'map0.mul']);
  expect(
    JSON.parse(await readFile(join(root, 'gamefiles/manifest.json'), 'utf8')).files.map((f: { path: string }) => f.path)
  ).toEqual(['map0.mul']);
});

test('only game files the VPS lacks or holds in another version are sent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gemwright-game-files-'));
  folders.push(root);
  await mkdir(join(root, 'gamefiles'));
  const file = (path: string, sha256: string) => ({ path, bytes: 1, sha256 });
  const local = [file('map0.mul', 'a'), file('tiledata.mul', 'b')];
  await writeFile(join(root, 'gamefiles/manifest.json'), JSON.stringify({ files: local }));
  const remote = (files: ReturnType<typeof file>[]) => JSON.stringify({ files });
  expect(await gameFilesChanges(root, '')).toEqual({
    send: ['gamefiles/manifest.json', 'gamefiles/map0.mul', 'gamefiles/tiledata.mul'],
    stale: []
  });
  expect(
    await gameFilesChanges(root, remote([file('map0.mul', 'a'), file('tiledata.mul', 'old'), file('art.mul', 'c')]))
  ).toEqual({
    send: ['gamefiles/manifest.json', 'gamefiles/tiledata.mul'],
    stale: ['art.mul']
  });
  expect(await gameFilesChanges(join(root, 'missing'), '')).toEqual({ send: [], stale: [] });
});
