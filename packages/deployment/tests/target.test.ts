import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { command } from '../src/process';
import { pull } from '../src/pull';
import { resolveTarget, vpsRunner } from '../src/target';

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function shard(files: string[] = []) {
  const directory = await mkdtemp(join(tmpdir(), 'gemwright-target-'));
  folders.push(directory);
  for (const file of files) {
    await mkdir(join(directory, '.gemwright', file, '..'), { recursive: true });
    await writeFile(join(directory, '.gemwright', file), '{}');
  }
  return directory;
}
const vps = { publicHost: '203.0.113.1' };

test('the named target wins, then the saved one, then the only deployment', async () => {
  const both = await shard(['railway.json', 'local/state.json']);
  expect(() => resolveTarget(both, {})).toThrow('local, railway');
  expect(resolveTarget(both, { target: 'local' })).toBe('local');
  expect(resolveTarget(both, { target: 'local' }, 'railway')).toBe('railway');
  expect(() => resolveTarget(both, {}, 'cloud')).toThrow('local, railway or vps');
  expect(resolveTarget(await shard(), { vps })).toBe('vps');
  expect(resolveTarget(await shard(), {})).toBeUndefined();
});

test('an on-box VPS deployment pulls its saves into the shared pull layout', async () => {
  const directory = await shard();
  const data = join(directory, '.gemwright/vps/data/server');
  await mkdir(join(data, 'Saves'), { recursive: true });
  await mkdir(join(data, 'Logs'), { recursive: true });
  await writeFile(join(data, 'Saves/world.bin'), 'world');
  const out = join(directory, 'out');
  await pull({ server: true, output: out, vps: vpsRunner(directory, { id: 'test', vps }) }, directory);
  // The same layout as Railway and local pulls, so restore and the analyzer read it alike.
  expect(await readdir(out)).not.toContain('server.tar.gz');
  expect(await Bun.file(join(out, 'server/Saves/world.bin')).text()).toBe('world');
});

test('an SSH VPS deployment runs commands over SSH at its port', () => {
  const runner = vpsRunner('/unused', { id: 'test', vps: { ...vps, ssh: 'my-vps', port: 2222 } });
  expect(runner.root).toBe('gemwright/test');
  expect(runner.shell('true')).toEqual(['ssh', '-p', '2222', 'my-vps', 'true']);
});

test('Compose commands for a VPS can run one after another in one shell', async () => {
  const home = await shard();
  await mkdir(join(home, 'srv/shard'), { recursive: true });
  await mkdir(join(home, 'bin'));
  await writeFile(join(home, 'bin/docker'), '#!/bin/sh\n[ "$1" = info ] && exit 0\necho "$(basename "$(pwd)") $*"\n', {
    mode: 0o755
  });
  const { compose } = vpsRunner(home, { id: 'test', vps: { ...vps, ssh: 'my-vps', path: 'srv/shard' } });
  const script = `PATH=${join(home, 'bin')}:$PATH; cd ${home} && ${compose?.(['ps'])} && ${compose?.(['logs'])}`;
  const output = await command(['sh', '-c', script], home);
  expect(output.split('\n')).toEqual(['shard compose -f compose.json ps', 'shard compose -f compose.json logs']);
});
