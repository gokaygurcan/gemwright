import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { command } from '@gemwright/deployment/process';
import { createConfig } from '@gemwright/server/config';

import {
  builtImages,
  builtServices,
  bundleInstructions,
  composeServices,
  dockerPlatform,
  validateVpsOptions,
  writeVpsBundle
} from '../src/vps-deploy';
import { createVpsUpload, extractUpload, inspectVpsDestination } from '../src/vps-remote';

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'gemwright-vps-'));
  folders.push(directory);
  const staged = join(directory, 'staged');
  await mkdir(staged);
  await writeFile(join(staged, 'Dockerfile'), 'FROM scratch\n');
  return { directory, staged };
}

test('VPS options reject endpoint injection and require a DNS hostname for HTTPS', () => {
  for (const publicHost of ['', 'https://example.com', 'host;id', 'host\nfoo', '::1', '-host'])
    expect(() => validateVpsOptions({ publicHost })).toThrow();
  for (const domain of [undefined, '127.0.0.1', 'https://example.com', 'foo.com {', 'localhost'])
    expect(() => validateVpsOptions({ publicHost: '203.0.113.1', client: true, domain })).toThrow();
  expect(() => validateVpsOptions({ publicHost: '203.0.113.1' })).not.toThrow();
  expect(() =>
    validateVpsOptions({ publicHost: 'login.example.com', client: true, domain: 'play.example.com' })
  ).not.toThrow();
});

test('rebuilding a VPS bundle preserves the live world', async () => {
  const { directory, staged } = await fixture();
  const config = createConfig({ client: { version: '7.0.45.1' }, name: 'VPS test' });
  const options = { publicHost: '203.0.113.1' };
  const root = await writeVpsBundle(directory, config, options, staged);
  await mkdir(join(root, 'data/server/Saves'), { recursive: true });
  await writeFile(join(root, 'data/.client-ready'), '');
  await writeFile(join(root, 'data/server/Saves/world.bin'), 'live world');
  await writeFile(join(staged, 'Dockerfile'), 'FROM ubuntu:24.04\n');
  await writeVpsBundle(directory, config, options, staged);
  expect(await readFile(join(root, 'data/server/Saves/world.bin'), 'utf8')).toBe('live world');
  expect(await readFile(join(root, 'shard/Dockerfile'), 'utf8')).toContain('ubuntu');
  const compose = JSON.parse(await readFile(join(root, 'compose.json'), 'utf8'));
  expect(compose.services.server.environment.GEMWRIGHT_PUBLIC_HOST).toBe('203.0.113.1');
  expect(compose.services.server.volumes).toEqual(['./data:/app/data', './gamefiles:/app/data/client:ro']);
  expect(compose.services.server.stop_grace_period).toBe('2m');
  expect(compose.services.server.healthcheck.test).toEqual(['CMD', 'bash', '-c', 'exec 3<>/dev/tcp/127.0.0.1/2593']);
  expect(bundleInstructions(options)).toContain('--wait-timeout 900');
  await expect(writeVpsBundle(directory, { ...config, emulator: 'sphere' }, options, staged)).rejects.toThrow(
    'another emulator'
  );
});

test('an SSH upload carries the bundle without the workstation world', async () => {
  const { directory, staged } = await fixture();
  const root = await writeVpsBundle(
    directory,
    createConfig({ client: { version: '7.0.45.1' } }),
    { publicHost: '203.0.113.1' },
    staged
  );
  await writeFile(join(root, 'data/world.bin'), 'workstation world');
  const archive = await createVpsUpload(root, directory, ['shard', 'state.json'], '.incoming-test');
  const entries = (await command(['tar', '-tzf', archive], directory)).split('\n');
  expect(entries).toContain('state.json');
  expect(entries.some((entry) => entry.startsWith('data/'))).toBe(false);
  expect((await stat(archive)).mode & 0o777).toBe(0o600);
  await expect(createVpsUpload(root, directory, ['shard', 'missing'], '.incoming-failed')).rejects.toThrow();
  expect(await Bun.file(join(root, '.incoming-failed.tar.gz')).exists()).toBe(false);
  expect(await readFile(join(root, 'data/world.bin'), 'utf8')).toBe('workstation world');
});

test('interrupted first uploads can resume while unrelated destination contents are refused', async () => {
  const { directory } = await fixture();
  const destination = join(directory, 'remote');
  const remote = (script: string) => command(['sh', '-c', script], directory);
  expect(await inspectVpsDestination(destination, remote)).toBe('');
  await mkdir(join(destination, '.incoming-interrupted'), { recursive: true });
  const state = { emulator: 'servuo', clientDigest: 'fixture-digest', client: false };
  await writeFile(join(destination, '.provisioning.json'), JSON.stringify(state));
  expect(JSON.parse(await inspectVpsDestination(destination, remote))).toEqual(state);
  await writeFile(join(destination, 'state.json'), JSON.stringify({ ...state, client: true }));
  expect(JSON.parse(await inspectVpsDestination(destination, remote)).client).toBe(true);
  await rm(join(destination, 'state.json'));
  await rm(join(destination, '.provisioning.json'));
  await writeFile(join(destination, 'unrelated.txt'), 'existing user file');
  await expect(inspectVpsDestination(destination, remote)).rejects.toThrow('not an empty');
  expect(await readFile(join(destination, 'unrelated.txt'), 'utf8')).toBe('existing user file');
});

test('MySQL credentials persist across deployments and its port stays private', async () => {
  const { directory, staged } = await fixture();
  const config = { ...createConfig({ client: { version: '7.0.45.1' } }), sphere: { mysql: true } } as ReturnType<
    typeof createConfig
  >;
  const options = { publicHost: '203.0.113.1' };
  const root = await writeVpsBundle(directory, config, options, staged);
  const secrets = await readFile(join(root, '.env'), 'utf8');
  expect(secrets).toMatch(/MYSQL_PASSWORD=[a-f0-9]{64}/);
  expect((await stat(join(root, '.env'))).mode & 0o777).toBe(0o600);
  await writeVpsBundle(directory, config, options, staged);
  expect(await readFile(join(root, '.env'), 'utf8')).toBe(secrets);
  const compose = JSON.parse(await readFile(join(root, 'compose.json'), 'utf8'));
  expect(compose.services.mysql.ports).toBeUndefined();
  expect(compose.services.server.depends_on.mysql.condition).toBe('service_healthy');
});

test('web deployment publishes only manifested assets and keeps relay ports private', async () => {
  const { directory, staged } = await fixture();
  const assets = join(directory, 'assets');
  await mkdir(assets);
  await writeFile(join(assets, 'tiledata.mul'), 'map fixture');
  await writeFile(join(assets, 'client.exe'), 'private executable');
  const config = createConfig({ client: { version: '7.0.45.1' }, name: 'Test $shard' });
  const options = { publicHost: '203.0.113.1', client: true, domain: 'play.example.com' };
  const root = await writeVpsBundle(directory, config, options, staged, assets);
  const compose = JSON.parse(await readFile(join(root, 'compose.json'), 'utf8'));
  expect(compose.services.client.ports).toBeUndefined();
  expect(compose.services.client.environment.UO_HOST).toBe('server');
  expect(compose.services.client.environment.SERVER_NAME).toBe('Test $$shard');
  expect(compose.services.client.environment.PUBLIC_ORIGIN).toBe('https://play.example.com');
  expect(compose.services.caddy.ports).toContain('443:443/tcp');
  expect(await Bun.file(join(root, 'gamefiles/client.exe')).exists()).toBe(false);
  expect(await readFile(join(root, 'Caddyfile'), 'utf8')).toContain('reverse_proxy client:3000');
  await writeVpsBundle(directory, config, { publicHost: options.publicHost }, staged);
  const kept = JSON.parse(await readFile(join(root, 'compose.json'), 'utf8'));
  expect(kept.services.client.environment.PUBLIC_ORIGIN).toBe('https://play.example.com');
  expect(kept.services.caddy).toBeDefined();
  await writeFile(join(assets, 'tiledata.mul'), 'different map fixture');
  await writeVpsBundle(directory, config, options, staged, assets);
  expect(await readFile(join(root, 'gamefiles/tiledata.mul'), 'utf8')).toBe('different map fixture');
});

test('only a manual bundle prints manual installation steps', () => {
  expect(bundleInstructions({ publicHost: '203.0.113.1' })).toContain('docker compose');
  expect(bundleInstructions({ publicHost: '203.0.113.1', ssh: 'my-vps' })).toBeUndefined();
});

test('extracting an upload on the server skips AppleDouble entries', async () => {
  const { directory } = await fixture();
  const source = join(directory, 'source');
  await mkdir(join(source, 'shard'), { recursive: true });
  await writeFile(join(source, 'shard/Map.cs'), 'class Map {}');
  await writeFile(join(source, 'shard/._Map.cs'), 'Mac OS X metadata');
  await command(['tar', '-czf', join(directory, 'bundle.tar.gz'), '-C', source, 'shard'], directory);
  const target = join(directory, 'incoming');
  await mkdir(target);
  await command(['sh', '-c', extractUpload(join(directory, 'bundle.tar.gz'), target)], directory);
  expect(await Bun.file(join(target, 'shard/Map.cs')).exists()).toBe(true);
  expect(await Bun.file(join(target, 'shard/._Map.cs')).exists()).toBe(false);
});

test('each deployment restarts only the services it names', async () => {
  const { directory, staged } = await fixture();
  const config = createConfig({ client: { version: '7.0.45.1' } });
  const options = { publicHost: '203.0.113.1' };
  await expect(
    writeVpsBundle(directory, config, { ...options, server: false, client: true, domain: 'play.example.com' })
  ).rejects.toThrow('Deploy the server');
  await writeVpsBundle(directory, config, options, staged);
  expect(composeServices(options, config)).toEqual(['server']);
  expect(composeServices({ ...options, server: false, client: true }, config)).toEqual(['client', 'caddy']);
  const sphere = { ...config, sphere: { mysql: true } } as typeof config;
  expect(composeServices({ ...options, client: true }, sphere)).toEqual(['server', 'mysql', 'client', 'caddy']);
});

test('AI residents join a Docker VPS bundle only beside an AI-patched server', async () => {
  const { directory, staged } = await fixture();
  const config = createConfig({ client: { version: '7.0.45.1' } });
  const world = join(directory, 'world-staged');
  await mkdir(join(world, 'Spawns'), { recursive: true });
  await mkdir(join(world, 'Decoration'), { recursive: true });
  for (const file of ['Spawns/world.xml', 'Decoration/town.cfg', 'Regions.xml', 'teleporters.csv'])
    await writeFile(join(world, file), '');
  const options = { publicHost: '203.0.113.1' };
  await expect(writeVpsBundle(directory, config, { ...options, ai: true }, staged, undefined, world)).rejects.toThrow(
    'AI patch'
  );
  const root = await writeVpsBundle(
    directory,
    config,
    { ...options, ai: true, aiPatched: true },
    staged,
    undefined,
    world
  );
  const compose = JSON.parse(await readFile(join(root, 'compose.json'), 'utf8'));
  expect(compose.services.ai.environment.UO_HOST).toBe('server');
  expect(compose.services.ai.volumes).toContain('./world:/app/data/world:ro');
  expect(compose.services.server.environment).toMatchObject({
    GEMWRIGHT_AI_PATCHED: '1',
    GEMWRIGHT_TRUSTED_HOSTS: 'ai'
  });
  expect((await stat(join(root, 'ai.env'))).mode & 0o777).toBe(0o600);
  expect(await readFile(join(root, 'world/Regions.xml'), 'utf8')).toBe('');
  expect(composeServices({ ...options, server: false, ai: true }, config)).toEqual(['ai']);
  // A later server-only deploy keeps the residents and their trust.
  await writeVpsBundle(directory, config, { ...options, aiPatched: true }, staged);
  expect(JSON.parse(await readFile(join(root, 'compose.json'), 'utf8')).services.ai).toBeDefined();
});

test('images are built for the VPS architecture and only the built services are shipped', () => {
  expect(dockerPlatform('x86_64')).toBe('linux/amd64');
  expect(dockerPlatform('aarch64')).toBe('linux/arm64');
  expect(() => dockerPlatform('riscv64')).toThrow('riscv64');
  const config = { ...createConfig({ client: { version: '7.0.45.1' } }), sphere: { mysql: true } } as ReturnType<
    typeof createConfig
  >;
  expect(builtServices(['server', 'mysql', 'client', 'caddy', 'ai'])).toEqual(['server', 'client', 'ai']);
  expect(builtImages(config, ['server', 'ai'])).toEqual(['gemwright-gemwright-server', 'gemwright-gemwright-ai']);
});
