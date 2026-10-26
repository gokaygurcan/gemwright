import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { configFilename, createConfig } from '../src/config';
import { restore } from '../src/restore';

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function shardWithPull() {
  const directory = await mkdtemp(join(tmpdir(), 'gemwright-restore-'));
  folders.push(directory);
  await writeFile(join(directory, configFilename), JSON.stringify(createConfig({})));
  await mkdir(join(directory, '.gemwright'), { recursive: true });
  await writeFile(
    join(directory, '.gemwright/railway.json'),
    JSON.stringify({ project: 'project', environment: 'production', service: 'shard', volume: 'shard-volume' })
  );
  await writeFile(join(directory, '.gemwright/ai.json'), JSON.stringify({ service: 'shard-ai', volume: 'ai-volume' }));
  const pull = join(directory, '.gemwright/pulls/2026-10-24T12-00-00-000Z');
  await mkdir(join(pull, 'server/Saves/Mobiles'), { recursive: true });
  await mkdir(join(pull, 'ai'), { recursive: true });
  await writeFile(join(pull, 'ai/residents.sqlite'), '');
  return { directory, pull };
}

test('restore uploads every part before restarting anything', async () => {
  const { directory, pull } = await shardWithPull();
  const calls: string[][] = [];
  await restore({ yes: true }, directory, async (args) => {
    calls.push(args);
    return '{}';
  });
  const steps = calls.map((args) => (args[0] === 'restart' ? `restart ${args.at(-3)}` : `upload ${args.at(-3)}`));
  expect(steps).toEqual([
    'upload /restore/Saves',
    'upload /restore/residents.sqlite',
    'restart shard',
    'restart shard-ai'
  ]);
  expect(calls[0]).toContain(join(pull, 'server/Saves'));
  expect(calls[0]).toContain('shard-volume');
  expect(calls[1]).toContain('ai-volume');
});

test('a failed upload restarts nothing, and an unconfirmed restore never runs', async () => {
  const { directory } = await shardWithPull();
  const calls: string[][] = [];
  await expect(
    restore({ yes: true, server: true }, directory, async (args) => {
      calls.push(args);
      throw new Error('upload failed');
    })
  ).rejects.toThrow('upload failed');
  expect(calls.some((args) => args[0] === 'restart')).toBe(false);
  // Without --yes outside a terminal, nothing is sent at all.
  calls.length = 0;
  const record = async (args: string[]) => {
    calls.push(args);
    return '{}';
  };
  await expect(restore({}, directory, record)).rejects.toThrow('--yes');
  expect(calls).toEqual([]);
});
