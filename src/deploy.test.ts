import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureRailway, type RailwayCommand } from './deploy';

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
