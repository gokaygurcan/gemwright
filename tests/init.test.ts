import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as prompts from '@clack/prompts';

import { upstreamConfig } from './servuo/config-fixture';
import { sphereFixture, sphereSettings } from './sphere/config-fixture';
import { servuoSource } from '../src/emulators/servuo/source';
import { defaultRules } from '../src/emulators/sphere/rules-prompts';
import { sphereSources } from '../src/emulators/sphere/source';
import { initialize } from '../src/init';

const loadConfig = async () => ({ ...upstreamConfig });
const source = { repository: servuoSource.repository, ref: 'pub57', revision: 'a'.repeat(40) };

const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const folders: string[] = [];
let note: ReturnType<typeof spyOn>;
beforeEach(() => {
  note = spyOn(prompts, 'note').mockImplementation(() => {});
});
afterEach(async () => {
  note.mockRestore();
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});
async function temporaryFolder() {
  const folder = await mkdtemp(join(tmpdir(), 'gemwright-cli-'));
  folders.push(folder);
  return folder;
}
async function run(args: string[], cwd: string) {
  const child = Bun.spawn([process.execPath, entry, ...args], { cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ]);
  return { stdout, stderr, code };
}

test('--yes uses defaults, writes ServUO config and initializes Git', async () => {
  const directory = await temporaryFolder();
  await initialize({ directory, yes: true }, async () => source, loadConfig);
  const config = JSON.parse(await readFile(join(directory, 'gemwright.json'), 'utf8'));
  expect(config.name).toBe('Gemwright');
  expect(config.adminEmail).toBe('gemwright@example.com');
  expect(config.url).toBe('www.example.com');
  expect(await readFile(join(directory, 'Config/General.cfg'), 'utf8')).toContain('SupportEmail=gemwright@example.com');
  expect(config.id).toBe('gemwright');
  expect(config.expansion).toBe('ej');
  expect(config.emulator).toBe('servuo');
  expect(config.source).toEqual(source);
  expect(await readFile(join(directory, 'Config/Server.cfg'), 'utf8')).toContain('Name=Gemwright');
  expect(await readFile(join(directory, 'Config/Expansion.cfg'), 'utf8')).toContain('CurrentExpansion=EJ');
  expect(await readFile(join(directory, 'Config/AutoSave.cfg'), 'utf8')).toBe(upstreamConfig['Config/AutoSave.cfg']);
  const accounts = await readFile(join(directory, 'Saves/Accounts/accounts.xml'), 'utf8');
  expect(accounts).toContain('<accessLevel>Owner</accessLevel>');
  expect(accounts).not.toContain('<password>');
  expect((await stat(join(directory, 'Saves/Accounts/accounts.xml'))).mode & 0o777).toBe(0o600);
  if (Bun.which('git')) expect((await stat(join(directory, '.git'))).isDirectory()).toBe(true);
  expect((await run(['init', '--yes'], directory)).stderr).toContain('Refusing to overwrite');
});

test('flags override defaults and invalid input leaves the target untouched', async () => {
  const directory = await temporaryFolder();
  const target = join(directory, 'shard');
  const invalid = await run(['init', target, '--yes', '--timezone', 'UTC'], directory);
  expect(invalid.code).toBe(1);
  expect(invalid.stderr).toContain('Unsupported timezone');
  expect(await Bun.file(join(target, 'gemwright.json')).exists()).toBe(false);
  await initialize(
    { directory: target, yes: true, name: "British's Realm", timezone: 'Europe/London', expansion: 'uor' },
    async () => source,
    loadConfig
  );
  expect(JSON.parse(await readFile(join(target, 'gemwright.json'), 'utf8'))).toEqual({
    adminEmail: 'gemwright@example.com',
    url: 'www.example.com',
    name: "British's Realm",
    id: 'britishs-realm',
    timezone: 'Europe/London',
    expansion: 'uor',
    emulator: 'servuo',
    source,
    servuo: {
      owner: 'admin',
      autoCreateAccounts: true,
      accountsPerIp: 1,
      globalChat: true,
      allowedClients: ['AllowRegular', 'AllowUOTD', 'AllowGod', 'AllowEC']
    }
  });
});

test('non-interactive invocation requests --yes without writing config', async () => {
  const directory = await temporaryFolder();
  const result = await run(['init'], directory);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('Use --yes');
  expect(await Bun.file(join(directory, 'gemwright.json')).exists()).toBe(false);
});

test('initialization resolves a fresh revision per shard and leaves no files on lookup failure', async () => {
  const directory = await temporaryFolder();
  const first = join(directory, 'first');
  const second = join(directory, 'second');
  await initialize({ directory: first, yes: true }, async () => source, loadConfig);
  await initialize({ directory: second, yes: true }, async () => ({ ...source, revision: 'b'.repeat(40) }), loadConfig);
  expect(JSON.parse(await readFile(join(first, 'gemwright.json'), 'utf8')).source.revision).toBe('a'.repeat(40));
  expect(JSON.parse(await readFile(join(second, 'gemwright.json'), 'utf8')).source.revision).toBe('b'.repeat(40));
  const failed = join(directory, 'failed');
  await expect(
    initialize({ directory: failed, yes: true }, async () => {
      throw new Error('offline');
    })
  ).rejects.toThrow('offline');
  await expect(stat(failed)).rejects.toThrow();
});

test('Sphere initialization records both sources and writes config, binary scripts and a private owner seed', async () => {
  const directory = await temporaryFolder();
  const pair = { server: { ...sphereSources.server, revision: 'c'.repeat(40) }, scripts: sphereSettings.scriptsSource };
  await initialize(
    { directory, emulator: 'sphere', yes: true },
    async () => {
      throw new Error('Unexpected ServUO lookup');
    },
    loadConfig,
    async () => pair,
    async () => sphereFixture()
  );
  const config = JSON.parse(await readFile(join(directory, 'gemwright.json'), 'utf8'));
  expect(config.emulator).toBe('sphere');
  expect(config.source).toEqual(pair.server);
  expect(config.sphere).toEqual({ ...sphereSettings, rules: defaultRules(String(sphereFixture()['sphere.ini'])) });
  expect(config.adminEmail).toBe('gemwright@example.com');
  expect(config.url).toBe('www.example.com');
  expect(await readFile(join(directory, 'sphere.ini'), 'utf8')).toContain('URL=www.example.com');
  expect(config.servuo).toBeUndefined();
  expect(await readFile(join(directory, 'sphere.ini'), 'utf8')).toContain('ServName=Gemwright');
  expect(await readFile(join(directory, 'scripts/adddialog.db'))).toEqual(Buffer.from([0, 0xff, 0x80, 0x42]));
  const seed = await readFile(join(directory, 'accounts/sphereaccu.scp'), 'utf8');
  expect(seed).toContain('PLEVEL=Owner');
  expect(seed).toMatch(/MD5PASSWORD=[a-f0-9]{32}/);
  expect((await stat(join(directory, 'accounts/sphereaccu.scp'))).mode & 0o777).toBe(0o600);
  expect(note).toHaveBeenCalledTimes(1);
  const credential = String(note.mock.calls[0]![0]);
  const password = /Password: ([^\n]+)/.exec(credential)![1]!;
  expect(password.length).toBe(16);
  expect(seed).not.toContain(password);
  expect(JSON.stringify(config)).not.toContain(password);
  expect((await run(['init', '--emulator', 'sphere', '--yes'], directory)).stderr).toContain('Refusing to overwrite');
});

test('Sphere source or preparation failures leave the target untouched', async () => {
  const directory = await temporaryFolder();
  const pair = { server: { ...sphereSources.server, revision: 'c'.repeat(40) }, scripts: sphereSettings.scriptsSource };
  for (const stage of ['lookup', 'files', 'layout']) {
    const target = join(directory, stage);
    await expect(
      initialize(
        { directory: target, emulator: 'sphere', yes: true },
        async () => source,
        loadConfig,
        async () => {
          if (stage === 'lookup') throw new Error('offline');
          return pair;
        },
        async () => {
          if (stage === 'files') throw new Error('download failed');
          return {};
        }
      )
    ).rejects.toThrow();
    await expect(stat(target)).rejects.toThrow();
  }
});

test('--client is only accepted by deploy and requires game files', async () => {
  const directory = await temporaryFolder();
  const init = await run(['init', '--client'], directory);
  expect(init.code).toBe(1);
  expect(init.stderr).toContain('only supported by deploy');
  await initialize({ directory, yes: true }, async () => source, loadConfig);
  const deploy = await run(['deploy', '--client'], directory);
  expect(deploy.code).toBe(1);
  expect(deploy.stderr).toContain('requires --files');
});
