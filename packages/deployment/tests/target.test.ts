import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { command } from '../src/process';
import { pull, toFile } from '../src/pull';
import { pullFrom, resolveTarget, vpsRunner } from '../src/target';

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

test('a pull reads from the saved target, not always Railway', async () => {
  const both = await shard(['railway.json']);
  expect(pullFrom(both, { id: 'test', target: 'vps', vps: { ...vps, ssh: 'host' } }).vps?.root).toBe('gemwright/test');
  expect(pullFrom(both, { id: 'test', target: 'railway', vps }).vps).toBeUndefined();
  const local = await shard(['local/state.json']);
  expect(() => pullFrom(local, { id: 'test' })).toThrow('locally');
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

// A copy cut short leaves nothing behind: a half-written database must never look like a pulled one.
test('an interrupted copy leaves no file', async () => {
  const file = join(await shard(), 'residents.sqlite');
  await expect(toFile(['sh', '-c', 'head -c 100000 /dev/zero; exit 1'], file)).rejects.toThrow();
  expect(existsSync(file)).toBe(false);
});

// A stream through the AI service ends early, without an error, when the service is killed meanwhile:
// a database that arrives short is no pulled database.
test('a database that arrives incomplete fails its part of the pull and leaves no file', async () => {
  const directory = await shard();
  await mkdir(join(directory, '.gemwright/vps'), { recursive: true });
  await writeFile(join(directory, '.gemwright/vps/state.json'), JSON.stringify({ ai: true }));
  await mkdir(join(directory, 'bin'));
  await writeFile(
    join(directory, 'bin/docker'),
    `#!/bin/sh
[ "$1" = info ] && exit 0
case "$*" in
  *" stat "*) echo 2000 ;;
  *" cat "*) head -c 1000 /dev/zero ;;
esac
exit 0
`,
    { mode: 0o755 }
  );
  const path = process.env.PATH;
  process.env.PATH = `${join(directory, 'bin')}:${path}`;
  try {
    const out = join(directory, 'out');
    await pull({ ai: true, output: out, vps: vpsRunner(directory, { id: 'test', vps }) }, directory);
    expect(existsSync(join(out, 'ai/history.sqlite'))).toBe(false);
    const manifest = await Bun.file(join(out, 'manifest.json')).json();
    expect(JSON.stringify(manifest)).toContain('history.sqlite arrived incomplete: 1000 of 2000 bytes');
  } finally {
    process.env.PATH = path;
  }
});
