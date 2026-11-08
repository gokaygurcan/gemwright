import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createConfig } from '@gemwright/server/config';

import { recordedParts } from '../src/shard-deploy';

const entry = resolve(import.meta.dir, '../src/index.ts');
const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function folder(config?: Record<string, unknown>) {
  const directory = await mkdtemp(join(tmpdir(), 'gemwright-shard-'));
  folders.push(directory);
  if (config)
    await writeFile(
      join(directory, 'gemwright.json'),
      JSON.stringify({ ...createConfig({ client: { version: '7.0.45.1' } }), ...config })
    );
  return directory;
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

test('shard commands need gemwright.json in this directory', async () => {
  const result = await run(['shard', 'status'], await folder());
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('Error: No gemwright.json found.');
});

test('old commands and --local name their replacement', async () => {
  const directory = await folder({});
  expect((await run(['deploy'], directory)).stderr).toContain('gemwright deploy is now gemwright shard deploy.');
  expect((await run(['shard', 'pull', '--local'], directory)).stderr).toContain('--local is now --target local.');
});

test('each command rejects flags it does not use, and has its own help', async () => {
  const directory = await folder({});
  const rejected = await run(['shard', 'logs', '--backups'], directory);
  expect(rejected.code).toBe(1);
  expect(rejected.stderr).toContain('gemwright shard logs --help');
  const help = await run(['shard', 'pull', '--help'], directory);
  expect(help.stdout).toContain('--backups');
  expect(help.stdout).not.toContain('--follow');
  expect((await run(['shard', 'logs', '-h'], directory)).stdout).toContain('-f, --follow');
  const deploy = (await run(['shard', 'deploy', '--help'], directory)).stdout;
  for (const section of [
    'Component selection:',
    'Target:',
    'General:',
    'AI deployment:',
    'Local deployment:',
    'VPS deployment:'
  ])
    expect(deploy).toContain(section);
  expect((await run(['shard', 'start', '--help'], directory)).stdout).not.toContain('--ssh');
  for (const args of [['help'], ['help', 'shard'], ['shard', 'help'], ['shard', 'help', 'pull'], ['help', 'init']])
    expect((await run(args, directory)).code).toBe(0);
  expect((await run(['shard', 'help', 'pull'], directory)).stdout).toContain('--backups');
  expect((await run(['-V'], directory)).stdout).toMatch(/^\d+\.\d+\.\d+/);
  const misplaced = await run(['shard', 'deploy', '--target', 'railway', '--ssh', 'my-vps'], directory);
  expect(misplaced.stderr).toContain('--ssh does not apply to --target railway');
  const noTarget = await run(['shard', 'deploy'], directory);
  expect(noTarget.stderr).toContain('pass --target local, railway or vps');
});

test('a bare deploy redeploys the components already recorded for the target', async () => {
  const directory = await folder({});
  await mkdir(join(directory, '.gemwright/local'), { recursive: true });
  await writeFile(
    join(directory, '.gemwright/local/state.json'),
    JSON.stringify({ emulator: 'servuo', parts: ['server', 'ai'] })
  );
  await writeFile(join(directory, '.gemwright/webclient.json'), '{}');
  expect(await recordedParts(directory, 'local')).toEqual(['server', 'ai']);
  expect(await recordedParts(directory, 'railway')).toEqual(['client']);
  expect(await recordedParts(directory, 'vps')).toEqual([]);
});
