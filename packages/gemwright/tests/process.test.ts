import { expect, test } from 'bun:test';

import { command, isAvailable, runCommand } from '../src/process';

test('subprocess capture drains both streams and preserves failure status', async () => {
  const result = await runCommand([
    process.execPath,
    '-e',
    `process.stdout.write('é'.repeat(100000)); process.stderr.write('failure'); process.exitCode = 7;`
  ]);
  expect(result.code).toBe(7);
  expect(result.stdout).toBe('é'.repeat(100000));
  expect(result.stderr).toBe('failure');
  await expect(
    command([process.execPath, '-e', `console.error('reason'); process.exitCode = 2`], process.cwd())
  ).rejects.toThrow('reason');
});

test('missing executables return false for availability and reject execution', async () => {
  const missing = 'gemwright-test-executable-that-does-not-exist';
  expect(await isAvailable(missing)).toBe(false);
  await expect(runCommand([missing])).rejects.toMatchObject({ code: 'ENOENT' });
});
