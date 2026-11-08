import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

// The start script's restore step alone, pointed at a scratch folder instead of /app/data.
test('a restored retired list replaces the current one with the database', async () => {
  const data = await mkdtemp(join(tmpdir(), 'gemwright-ai-start-'));
  folders.push(data);
  await mkdir(join(data, 'restore'));
  await writeFile(join(data, 'residents.sqlite'), 'current');
  await writeFile(join(data, 'retired.json'), '["old"]');
  await writeFile(join(data, 'restore/residents.sqlite'), 'restored');
  await writeFile(join(data, 'restore/retired.json'), '["restored"]');
  const script = await readFile(join(import.meta.dir, '../start.sh'), 'utf8');
  const restore = script.slice(
    script.indexOf('if [ -e /app/data/restore/residents.sqlite ]'),
    script.indexOf('\nfi\n') + 4
  );
  const child = Bun.spawn(['sh', '-c', `set -eu\n${restore.replaceAll('/app/data', data)}`], {
    stdout: 'ignore',
    stderr: 'pipe'
  });
  expect(await child.exited).toBe(0);
  expect(await readFile(join(data, 'residents.sqlite'), 'utf8')).toBe('restored');
  expect(await readFile(join(data, 'retired.json'), 'utf8')).toBe('["restored"]');
});
