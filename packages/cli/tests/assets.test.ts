import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { stageImage } from '../src/assets';

test('contained AI context includes bundled workers and owned assets without workspace dependencies', async () => {
  const context = await mkdtemp(join(tmpdir(), 'gemwright-ai-context-'));
  try {
    await stageImage('ai', context);
    for (const file of [
      'dist/serve.js',
      'dist/persistence-worker.js',
      'dist/path-worker.js',
      'dist/life-journal-worker.js',
      'world/world.json',
      'Dockerfile'
    ])
      expect((await stat(join(context, file))).isFile()).toBe(true);
    expect(await Bun.file(join(context, 'bun.lock')).exists()).toBe(false);
    expect(await Bun.file(join(context, 'packages/network/package.json')).exists()).toBe(false);
    expect(await readFile(join(context, 'Dockerfile'), 'utf8')).not.toContain('bun install');
  } finally {
    await rm(context, { recursive: true, force: true });
  }
});
