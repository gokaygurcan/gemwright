import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { stageImage } from '../src/assets';

test('the AI deployment context contains the network dependency and all workspace manifests', async () => {
  const context = await mkdtemp(join(tmpdir(), 'gemwright-network-context-'));
  try {
    await stageImage('ai', context);
    expect((await stat(join(context, 'packages/network/src/session.ts'))).isFile()).toBe(true);
    expect((await stat(join(context, 'packages/common/src/huffman.ts'))).isFile()).toBe(true);
    const ai = JSON.parse(await readFile(join(context, 'packages/ai/package.json'), 'utf8'));
    expect(ai.dependencies['@gemwright/network']).toBe('workspace:*');
    const network = JSON.parse(await readFile(join(context, 'packages/network/package.json'), 'utf8'));
    expect(network.name).toBe('@gemwright/network');
    expect(await readFile(join(context, 'bun.lock'), 'utf8')).toContain('"packages/network"');
  } finally {
    await rm(context, { recursive: true, force: true });
  }
});
