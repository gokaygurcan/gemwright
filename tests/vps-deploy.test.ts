import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createConfig } from '../src/config';
import { command } from '../src/process';
import { validateVpsOptions, writeVpsBundle } from '../src/vps-deploy';
import { nativePackages, shellQuote } from '../src/vps-native';
import { createVpsUpload, inspectVpsDestination } from '../src/vps-remote';

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
  const archive = join(directory, 'client.tar.gz');
  await writeFile(archive, 'client fixture');
  return { directory, staged, client: { archive, digest: 'fixture-digest' } };
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

test('rebuilding a VPS bundle preserves the live world and consumed client archive', async () => {
  const { directory, staged, client } = await fixture();
  const config = createConfig({ name: 'VPS test' });
  const options = { publicHost: '203.0.113.1' };
  const root = await writeVpsBundle(directory, config, options, staged, client);
  expect(await readFile(join(root, 'data/client.tar.gz'), 'utf8')).toBe('client fixture');
  await rm(join(root, 'data/client.tar.gz'));
  await mkdir(join(root, 'data/server/Saves'), { recursive: true });
  await writeFile(join(root, 'data/.client-ready'), '');
  await writeFile(join(root, 'data/server/Saves/world.bin'), 'live world');
  await writeFile(join(staged, 'Dockerfile'), 'FROM ubuntu:24.04\n');
  await writeVpsBundle(directory, config, options, staged, client);
  expect(await readFile(join(root, 'data/server/Saves/world.bin'), 'utf8')).toBe('live world');
  expect(await Bun.file(join(root, 'data/client.tar.gz')).exists()).toBe(false);
  expect(await readFile(join(root, 'shard/Dockerfile'), 'utf8')).toContain('ubuntu');
  const compose = JSON.parse(await readFile(join(root, 'compose.json'), 'utf8'));
  expect(compose.services.shard.environment.GEMWRIGHT_PUBLIC_HOST).toBe('203.0.113.1');
  expect(compose.services.shard.volumes).toEqual(['./data:/app/data']);
  expect(compose.services.shard.stop_grace_period).toBe('2m');
  await expect(writeVpsBundle(directory, config, options, staged, { ...client, digest: 'different' })).rejects.toThrow(
    'Different client'
  );
  await expect(writeVpsBundle(directory, { ...config, emulator: 'sphere' }, options, staged, client)).rejects.toThrow(
    'another emulator'
  );
});

test('a fresh SSH destination receives cached client data without copying the workstation world', async () => {
  const { directory, staged, client } = await fixture();
  const root = await writeVpsBundle(directory, createConfig({}), { publicHost: '203.0.113.1' }, staged, client);
  await rm(join(root, 'data/client.tar.gz'));
  await writeFile(join(root, 'data/.client-ready'), '');
  await writeFile(join(root, 'data/world.bin'), 'workstation world');
  await writeFile(join(directory, '.gemwright', `client-${client.digest}.tar.gz`), 'cached client data');
  const archive = await createVpsUpload(root, directory, ['shard', 'state.json'], '.incoming-test', client.digest);
  const entries = (await command(['tar', '-tzf', archive], directory)).split('\n');
  expect(entries).toContain('client-import/client.tar.gz');
  expect(entries.some((entry) => entry.startsWith('data/'))).toBe(false);
  expect((await stat(archive)).mode & 0o777).toBe(0o600);
  expect(await Bun.file(join(root, 'client-import/client.tar.gz')).exists()).toBe(false);
  await expect(createVpsUpload(root, directory, ['shard'], '.incoming-failed', 'missing')).rejects.toThrow();
  expect(await Bun.file(join(root, '.incoming-failed.tar.gz')).exists()).toBe(false);
  expect(await readFile(join(root, 'data/world.bin'), 'utf8')).toBe('workstation world');
});

test('interrupted first uploads can resume while unrelated destination contents are refused', async () => {
  const { directory } = await fixture();
  const destination = join(directory, 'remote');
  const remote = (script: string) => command(['sh', '-c', script], directory);
  expect(await inspectVpsDestination(destination, remote)).toBe('');
  await mkdir(join(destination, '.incoming-interrupted'), { recursive: true });
  const state = { emulator: 'servuo', clientDigest: 'fixture-digest', method: 'native', client: false };
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
  const { directory, staged, client } = await fixture();
  const config = { ...createConfig({}), sphere: { mysql: true } } as ReturnType<typeof createConfig>;
  const options = { publicHost: '203.0.113.1' };
  const root = await writeVpsBundle(directory, config, options, staged, client);
  const secrets = await readFile(join(root, '.env'), 'utf8');
  expect(secrets).toMatch(/MYSQL_PASSWORD=[a-f0-9]{64}/);
  expect((await stat(join(root, '.env'))).mode & 0o777).toBe(0o600);
  await writeVpsBundle(directory, config, options, staged, client);
  expect(await readFile(join(root, '.env'), 'utf8')).toBe(secrets);
  const compose = JSON.parse(await readFile(join(root, 'compose.json'), 'utf8'));
  expect(compose.services.mysql.ports).toBeUndefined();
  expect(compose.services.shard.depends_on.mysql.condition).toBe('service_healthy');
  expect(nativePackages(config)).toContain('mysql-server');
  expect(nativePackages(config)).not.toContain('mariadb-server');
});

test('web deployment publishes only manifested assets and keeps relay ports private', async () => {
  const { directory, staged, client } = await fixture();
  const assets = join(directory, 'assets');
  await mkdir(assets);
  await writeFile(join(assets, 'tiledata.mul'), 'map fixture');
  await writeFile(join(assets, 'client.exe'), 'private executable');
  const config = createConfig({ name: 'Test $shard' });
  const options = { publicHost: '203.0.113.1', client: true, domain: 'play.example.com' };
  const root = await writeVpsBundle(directory, config, options, staged, client, assets);
  const compose = JSON.parse(await readFile(join(root, 'compose.json'), 'utf8'));
  expect(compose.services.web.ports).toBeUndefined();
  expect(compose.services.web.environment.UO_HOST).toBe('shard');
  expect(compose.services.web.environment.SERVER_NAME).toBe('Test $$shard');
  expect(compose.services.web.environment.PUBLIC_ORIGIN).toBe('https://play.example.com');
  expect(compose.services.caddy.ports).toContain('443:443/tcp');
  expect(await Bun.file(join(root, 'gamefiles/client.exe')).exists()).toBe(false);
  expect(await readFile(join(root, 'Caddyfile'), 'utf8')).toContain('reverse_proxy web:3000');
  await expect(writeVpsBundle(directory, config, { publicHost: options.publicHost }, staged, client)).rejects.toThrow(
    'Repeat --client'
  );
  await writeFile(join(assets, 'tiledata.mul'), 'different map fixture');
  await expect(writeVpsBundle(directory, config, options, staged, client, assets)).rejects.toThrow(
    'different game files'
  );
  expect(await readFile(join(root, 'gamefiles/tiledata.mul'), 'utf8')).toBe('map fixture');
});

test('native bundle uses systemd wrappers and a loopback web relay without Docker configuration', async () => {
  const { directory, staged, client } = await fixture();
  const assets = join(directory, 'assets');
  await mkdir(assets);
  await writeFile(join(assets, 'tiledata.mul'), 'map fixture');
  const config = createConfig({ name: "Owner's shard" });
  const root = await writeVpsBundle(
    directory,
    config,
    {
      method: 'native',
      publicHost: '203.0.113.1',
      client: true,
      domain: 'play.example.com'
    },
    staged,
    client,
    assets
  );
  expect(await Bun.file(join(root, 'compose.json')).exists()).toBe(false);
  expect(await readFile(join(root, 'Caddyfile'), 'utf8')).toContain('reverse_proxy 127.0.0.1:3000');
  expect(await readFile(join(root, 'start-web.sh'), 'utf8')).toContain('CLIENT_LISTEN_HOST=127.0.0.1');
  const env = await readFile(join(root, 'native.env'), 'utf8');
  expect(env).toContain(`SERVER_NAME=${shellQuote("Owner's shard")}`);
  expect((await stat(join(root, 'native.env'))).mode & 0o777).toBe(0o600);
  const install = await readFile(join(root, 'install-native.sh'), 'utf8');
  expect(install).toContain('KillMode=mixed');
  expect(install).toContain('TimeoutStopSec=120');
  for (const emulator of ['servuo', 'sphere', 'sphere-x', 'runuo', 'modernuo'] as const)
    expect(nativePackages({ ...config, emulator }).length).toBeGreaterThan(2);
});
