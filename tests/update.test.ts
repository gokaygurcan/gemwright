import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkForUpdate, newerVersion } from '../src/update';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function cachePath() {
  const directory = await mkdtemp(join(tmpdir(), 'gemwright-update-'));
  directories.push(directory);
  return join(directory, 'update.json');
}

test('compares stable versions numerically and rejects invalid metadata', () => {
  expect(newerVersion('0.1.4', '0.2.2')).toBe(true);
  expect(newerVersion('0.9.0', '0.10.0')).toBe(true);
  for (const latest of ['0.2.2', '0.1.9', '0.3.0-next.1', '\u001b[31m0.3.0']) {
    expect(newerVersion('0.2.2', latest)).toBe(false);
  }
  expect(newerVersion('0.3.0-next.1', '0.2.2')).toBe(false);
});

test('shows the update command and reuses the daily cache', async () => {
  const path = await cachePath();
  let requests = 0;
  const options = {
    current: '0.1.4',
    cachePath: path,
    now: 1000,
    fetchLatest: async () => {
      requests++;
      return '0.2.2';
    }
  };
  expect(await checkForUpdate(options)).toContain('npm install --global gemwright@latest');
  expect(await checkForUpdate({ ...options, now: 2000 })).toContain('0.1.4 → 0.2.2');
  expect(requests).toBe(1);
  await checkForUpdate({ ...options, now: 1000 + 86400000 });
  expect(requests).toBe(2);
});

test('network failures are silent and cached', async () => {
  const path = await cachePath();
  let requests = 0;
  const options = {
    current: '0.2.2',
    cachePath: path,
    fetchLatest: async (): Promise<string> => {
      requests++;
      throw new Error('offline');
    }
  };
  expect(await checkForUpdate(options)).toBeUndefined();
  expect(await checkForUpdate(options)).toBeUndefined();
  expect(requests).toBe(1);
  expect(JSON.parse(await readFile(path, 'utf8')).checkedAt).toBeNumber();
});

test('recovers from malformed cache and ignores cache write failures', async () => {
  const path = await cachePath();
  await writeFile(path, '{');
  const options = { current: '0.1.4', cachePath: path, fetchLatest: async () => '0.2.2' };
  expect(await checkForUpdate(options)).toContain('0.2.2');
  expect(await checkForUpdate({ ...options, cachePath: join(path, 'impossible') })).toContain('0.2.2');
});
