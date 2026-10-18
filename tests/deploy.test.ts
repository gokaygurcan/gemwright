import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureRailway, type RailwayCommand } from '../src/deploy';

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test('provisioning resumes without duplicate resources and retries volume readiness', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gemwright-railway-'));
  folders.push(directory);
  const calls: string[][] = [];
  let volumeExists = false,
    renamed = false,
    proxyExists = false,
    renameAttempts = 0;
  const run: RailwayCommand = async <T>(args: string[]) => {
    calls.push(args);
    let value: unknown = {};
    if (args[0] === 'project') value = [];
    else if (args[0] === 'whoami') value = { workspaces: [{ id: 'workspace' }] };
    else if (args[0] === 'init') value = { id: 'project' };
    else if (args[0] === 'service') value = [];
    else if (args[0] === 'add') value = { id: 'service' };
    else if (args[0] === 'volume') {
      if (args.includes('list'))
        value = {
          volumes: volumeExists
            ? [{ id: 'volume', name: renamed ? 'data' : 'shard-volume', mountPath: '/app/data', serviceName: 'shard' }]
            : []
        };
      if (args.includes('add')) {
        volumeExists = true;
        value = { id: 'volume', name: 'shard-volume' };
      }
      if (args.includes('update')) {
        if (++renameAttempts < 3) throw new Error('Volume not found yet');
        renamed = true;
      }
    } else if (args[0] === 'tcp-proxy') {
      if (args[1] === 'list') value = { proxies: proxyExists ? [{ applicationPort: 2593 }] : [] };
      else proxyExists = true;
    }
    return value as T;
  };
  const pauses: number[] = [];
  const first = await ensureRailway(directory, 'shard', run, async (ms) => {
    pauses.push(ms);
  });
  const second = await ensureRailway(directory, 'shard', run, async () => {});
  expect(first.project).toBe('project');
  expect(second.service).toBe('service');
  expect(calls.filter((args) => args[0] === 'init')).toHaveLength(1);
  expect(calls.filter((args) => args[0] === 'add')).toHaveLength(1);
  expect(calls.filter((args) => args[0] === 'volume' && args.includes('add'))).toHaveLength(1);
  expect(calls.filter((args) => args[0] === 'tcp-proxy' && args[1] === 'create')).toHaveLength(1);
  expect(pauses).toEqual([3000, 3000]);
  expect(calls.filter((args) => args[0] === 'variable').every((args) => args.includes('--skip-deploys'))).toBe(true);
  const saved = JSON.parse(await readFile(join(directory, '.gemwright/railway.json'), 'utf8'));
  expect(saved).toMatchObject({ project: 'project', service: 'service', volume: 'volume' });
});

test('--client uses the server game files after deployment; server-only skips the web service', async () => {
  const { spyOn } = await import('bun:test');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { deploy } = await import('../src/deploy');
  const process = await import('../src/process');
  const web = await import('../src/client-deploy');
  const { deployments } = await import('../src/deploy');
  const directory = await mkdtemp(join(tmpdir(), 'gemwright-combined-'));
  folders.push(directory);
  await mkdir(join(directory, '.gemwright'));
  const assets = await mkdtemp(join(tmpdir(), 'gemwright-external-assets-'));
  folders.push(assets);
  await writeFile(join(assets, 'map0.mul'), 'map');
  await writeFile(
    join(directory, 'gemwright.json'),
    JSON.stringify({
      name: 'Gemwright',
      id: 'gemwright',
      timezone: 'Europe/London',
      expansion: 'ej',
      emulator: 'servuo',
      source: { repository: 'https://github.com/ServUO/ServUO.git', ref: 'pub57', revision: 'a'.repeat(40) }
    })
  );
  await writeFile(
    join(directory, '.gemwright/railway.json'),
    JSON.stringify({
      projectName: 'project',
      project: 'project',
      service: 'server',
      environment: 'production',
      volume: 'data'
    })
  );
  const calls: string[][] = [];
  const mocks = [
    spyOn(process, 'isAvailable').mockResolvedValue(true),
    spyOn(deployments.servuo, 'validate').mockResolvedValue(),
    spyOn(deployments.servuo, 'stage').mockResolvedValue(join(directory, 'context')),
    spyOn(deployments.servuo, 'packageFiles').mockResolvedValue({
      archive: 'files.tar.gz',
      digest: 'digest',
      bytes: 3
    }),
    spyOn(web, 'deployClient').mockResolvedValue('https://play.example.com'),
    spyOn(process, 'command').mockImplementation(async (args) => {
      calls.push(args);
      if (args[1] === 'volume' && args.includes('files')) return JSON.stringify({ files: [] });
      if (args[1] === 'volume' && args.includes('list'))
        return JSON.stringify({
          volumes: [{ id: 'data', name: 'data', mountPath: '/app/data', serviceName: 'gemwright' }]
        });
      if (args[1] === 'tcp-proxy')
        return JSON.stringify({ proxies: [{ applicationPort: 2593, endpoint: 'shard:2593' }] });
      if (args[1] === 'deployment') return JSON.stringify([{ id: 'deployment', status: 'SUCCESS' }]);
      if (args[1] === 'up') return JSON.stringify({ deploymentId: 'deployment' });
      return '{}';
    })
  ];
  try {
    await deploy({ files: assets, client: true }, directory);
    expect(web.deployClient).toHaveBeenCalledTimes(1);
    expect(web.deployClient).toHaveBeenCalledWith(directory, assets, [
      expect.objectContaining({ path: 'map0.mul', bytes: 3 })
    ]);
    expect(deployments.servuo.packageFiles).toHaveBeenCalledWith(directory, assets);
    expect(calls.some((args) => args[1] === 'up')).toBe(true);
    await deploy({ files: assets }, directory);
    expect(web.deployClient).toHaveBeenCalledTimes(1);
    expect(calls.filter((args) => args[1] === 'up')).toHaveLength(2);
  } finally {
    for (const mock of mocks) mock.mockRestore();
  }
});

test('web deployment uses the existing project and uploads only manifest-listed assets', async () => {
  const { spyOn } = await import('bun:test');
  const { mkdir, readdir, stat, writeFile } = await import('node:fs/promises');
  const { deployClient } = await import('../src/client-deploy');
  const process = await import('../src/process');
  const directory = await mkdtemp(join(tmpdir(), 'gemwright-web-deploy-'));
  folders.push(directory);
  const assets = join(directory, 'files');
  await mkdir(assets);
  await mkdir(join(directory, '.gemwright'));
  await writeFile(join(assets, 'map0.mul'), 'map');
  await writeFile(join(assets, 'client.exe'), 'not a web asset');
  await writeFile(join(assets, '.env'), 'private');
  await writeFile(
    join(directory, 'gemwright.json'),
    JSON.stringify({
      name: 'Gemwright',
      id: 'gemwright',
      timezone: 'Europe/London',
      expansion: 'ej',
      emulator: 'servuo'
    })
  );
  await writeFile(
    join(directory, '.gemwright/railway.json'),
    JSON.stringify({
      projectName: 'project',
      project: 'project',
      service: 'server',
      environment: 'production'
    })
  );
  const calls: string[][] = [];
  let polls = 0;
  let failed = false;
  const cli = spyOn(process, 'command').mockImplementation(async (args) => {
    calls.push(args);
    expect(args).toContain('project');
    if (args[1] === 'service')
      return JSON.stringify([
        { id: 'server', name: 'gemwright' },
        { id: 'web', name: 'gemwright-web' }
      ]);
    if (args[1] === 'volume' && args.includes('upload')) {
      expect(polls).toBeGreaterThanOrEqual(2);
      const staged = args[args.indexOf('upload') + 1];
      expect(staged).toBe(join(directory, '.gemwright/webclient-files/gamefiles'));
      expect(args[args.indexOf('upload') + 2]).toBe('/');
      expect((await readdir(staged!)).sort()).toEqual(['manifest.json', 'map0.mul']);
      return '{}';
    }
    if (args[1] === 'volume')
      return JSON.stringify({ volumes: [{ id: 'web-data', serviceName: 'gemwright-web', mountPath: '/app/data' }] });
    if (args[1] === 'domain') return JSON.stringify({ domain: 'https://play.example.com' });
    if (args[1] === 'up') {
      expect(args).toContain('--path-as-root');
      expect(args).toContain('--no-gitignore');
      return 'Uploading...\n' + JSON.stringify({ deploymentId: 'current' });
    }
    if (args[1] === 'deployment') {
      polls++;
      if (failed) return JSON.stringify([{ id: 'current', status: 'FAILED' }]);
      return JSON.stringify([
        polls === 1 ? { id: 'previous', status: 'SUCCESS' } : { id: 'current', status: 'SUCCESS' }
      ]);
    }
    return '{}';
  });
  const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ready: true }));
  try {
    await deployClient(directory, assets);
    await deployClient(directory, assets);
    expect(polls).toBe(3);
    expect(calls.filter((args) => args.includes('upload'))).toHaveLength(1);
    expect(calls.some((args) => args[1] === 'add')).toBe(false);
    expect(calls.find((args) => args[1] === 'variable')).toContain('UO_HOST=${{gemwright.RAILWAY_PRIVATE_DOMAIN}}');
    await expect(stat(join(directory, '.gemwright/webclient-files'))).rejects.toThrow();
    failed = true;
    await expect(deployClient(directory, assets)).rejects.toThrow('Client deployment failed');
  } finally {
    cli.mockRestore();
    fetch.mockRestore();
  }
}, 15_000);
