import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { runCommand } from '../src/process';

test('--version prints only the package version from outside the project', async () => {
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const result = await runCommand(
    [process.execPath, fileURLToPath(new URL('../src/index.ts', import.meta.url)), '--version'],
    tmpdir()
  );
  expect(result).toEqual({ code: 0, stdout: metadata.version, stderr: '' });
});
