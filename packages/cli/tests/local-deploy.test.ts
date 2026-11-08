import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createConfig } from '@gemwright/server/config';

import { composeProject } from '../src/compose';
import { installWorldFiles } from '../src/vps-deploy';

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test('the local project names its services after the parts and keeps data in named volumes', () => {
  const config = createConfig({ client: { version: '7.0.117.0' }, name: 'Local $test' });
  const compose = composeProject(config, {
    emulator: 'servuo',
    parts: ['server', 'client', 'ai'],
    aiPatched: true,
    serverPort: 2600,
    clientPort: 8080
  });
  const services = compose.services as Record<string, { ports?: string[]; environment: Record<string, string> }>;
  expect(Object.keys(services)).toEqual(['server', 'client', 'ai']);
  expect(Object.keys(compose.volumes)).toEqual(['server-data', 'ai-data']);
  expect(services.server?.ports).toEqual(['127.0.0.1:2600:2593/tcp']);
  expect(services.server?.environment).toMatchObject({
    GEMWRIGHT_PUBLIC_HOST: '127.0.0.1',
    GEMWRIGHT_PUBLIC_PORT: '2600',
    GEMWRIGHT_TRUSTED_HOSTS: 'ai'
  });
  expect(services.client?.ports).toEqual(['127.0.0.1:8080:3000/tcp']);
  expect(services.client?.environment).toMatchObject({
    UO_HOST: 'server',
    UO_PORT: '2593',
    SERVER_NAME: 'Local $$test'
  });
  expect(services.ai?.environment.UO_HOST).toBe('server');
  // AI waits for its world files (Spawns/, Regions.xml, teleporters) in /app/data/world.
  expect((services.ai as unknown as { volumes: string[] }).volumes).toContain('./world:/app/data/world:ro');
});

test('AI world files are staged in the deployment folder, checked and replaced whole', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gemwright-world-'));
  folders.push(directory);
  const staged = join(directory, 'staged');
  await mkdir(join(staged, 'Spawns'), { recursive: true });
  await mkdir(join(staged, 'Decoration/Britannia'), { recursive: true });
  await writeFile(join(staged, 'Spawns/world.xml'), '<spawners/>');
  await writeFile(join(staged, 'Decoration/Britannia/town.cfg'), '');
  await writeFile(join(staged, 'Regions.xml'), '<regions/>');
  await writeFile(join(staged, 'teleporters.csv'), '');
  await writeFile(join(staged, 'notes.txt'), 'not a world file');
  const root = join(directory, 'root');
  await mkdir(join(root, 'world'), { recursive: true });
  await writeFile(join(root, 'world/stale.xml'), 'old');
  expect(await installWorldFiles(root, staged)).toBe(4);
  expect((await readdir(join(root, 'world'))).sort()).toEqual([
    'Decoration',
    'Regions.xml',
    'Spawns',
    'teleporters.csv'
  ]);
  await rm(join(staged, 'Regions.xml'));
  await expect(installWorldFiles(root, staged)).rejects.toThrow('Regions.xml');
  expect(await readdir(join(root, 'world'))).toContain('Regions.xml');
});
