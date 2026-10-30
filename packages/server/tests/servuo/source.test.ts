import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyServuoCompatibility, resolveLatestServuoSource, servuoSource } from '../../src/emulators/servuo/source';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function temporaryFolder() {
  const directory = await mkdtemp(join(tmpdir(), 'gemwright-wrapper-'));
  directories.push(directory);
  return directory;
}

test('patch refuses a different source revision without changing files', async () => {
  const directory = await temporaryFolder();
  const child = Bun.spawn(['git', 'init', '--quiet', directory], { stdout: 'pipe', stderr: 'pipe' });
  expect(await child.exited).toBe(0);
  await expect(applyServuoCompatibility(directory, 'a'.repeat(40))).rejects.toThrow('requires revision');
  expect(await Bun.file(join(directory, 'Server', 'HostingOptions.cs')).exists()).toBe(false);
});

test('start script turns SIGTERM into a shutdown request and waits for the server', async () => {
  const directory = await temporaryFolder();
  const bin = join(directory, 'bin');
  await mkdir(bin);
  await writeFile(
    join(bin, 'mono'),
    `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--shutdown-file" ]; then shift; marker=$1; fi
  shift
done
printf '%s' "$marker" > marker-path
: > ready
while [ ! -f "$marker" ]; do sleep 0.05; done
sleep 0.1
: > saved
exit 42
`
  );
  await chmod(join(bin, 'mono'), 0o755);
  const wrapper = fileURLToPath(new URL('../../templates/servuo/start.sh', import.meta.url));
  const child = Bun.spawn(['sh', wrapper], {
    cwd: directory,
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` },
    stdout: 'pipe',
    stderr: 'pipe'
  });
  try {
    for (let attempts = 0; !(await Bun.file(join(directory, 'ready')).exists()); attempts++) {
      if (attempts > 100) throw new Error('Test server failed to start');
      await Bun.sleep(10);
    }
    child.kill('SIGTERM');
    expect(await child.exited).toBe(42);
    expect(await Bun.file(join(directory, 'saved')).exists()).toBe(true);
    const marker = await readFile(join(directory, 'marker-path'), 'utf8');
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally {
    child.kill();
    await child.exited;
  }
}, 5000);

test('latest source resolution uses the current branch response on each call', async () => {
  let calls = 0;
  const fetcher = async (url: string) => {
    expect(url).toBe('https://api.github.com/repos/ServUO/ServUO/commits/pub57');
    calls++;
    return Response.json({ sha: String(calls).repeat(40) });
  };
  expect(await resolveLatestServuoSource(fetcher)).toEqual({
    repository: servuoSource.repository,
    ref: 'pub57',
    revision: '1'.repeat(40)
  });
  expect((await resolveLatestServuoSource(fetcher)).revision).toBe('2'.repeat(40));
});

test('source resolution reports network, HTTP and malformed-response failures', async () => {
  await expect(
    resolveLatestServuoSource(async () => {
      throw new Error('offline');
    })
  ).rejects.toThrow('Could not resolve the latest');
  await expect(resolveLatestServuoSource(async () => new Response('', { status: 403 }))).rejects.toThrow('HTTP 403');
  await expect(resolveLatestServuoSource(async () => Response.json({ sha: 'bad' }))).rejects.toThrow('invalid commit');
});

test('a completed shutdown exits cleanly after ServUO terminates itself', async () => {
  const directory = await temporaryFolder();
  const bin = join(directory, 'bin');
  await mkdir(bin);
  await writeFile(
    join(bin, 'mono'),
    `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--shutdown-file" ]; then shift; marker=$1; fi
  shift
done
: > ready
while [ ! -f "$marker" ]; do sleep 0.05; done
rm "$marker"
kill -KILL $$
`
  );
  await chmod(join(bin, 'mono'), 0o755);
  const wrapper = fileURLToPath(new URL('../../templates/servuo/start.sh', import.meta.url));
  const child = Bun.spawn(['sh', wrapper], {
    cwd: directory,
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` },
    stdout: 'pipe',
    stderr: 'pipe'
  });
  try {
    for (let attempts = 0; !(await Bun.file(join(directory, 'ready')).exists()); attempts++) {
      if (attempts > 100) throw new Error('Test server failed to start');
      await Bun.sleep(10);
    }
    child.kill('SIGTERM');
    expect(await child.exited).toBe(0);
  } finally {
    child.kill();
    await child.exited;
  }
}, 5000);
