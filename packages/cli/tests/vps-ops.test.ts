import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { command } from '@gemwright/deployment/process';

import { vpsRestoreScript } from '../src/vps-ops';

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test('the restore script places each upload through its own service and restarts only those', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gemwright-restore-script-'));
  folders.push(root);
  await mkdir(join(root, 'bin'));
  await writeFile(
    join(root, 'bin/docker'),
    `#!/bin/sh\n[ "$1" = info ] && exit 0\necho "$*" >> ${join(root, 'calls')}\n`,
    {
      mode: 0o755
    }
  );
  await command(['sh', '-c', `PATH=${join(root, 'bin')}:$PATH\n${vpsRestoreScript(root, ['server', 'ai'])}`], root);
  const calls = (await readFile(join(root, 'calls'), 'utf8')).trim().split('\n');
  expect(calls[0]).toContain('/.restore-server.tar.gz:/upload.tar.gz:ro --entrypoint sh server');
  expect(calls[1]).toContain('/.restore-ai.tar.gz:/upload.tar.gz:ro --entrypoint sh ai');
  expect(calls[2]).toBe('compose -f compose.json restart server ai');
});
