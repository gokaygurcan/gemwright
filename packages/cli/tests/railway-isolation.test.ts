import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deployAi } from '@gemwright/deployment/ai-deploy';
import { deployClient } from '@gemwright/deployment/client-deploy';
import * as processTools from '@gemwright/deployment/process';
import { createConfig, loadShard } from '@gemwright/server/config';

import { checkAi, counterpart, ensureService } from '../../deployment/src/service';
import { stageImage } from '../src/assets';

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture(external = false) {
  const dir = await mkdtemp(join(tmpdir(), 'gemwright-isolation-'));
  directories.push(dir);
  await mkdir(join(dir, '.gemwright'));
  await mkdir(join(dir, 'files'));
  for (const name of ['tiledata.mul', 'map1.mul', 'map0.mul']) await writeFile(join(dir, 'files', name), name);
  const config = createConfig({
    name: 'Shard',
    client: { version: '7.0.45.1' },
    railway: { project: 'project', environment: 'production', ...(external ? {} : { server: 'server' }) },
    ...(external ? { connection: { host: 'external.example.com', port: 2593, aiReady: true } } : {})
  });
  await writeFile(join(dir, 'gemwright.json'), JSON.stringify(config));
  return { dir, config };
}
function provider() {
  const calls: string[][] = [];
  const services = [
    { id: 'server', name: 'shard' },
    { id: 'other', name: 'unrelated-client' }
  ];
  const volumes: { id: string; serviceName: string; mountPath: string }[] = [];
  let trusted = false,
    failedRead = false,
    failedDeploy = false;
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    const command = args[0];
    if (command === 'service') return JSON.stringify(services);
    if (command === 'variable' && args[1] === 'list') {
      if (failedRead) throw new Error('Provider unavailable');
      return JSON.stringify({
        GEMWRIGHT_AI_PATCHED: '1',
        GEMWRIGHT_TRUSTED_HOSTS: trusted ? 'shard-ai.railway.internal' : ''
      });
    }
    if (command === 'add') {
      const name = args[args.indexOf('--service') + 1] ?? '';
      const service = { id: name, name };
      services.push(service);
      return JSON.stringify(service);
    }
    if (command === 'volume' && args.includes('files'))
      return args.includes('list')
        ? JSON.stringify({
            files: ['map0.mul', 'map1.mul', 'tiledata.mul'].map((name) => ({ name, size: name.length, type: 'file' }))
          })
        : '{}';
    if (command === 'volume' && args.includes('list')) return JSON.stringify({ volumes });
    if (command === 'volume' && args.includes('add')) {
      const name = args[args.indexOf('--service') + 1] ?? '';
      const volume = { id: `${name}-data`, serviceName: name, mountPath: '/app/data' };
      volumes.push(volume);
      return JSON.stringify(volume);
    }
    if (command === 'up') return JSON.stringify({ deploymentId: 'current' });
    if (command === 'deployment')
      return JSON.stringify([{ id: 'current', status: failedDeploy ? 'FAILED' : 'SUCCESS' }]);
    if (command === 'domain')
      return JSON.stringify(args[1] === 'list' ? { domains: [] } : { domain: 'https://play.example.com' });
    return '{}';
  };
  return {
    calls,
    services,
    volumes,
    run,
    trust: () => {
      trusted = true;
    },
    failRead: () => {
      failedRead = true;
    },
    failDeploy: () => {
      failedDeploy = true;
    }
  };
}
const mutations = (calls: string[][]) =>
  calls.filter(
    (args) =>
      ['add', 'up', 'restart', 'link'].includes(args[0] ?? '') ||
      (args[0] === 'variable' && args[1] === 'set') ||
      (args[0] === 'volume' && !args.includes('list'))
  );

test('AI prerequisite failures and failed variable reads stop before provisioning, staging or server writes', async () => {
  const { dir, config } = await fixture();
  const fake = provider();
  const run = async <T>(args: string[]) => JSON.parse(await fake.run(args)) as T;
  await expect(checkAi(dir, config, run)).rejects.toThrow('Server AI prerequisites');
  expect(mutations(fake.calls)).toHaveLength(0);
  fake.failRead();
  await expect(checkAi(dir, config, run)).rejects.toThrow('Provider unavailable');
  expect(mutations(fake.calls)).toHaveLength(0);
});

test('AI-only deployment and rerun preserve resource IDs and never mutate server or client', async () => {
  const { dir } = await fixture();
  const fake = provider();
  fake.trust();
  const originalCommand = processTools.command;
  const command = spyOn(processTools, 'command').mockImplementation(async (args) => {
    if (args[0] !== 'railway') return originalCommand(args, dir);
    return fake.run(args.slice(1));
  });
  try {
    const dependencies = { loadShard, stageImage };
    await deployAi(dependencies, dir, join(dir, 'files'));
    const original = JSON.parse(await readFile(join(dir, '.gemwright/ai.json'), 'utf8'));
    await deployAi(dependencies, dir, join(dir, 'files'));
    expect(JSON.parse(await readFile(join(dir, '.gemwright/ai.json'), 'utf8'))).toEqual(original);
    expect(fake.services).toHaveLength(3);
    expect(fake.volumes).toHaveLength(1);
    expect(fake.calls.filter((args) => args[0] === 'add')).toHaveLength(1);
    expect(fake.calls.filter((args) => args[0] === 'volume' && args.includes('upload'))).toHaveLength(1);
    expect(
      mutations(fake.calls)
        .filter((args) => args.includes('--service'))
        .every((args) => args[args.indexOf('--service') + 1] === 'shard-ai')
    ).toBe(true);
    fake.failDeploy();
    await expect(deployAi(dependencies, dir, join(dir, 'files'))).rejects.toThrow(
      'railway logs --project project --environment production --service shard-ai'
    );
    expect(fake.volumes).toHaveLength(1);
  } finally {
    command.mockRestore();
  }
});

test('external server needs no CLI-created server; client deployment changes only its own resources', async () => {
  const { dir, config } = await fixture(true);
  const fake = provider();
  const run = async <T>(args: string[]) => JSON.parse(await fake.run(args)) as T;
  expect((await checkAi(dir, config, run)).host).toBe('external.example.com');
  const original = processTools.command;
  const command = spyOn(processTools, 'command').mockImplementation(async (args, cwd) =>
    args[0] === 'railway' ? fake.run(args.slice(1)) : original(args, cwd)
  );
  const health = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(async () => Response.json({ ready: true }), { preconnect: globalThis.fetch.preconnect })
  );
  try {
    await deployClient({ loadShard, stageImage }, dir, join(dir, 'files'));
    await deployClient({ loadShard, stageImage }, dir, join(dir, 'files'));
    expect(fake.calls.some((args) => args.includes('UO_HOST=external.example.com'))).toBe(true);
    expect(
      mutations(fake.calls)
        .filter((args) => args.includes('--service'))
        .every((args) => args[args.indexOf('--service') + 1] === 'shard-web')
    ).toBe(true);
    expect(fake.calls.filter((args) => args[0] === 'domain' && args[1] !== 'list')).toHaveLength(1);
    expect(fake.volumes).toHaveLength(1);
    expect(await Bun.file(join(dir, '.gemwright/railway.json')).exists()).toBe(false);
  } finally {
    command.mockRestore();
    health.mockRestore();
  }
});

test('missing recorded services or volumes fail without replacing persistent resources', async () => {
  const { dir, config } = await fixture(true);
  const fake = provider();
  const run = async <T>(args: string[]) => JSON.parse(await fake.run(args)) as T;
  const target = await counterpart(dir, config, run);
  const path = join(dir, '.gemwright/ai.json');
  await writeFile(path, JSON.stringify({ service: 'missing', volume: 'residents' }));
  await expect(ensureService(path, 'shard-ai', target, run)).rejects.toThrow('recorded service is missing');
  await writeFile(path, JSON.stringify({ service: 'server', volume: 'missing-volume' }));
  await expect(ensureService(path, 'shard-ai', target, run)).rejects.toThrow('recorded persistent volume');
  expect(mutations(fake.calls)).toHaveLength(0);
});

test('AI-only pull and restore use the AI target without a server identity or volume', async () => {
  const { pull } = await import('@gemwright/deployment/pull');
  const { restore } = await import('@gemwright/deployment/restore');
  const { dir } = await fixture(true);
  await writeFile(
    join(dir, '.gemwright/ai.json'),
    JSON.stringify({ project: 'project', environment: 'production', service: 'shard-ai', volume: 'ai-data' })
  );
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'ssh' && args.at(-1)?.includes('VACUUM INTO'))
      return Buffer.from('SQLite format 3\0fixture').toString('base64');
    return '{}';
  };
  const provider = await import('@gemwright/deployment/providers/railway');
  const mock = spyOn(provider, 'railway').mockImplementation(run);
  const output = join(dir, 'pulled-ai');
  try {
    await pull({ ai: true, output }, dir);
    expect(await Bun.file(join(output, 'ai/residents.sqlite')).exists()).toBe(true);
    await restore({ loadShard }, { ai: true, yes: true, from: output }, dir, run);
    expect(calls.filter((args) => args[0] === 'restart')).toEqual([
      ['restart', '--project', 'project', '--environment', 'production', '--service', 'shard-ai', '--yes', '--json']
    ]);
    expect(calls.every((args) => !args.includes('server'))).toBe(true);
  } finally {
    mock.mockRestore();
  }
});
